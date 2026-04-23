# -*- coding: utf-8 -*-
"""阿里云资源优化建议工具 — 基于分析数据给出具体的降本建议。

P0: 闲置检测（ECS/RDS/SLB）+ 智能顾问
P1: 利用率报告 + Rightsizing + 老代检测 + 定时关停候选
P2: 综合节省报告

所有检测函数支持 strategy 参数，读取 finops_policy 策略阈值。
optimizer 本身不执行 WRITE 操作，仅输出建议。
"""

import asyncio
import json
import logging
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

from alibabacloud_tea_openapi.models import Config
from alibabacloud_ecs20140526.client import Client as EcsClient
from alibabacloud_ecs20140526 import models as ecs_models
from alibabacloud_rds20140815.client import Client as RdsClient
from alibabacloud_rds20140815 import models as rds_models
from alibabacloud_slb20140515.client import Client as SlbClient
from alibabacloud_slb20140515 import models as slb_models
from alibabacloud_cms20190101.client import Client as CmsClient
from alibabacloud_cms20190101 import models as cms_models
from alibabacloud_r_kvstore20150101.client import Client as RedisClient
from alibabacloud_r_kvstore20150101 import models as redis_models
from alibabacloud_vpc20160428.client import Client as VpcClient
from alibabacloud_vpc20160428 import models as vpc_models
from alibabacloud_dds20151201.client import Client as MongoClient
from alibabacloud_dds20151201 import models as mongo_models
from alibabacloud_bssopenapi20171214.client import Client as BssClient
from alibabacloud_bssopenapi20171214 import models as bss_models
from alibabacloud_nas20170626.client import Client as NasClient
from alibabacloud_nas20170626 import models as nas_models
import sys
from pathlib import Path
# 添加 _common 目录到 Python 路径
_common_path = Path(__file__).parent.parent.parent / "_common"
if str(_common_path) not in sys.path:
    sys.path.insert(0, str(_common_path))
# 添加 scripts 目录到 Python 路径（解决相对导入问题）
_scripts_path = Path(__file__).parent
if str(_scripts_path) not in sys.path:
    sys.path.insert(0, str(_scripts_path))
from credential import get_credential, get_ak_sk



logger = logging.getLogger(__name__)


# =============================================================================
# 策略阈值加载
# =============================================================================

_POLICY_DIR = Path.home() / ".copaw" / "data"
_POLICY_FILE = _POLICY_DIR / "finops_policy.json"

_BUILTIN_STRATEGIES: dict[str, dict] = {
    "conservative": {
        "ecs_idle_cpu_percent": 2.0, "ecs_idle_duration_days": 14,
        "rds_idle_cpu_percent": 2.0, "rds_idle_conn_threshold": 0, "rds_idle_duration_days": 14,
        "slb_idle_duration_days": 14,
        "target_environments": ["dev", "test"],
        "automation_level": "report_only",
    },
    "moderate": {
        "ecs_idle_cpu_percent": 5.0, "ecs_idle_duration_days": 7,
        "rds_idle_cpu_percent": 3.0, "rds_idle_conn_threshold": 0, "rds_idle_duration_days": 7,
        "slb_idle_duration_days": 7,
        "target_environments": ["dev", "test", "staging"],
        "automation_level": "recommend",
    },
    "aggressive": {
        "ecs_idle_cpu_percent": 10.0, "ecs_idle_duration_days": 3,
        "rds_idle_cpu_percent": 5.0, "rds_idle_conn_threshold": 2, "rds_idle_duration_days": 3,
        "slb_idle_duration_days": 3,
        "target_environments": ["dev", "test", "staging", "production"],
        "automation_level": "auto_with_approval",
    },
}


def _load_thresholds(strategy: str = "") -> dict:
    """读取策略阈值。优先级：显式参数 > policy 文件 > 默认 moderate。"""
    overrides: dict = {}
    if not strategy:
        try:
            data = json.loads(_POLICY_FILE.read_text(encoding="utf-8"))
            strategy = data.get("active_strategy", "moderate")
            overrides = data.get("custom_overrides", {})
        except (FileNotFoundError, json.JSONDecodeError):
            strategy = "moderate"
    base = _BUILTIN_STRATEGIES.get(strategy, _BUILTIN_STRATEGIES["moderate"]).copy()
    base.update(overrides)
    base["name"] = strategy
    return base


# =============================================================================
# 内部辅助函数
# =============================================================================


def _get_ak_sk(credential) -> tuple[str, str]:
    if hasattr(credential, "access_key_id"):
        return credential.access_key_id, credential.access_key_secret
    return credential["access_key_id"], credential["access_key_secret"]


def _is_intl_region(region: str) -> bool:
    """判断是否为国际站区域（非中国大陆）"""
    cn_regions = [
        "cn-hangzhou", "cn-shanghai", "cn-beijing", "cn-shenzhen",
        "cn-qingdao", "cn-zhangjiakou", "cn-huhehaote", "cn-wulanchabu",
        "cn-chengdu", "cn-hongkong", "cn-heyuan", "cn-guangzhou",
        "cn-fuzhou", "cn-nanjing",
    ]
    return region not in cn_regions


def _build_client(credential, service: str, region: str = "cn-hangzhou"):
    ak, sk = _get_ak_sk(credential)
    
    # BSS 端点：固定使用国内站（绝大多数用户是国内站账号）
    # 即使资源在海外区域，国内站账号的 BSS 服务仍在国内站
    bss_endpoint = "business.aliyuncs.com"
    
    service_map = {
        "ecs": ("ecs.{region}.aliyuncs.com", EcsClient),
        "rds": ("rds.aliyuncs.com", RdsClient),  # RDS 使用全局 endpoint
        "slb": ("slb.{region}.aliyuncs.com", SlbClient),
        "cms": ("metrics.{region}.aliyuncs.com", CmsClient),
        "redis": ("r-kvstore.aliyuncs.com", RedisClient),  # Redis 使用全局 endpoint
        "vpc": ("vpc.{region}.aliyuncs.com", VpcClient),
        "mongodb": ("mongodb.aliyuncs.com", MongoClient),  # MongoDB 使用全局 endpoint
        "bss": (bss_endpoint, BssClient),  # BSS 计费服务（跟随账号站点，非资源区域）
        "nas": ("nas.{region}.aliyuncs.com", NasClient),
    }
    endpoint_tpl, client_cls = service_map[service]
    config = Config(
        access_key_id=ak,
        access_key_secret=sk,
        endpoint=endpoint_tpl.format(region=region),
        region_id=region,
    )
    return client_cls(config)


def _safe_float(value) -> float:
    try:
        return float(value) if value is not None else 0.0
    except (ValueError, TypeError):
        return 0.0


def _safe_int(value) -> int:
    try:
        return int(value) if value is not None else 0
    except (ValueError, TypeError):
        return 0


def _validate_days(days, default: int = 7, min_days: int = 1, max_days: int = 90) -> int:
    """校验并转换 days 参数。
    
    处理空字符串、None、非数字等无效输入。
    
    Args:
        days: 待校验的天数值
        default: 默认值
        min_days: 最小天数
        max_days: 最大天数
    
    Returns:
        有效的天数整数
    """
    if days is None or days == "" or days == 0:
        return default
    try:
        days_int = int(days)
        return max(min_days, min(days_int, max_days))
    except (ValueError, TypeError):
        return default


async def _get_cms_metric_avg(
    cms_client: CmsClient,
    namespace: str,
    metric_name: str,
    dimensions: list[dict],
    period: int = 86400,
    days: int = 7,
) -> float:
    """查询 CloudMonitor 指标近 N 天的平均值。"""
    now = datetime.now(timezone.utc)
    start_ts = int((now - timedelta(days=days)).timestamp() * 1000)
    end_ts = int(now.timestamp() * 1000)
    try:
        req = cms_models.DescribeMetricLastRequest(
            namespace=namespace,
            metric_name=metric_name,
            dimensions=json.dumps(dimensions),
            period=str(period),
            start_time=str(start_ts),
            end_time=str(end_ts),
        )
        resp = await asyncio.to_thread(cms_client.describe_metric_last, req)
        body = resp.body
        if body.datapoints:
            points = json.loads(body.datapoints)
            avgs = [_safe_float(p.get("Average", p.get("average", 0))) for p in points]
            return sum(avgs) / len(avgs) if avgs else 0.0
    except Exception as e:
        logger.warning("CMS query %s/%s failed: %s", namespace, metric_name, e)
    return 0.0


async def _get_cms_metric_percentile(
    cms_client: CmsClient,
    namespace: str,
    metric_name: str,
    dimensions: list[dict],
    period: int = 86400,
    days: int = 7,
    percentile: float = 0.95,
) -> float:
    """查询 CloudMonitor 指标近 N 天数据并计算指定百分位数。"""
    now = datetime.now(timezone.utc)
    start_ts = int((now - timedelta(days=days)).timestamp() * 1000)
    end_ts = int(now.timestamp() * 1000)
    try:
        req = cms_models.DescribeMetricLastRequest(
            namespace=namespace,
            metric_name=metric_name,
            dimensions=json.dumps(dimensions),
            period=str(period),
            start_time=str(start_ts),
            end_time=str(end_ts),
        )
        resp = await asyncio.to_thread(cms_client.describe_metric_last, req)
        body = resp.body
        if body.datapoints:
            points = json.loads(body.datapoints)
            values = sorted(_safe_float(p.get("Average", p.get("average", 0))) for p in points)
            if values:
                idx = min(int(len(values) * percentile), len(values) - 1)
                return values[idx]
    except Exception as e:
        logger.warning("CMS percentile query %s/%s failed: %s", namespace, metric_name, e)
    return 0.0


# ECS 月费估算参考（元/月，按量 cn-hangzhou）
_ECS_PRICE_ESTIMATE: dict[str, float] = {
    "ecs.g6.large": 378, "ecs.g6.xlarge": 756, "ecs.g6.2xlarge": 1512,
    "ecs.g7.large": 420, "ecs.g7.xlarge": 840, "ecs.g7.2xlarge": 1680,
    "ecs.c6.large": 300, "ecs.c6.xlarge": 600, "ecs.c6.2xlarge": 1200,
    "ecs.c7.large": 336, "ecs.c7.xlarge": 672, "ecs.c7.2xlarge": 1344,
    "ecs.r6.large": 456, "ecs.r6.xlarge": 912, "ecs.r6.2xlarge": 1824,
}

# 老代实例规格前缀
OLD_GENERATION_PREFIXES = [
    "ecs.t1.", "ecs.s1.", "ecs.s2.", "ecs.s3.",
    "ecs.m1.", "ecs.m2.", "ecs.c1.", "ecs.c2.",
    "ecs.n1.", "ecs.n2.", "ecs.e3.",
    "ecs.sn1.", "ecs.sn2.", "ecs.se1.",
]


def _estimate_monthly_cost(instance_type: str, charge_type: str = "PostPaid") -> float:
    """估算实例月费。"""
    if instance_type in _ECS_PRICE_ESTIMATE:
        cost = _ECS_PRICE_ESTIMATE[instance_type]
        return cost * 0.5 if charge_type == "PrePaid" else cost
    # 根据 CPU 核数粗略估算
    parts = instance_type.split(".")
    if len(parts) >= 3:
        size = parts[-1]
        size_map = {"large": 2, "xlarge": 4, "2xlarge": 8, "4xlarge": 16, "8xlarge": 32}
        cores = size_map.get(size, 2)
        base = 180  # ~180 元/核/月 按量
        return cores * base * (0.5 if charge_type == "PrePaid" else 1.0)
    return 300.0


# =============================================================================
# BSS 询价与账单查询
# =============================================================================


async def _bss_get_payg_price(
    bss_client: BssClient,
    region_id: str,
    instance_type: str,
    product_code: str = "ecs",
) -> float:
    """按量付费询价（返回月费）。
    
    使用 BSS OpenAPI GetPayAsYouGoPrice 获取真实价格。
    API 返回小时价，换算为月价：月价 = 小时价 × 24 × 30
    """
    try:
        # ECS 询价的 Module 参数，必须指定 price_type
        module_list = [
            bss_models.GetPayAsYouGoPriceRequestModuleList(
                module_code="InstanceType",
                price_type="Hour",  # 必填！否则返回 MissingParameter 错误
                config=f"InstanceType:{instance_type},Region:{region_id}",
            )
        ]
        req = bss_models.GetPayAsYouGoPriceRequest(
            product_code=product_code,
            subscription_type="PayAsYouGo",
            region=region_id,
            module_list=module_list,
        )
        resp = await asyncio.to_thread(bss_client.get_pay_as_you_go_price, req)
        body = resp.body
        
        if body.data and body.data.module_details and body.data.module_details.module_detail:
            for detail in body.data.module_details.module_detail:
                # 优先取优惠价，否则取原价
                invoice_discount = _safe_float(detail.invoice_discount)
                if invoice_discount > 0:
                    hour_price = _safe_float(detail.cost_after_discount)
                else:
                    hour_price = _safe_float(detail.original_cost)
                # 小时价转月价
                return hour_price * 24 * 30
        # API 返回空数据
        print(f"    [BSS询价详情] {instance_type} 在 {region_id} 返回空数据（可能不支持该区域/规格）")
        logger.warning("BSS GetPayAsYouGoPrice empty response for %s in %s", instance_type, region_id)
    except Exception as e:
        error_msg = str(e)
        # 判断是否是新规格不在定价库中
        if "PRICING_PLAN_RESULT_NOT_FOUND" in error_msg:
            print(f"    [BSS询价详情] {instance_type} 不在 BSS 定价库中（新规格），回退到 OpenAPI")
        else:
            print(f"    [BSS询价详情] {instance_type} 在 {region_id} 异常: {e}")
        logger.warning("BSS GetPayAsYouGoPrice failed for %s: %s", instance_type, e)
    return 0.0


async def _bss_get_subscription_price(
    bss_client: BssClient,
    region_id: str,
    instance_type: str,
    product_code: str = "ecs",
    period_months: int = 1,
) -> float:
    """包年包月询价（返回月费）。
    
    使用 BSS OpenAPI GetSubscriptionPrice 获取真实预付费价格。
    """
    try:
        module_list = [
            bss_models.GetSubscriptionPriceRequestModuleList(
                module_code="InstanceType",
                price_type="Month",  # 必填！包年包月使用 Month
                config=f"InstanceType:{instance_type},Region:{region_id}",
            )
        ]
        req = bss_models.GetSubscriptionPriceRequest(
            product_code=product_code,
            subscription_type="Subscription",
            order_type="NewOrder",
            service_period_quantity=period_months,
            service_period_unit="Month",
            quantity=1,
            region=region_id,
            module_list=module_list,
        )
        resp = await asyncio.to_thread(bss_client.get_subscription_price, req)
        body = resp.body
        
        if body.data:
            discount_price = _safe_float(body.data.discount_price)
            if discount_price > 0:
                return _safe_float(body.data.trade_price)
            return _safe_float(body.data.original_price)
    except Exception as e:
        logger.warning("BSS GetSubscriptionPrice failed for %s: %s", instance_type, e)
    return 0.0


async def _ecs_describe_price(
    ecs_client: EcsClient,
    region_id: str,
    instance_type: str,
    charge_type: str = "PostPaid",
    period: int = 1,
) -> float:
    """使用 ECS OpenAPI DescribePrice 询价。
    
    这是 BSS 询价失败的备选方案，直接调用产品 OpenAPI。
    
    Args:
        ecs_client: ECS 客户端
        region_id: 区域 ID
        instance_type: 实例规格
        charge_type: 计费方式 (PostPaid/PrePaid)
        period: 购买时长（月），仅对 PrePaid 有效
    
    Returns:
        月费（元）
    """
    # 尝试多种系统盘类型，应对不同实例规格的兼容性问题
    disk_categories = ["cloud_essd", "cloud_ssd", "cloud_efficiency", "cloud"]
    
    for disk_category in disk_categories:
        try:
            # 构建询价请求
            if charge_type == "PrePaid":
                req = ecs_models.DescribePriceRequest(
                    region_id=region_id,
                    resource_type="instance",
                    instance_type=instance_type,
                    price_unit="Month",
                    period=period,
                    system_disk=ecs_models.DescribePriceRequestSystemDisk(
                        category=disk_category,
                        size=40,
                    ),
                )
            else:
                # 按量付费，查询小时价后转月价
                req = ecs_models.DescribePriceRequest(
                    region_id=region_id,
                    resource_type="instance",
                    instance_type=instance_type,
                    price_unit="Hour",
                    system_disk=ecs_models.DescribePriceRequestSystemDisk(
                        category=disk_category,
                        size=40,
                    ),
                )
            
            resp = await asyncio.to_thread(ecs_client.describe_price, req)
            body = resp.body
            
            if body.price_info:
                price = body.price_info.price
                if price:
                    # 优先取折扣价
                    discount_price = _safe_float(price.discount_price)
                    if discount_price > 0:
                        final_price = discount_price
                    else:
                        final_price = _safe_float(price.trade_price) or _safe_float(price.original_price)
                    
                    # 按量付费是小时价，转换为月价
                    if charge_type != "PrePaid" and final_price > 0:
                        final_price = final_price * 24 * 30
                    
                    if final_price > 0:
                        return final_price
        except Exception as e:
            error_msg = str(e)
            # 如果是系统盘类型不支持，尝试下一个类型
            if "InvalidSystemDiskCategory" in error_msg:
                continue
            # 其他错误直接跳出
            logger.warning("ECS DescribePrice failed for %s in %s: %s", instance_type, region_id, e)
            break
    
    return 0.0


async def _bss_query_instance_bill(
    bss_client: BssClient,
    instance_id: str,
    product_code: str = "ecs",
    billing_cycle: str = "",
) -> float:
    """查询实例级月度账单（costBefore）。
    
    使用 BSS OpenAPI DescribeInstanceBill 获取历史账单。
    账期自动计算：
    - 每月4号及以后，取上月
    - 每月1~3号，取前2个月（上月账单可能未出）
    """
    # 自动计算账期
    if not billing_cycle:
        now = datetime.now(timezone.utc)
        if now.day >= 4:
            # 取上个月
            target_date = now.replace(day=1) - timedelta(days=1)
        else:
            # 取前2个月
            target_date = (now.replace(day=1) - timedelta(days=1)).replace(day=1) - timedelta(days=1)
        billing_cycle = target_date.strftime("%Y-%m")
    
    total_cost = 0.0
    try:
        next_token = None
        while True:
            req = bss_models.DescribeInstanceBillRequest(
                billing_cycle=billing_cycle,
                product_code=product_code,
                instance_id=instance_id,
                granularity="MONTHLY",
                max_results=300,
                next_token=next_token,
            )
            resp = await asyncio.to_thread(bss_client.describe_instance_bill, req)
            body = resp.body
            
            if body.data and body.data.items:
                for item in body.data.items:
                    # 过滤退款和调账
                    bill_type = item.item or ""
                    if bill_type in ["Refund", "Adjustment"]:
                        continue
                    pretax_amount = _safe_float(item.pretax_amount)
                    if pretax_amount <= 0:
                        continue
                    total_cost += pretax_amount
            
            next_token = body.data.next_token if body.data else None
            if not next_token:
                break
    except Exception as e:
        logger.warning("BSS DescribeInstanceBill failed for %s: %s", instance_id, e)
    
    return total_cost


async def _get_cms_metric_max(
    cms_client: CmsClient,
    namespace: str,
    metric_name: str,
    dimensions: list[dict],
    period: int = 60,
    days: int = 14,
) -> float:
    """查询 CloudMonitor 指标近 N 天的全局最大值。
    
    用于闲置检测：取分钟级数据的 Maximum，再取所有数据点的最大值。
    """
    now = datetime.now(timezone.utc)
    start_ts = int((now - timedelta(days=days)).timestamp() * 1000)
    end_ts = int(now.timestamp() * 1000)
    try:
        req = cms_models.DescribeMetricListRequest(
            namespace=namespace,
            metric_name=metric_name,
            dimensions=json.dumps(dimensions),
            period=str(period),
            start_time=str(start_ts),
            end_time=str(end_ts),
            length="1440",
        )
        resp = await asyncio.to_thread(cms_client.describe_metric_list, req)
        body = resp.body
        if body.datapoints:
            points = json.loads(body.datapoints)
            max_values = [_safe_float(p.get("Maximum", p.get("maximum", 0))) for p in points]
            return max(max_values) if max_values else 0.0
    except Exception as e:
        logger.warning("CMS max query %s/%s failed: %s", namespace, metric_name, e)
    return -1.0  # 返回 -1 表示数据获取失败


# =============================================================================
# 三个优化规则
# =============================================================================


_IDLE_CPU_THRESHOLD = 1.0  # CPU 最大利用率阈值 %
_IDLE_MEM_THRESHOLD = 1.0  # 内存最大利用率阈值 %
_IDLE_DAYS = 14            # 监控回溯天数
_POSTPAID_HOLD_DAYS = 30   # 按量付费持有天数阈值


async def _check_idle_resource(
    cms_client: CmsClient,
    namespace: str,
    cpu_metric: str,
    mem_metric: str,
    instance_id: str,
    cpu_threshold: float = _IDLE_CPU_THRESHOLD,
    mem_threshold: float = _IDLE_MEM_THRESHOLD,
    days: int = _IDLE_DAYS,
) -> tuple[bool, float, float]:
    """闲置资源检测。
    
    判定逻辑：CPU 或内存任一项的 Maximum < 阈值，即判定为闲置。
    
    Returns:
        (is_idle, max_cpu, max_mem)
    """
    max_cpu = await _get_cms_metric_max(
        cms_client, namespace, cpu_metric,
        [{"instanceId": instance_id}], period=60, days=days,
    )
    max_mem = await _get_cms_metric_max(
        cms_client, namespace, mem_metric,
        [{"instanceId": instance_id}], period=60, days=days,
    )
    
    # -1 表示数据获取失败，不判定为闲置
    if max_cpu < 0 or max_mem < 0:
        return False, max_cpu, max_mem
    
    # 任意一项 < 阈值即为闲置
    is_idle = (max_cpu < cpu_threshold) or (max_mem < mem_threshold)
    return is_idle, max_cpu, max_mem


def _check_postpaid_longterm(
    charge_type: str,
    creation_time: str,
    hold_days_threshold: int = _POSTPAID_HOLD_DAYS,
) -> tuple[bool, int]:
    """按量付费长期持有检测。
    
    判定逻辑：
    1. 付费类型为 PostPaid
    2. 持有天数 > 阈值
    
    Returns:
        (should_convert, hold_days)
    """
    if charge_type not in ["PostPaid", "AfterPay"]:
        return False, 0
    
    try:
        # 解析创建时间
        if "T" in creation_time:
            create_dt = datetime.fromisoformat(creation_time.replace("Z", "+00:00"))
        else:
            create_dt = datetime.strptime(creation_time[:19], "%Y-%m-%d %H:%M:%S")
            create_dt = create_dt.replace(tzinfo=timezone.utc)
        
        now = datetime.now(timezone.utc)
        hold_days = (now - create_dt).days
        
        return hold_days > hold_days_threshold, hold_days
    except Exception:
        return False, 0


def _parse_rds_cpu(inst_class: str) -> int:
    """从 RDS 规格名称解析 CPU 核数。
    
    示例:
    - rds.mysql.s1.small -> 1 核
    - rds.mysql.s2.large -> 2 核  
    - rds.mysql.m1.medium -> 2 核
    - rds.mysql.c1.xlarge -> 4 核
    - mysql.n2.medium.1 -> 2 核
    - mysql.n4.large.1 -> 4 核
    """
    inst_class_lower = inst_class.lower()
    # 解析 n 系列 (mysql.n2.medium.1)
    if ".n" in inst_class_lower:
        parts = inst_class_lower.split(".")
        for p in parts:
            if p.startswith("n") and len(p) >= 2:
                try:
                    return int(p[1])
                except ValueError:
                    pass
    # 解析 size 后缀
    if "small" in inst_class_lower:
        return 1
    elif "medium" in inst_class_lower:
        return 2
    elif "2xlarge" in inst_class_lower:
        return 8
    elif "xlarge" in inst_class_lower:
        return 4
    elif "large" in inst_class_lower:
        return 2
    return 2  # 默认


def _get_tag_value(inst, key: str) -> str:
    """从实例对象提取指定 Tag 的值。"""
    tags = inst.tags
    if tags and hasattr(tags, "tag") and tags.tag:
        for t in tags.tag:
            if t.tag_key == key:
                return t.tag_value or ""
    return ""


# =============================================================================
# P0 工具函数（闲置检测）
# =============================================================================


async def opt_detect_idle_ecs(
    region_id: str = "cn-hangzhou",
    strategy: str = "",
    **kwargs,
) -> str:
    """检测闲置 ECS 实例。

    基于 CloudMonitor CPU 利用率，结合策略阈值判定闲置实例。
    按 env 标签过滤目标环境范围。

    Args:
        region_id: 区域 ID
        strategy: 策略名
        **kwargs: 框架注入的参数

    Returns:
        闲置 ECS 列表
    """
    credential = kwargs.get("credential") or get_credential()
    ecs_client = _build_client(credential, "ecs", region_id)
    cms_client = _build_client(credential, "cms", region_id)
    thresholds = _load_thresholds(strategy)

    cpu_threshold = thresholds.get("ecs_idle_cpu_percent", 5.0)
    duration_days = thresholds.get("ecs_idle_duration_days", 7)
    target_envs = thresholds.get("target_environments", ["dev", "test", "staging"])
    automation = thresholds.get("automation_level", "recommend")

    try:
        # 获取 Running 实例
        all_instances = []
        page = 1
        while True:
            req = ecs_models.DescribeInstancesRequest(
                region_id=region_id,
                status="Running",
                page_number=page,
                page_size=100,
            )
            resp = await asyncio.to_thread(ecs_client.describe_instances, req)
            body = resp.body
            if body.instances and body.instances.instance:
                all_instances.extend(body.instances.instance)
            total = body.total_count or 0
            if len(all_instances) >= total:
                break
            page += 1

        # 按 env 标签过滤
        filtered = []
        unknown_env = []
        for inst in all_instances:
            env = _get_tag_value(inst, "env")
            if env in target_envs:
                filtered.append(inst)
            elif not env:
                unknown_env.append(inst)

        idle_instances = []
        total_monthly_saving = 0.0

        for inst in filtered:
            inst_id = inst.instance_id or ""
            avg_cpu = await _get_cms_metric_avg(
                cms_client, "acs_ecs_dashboard", "CPUUtilization",
                [{"instanceId": inst_id}],
                period=86400, days=duration_days,
            )

            if avg_cpu < cpu_threshold:
                cost = _estimate_monthly_cost(
                    inst.instance_type or "",
                    inst.instance_charge_type or "PostPaid",
                )
                total_monthly_saving += cost

                action_text = {
                    "report_only": "仅报告",
                    "recommend": "建议停止该实例以节省费用",
                    "auto_with_approval": "建议 Agent 调用 ecs_stop_instance 停止（需审批）",
                }.get(automation, "仅报告")

                idle_instances.append({
                    "instance_id": inst_id,
                    "instance_name": inst.instance_name or "",
                    "instance_type": inst.instance_type or "",
                    "env": _get_tag_value(inst, "env"),
                    "charge_type": inst.instance_charge_type or "",
                    "avg_cpu_percent": round(avg_cpu, 2),
                    "threshold_cpu_percent": cpu_threshold,
                    "duration_days": duration_days,
                    "estimated_monthly_cost_cny": round(cost, 2),
                    "action": action_text,
                })

        return json.dumps({
            "success": True,
            "region": region_id,
            "strategy": thresholds.get("name", "moderate"),
            "thresholds": {
                "cpu_percent": cpu_threshold,
                "duration_days": duration_days,
                "target_environments": target_envs,
                "automation_level": automation,
            },
            "total_running": len(all_instances),
            "in_scope": len(filtered),
            "unknown_env_count": len(unknown_env),
            "idle_count": len(idle_instances),
            "total_potential_monthly_saving_cny": round(total_monthly_saving, 2),
            "idle_instances": idle_instances,
        }, ensure_ascii=False, indent=2)

    except Exception as e:
        return json.dumps({
            "success": False, "error": str(e),
        }, ensure_ascii=False)


async def opt_detect_idle_rds(
    region_id: str = "cn-hangzhou",
    strategy: str = "",
    **kwargs,
) -> str:
    """检测闲置 RDS 实例。

    基于 CloudMonitor 连接数和 CPU 利用率判定闲置数据库实例。

    Args:
        region_id: 区域 ID
        strategy: 策略名
        **kwargs: 框架注入的参数

    Returns:
        闲置 RDS 列表
    """
    credential = kwargs.get("credential") or get_credential()
    rds_client = _build_client(credential, "rds", region_id)
    cms_client = _build_client(credential, "cms", region_id)
    thresholds = _load_thresholds(strategy)

    cpu_threshold = thresholds.get("rds_idle_cpu_percent", 3.0)
    conn_threshold = thresholds.get("rds_idle_conn_threshold", 0)
    duration_days = thresholds.get("rds_idle_duration_days", 7)

    try:
        # 获取所有 RDS 实例
        all_instances = []
        page = 1
        while True:
            req = rds_models.DescribeDBInstancesRequest(
                region_id=region_id,
                page_number=page,
                page_size=100,
            )
            resp = await asyncio.to_thread(rds_client.describe_dbinstances, req)
            body = resp.body
            items = body.items
            instances = items.dbinstance if items and hasattr(items, "dbinstance") and items.dbinstance else []
            all_instances.extend(instances)
            total = body.total_record_count or 0
            if len(all_instances) >= total:
                break
            page += 1

        idle_instances = []

        for inst in all_instances:
            inst_id = inst.dbinstance_id if hasattr(inst, "dbinstance_id") else ""
            status = inst.dbinstance_status if hasattr(inst, "dbinstance_status") else ""

            if status != "Running":
                continue

            # 查询 CPU 和连接数
            avg_cpu = await _get_cms_metric_avg(
                cms_client, "acs_rds_dashboard", "CpuUsage",
                [{"instanceId": inst_id}],
                period=86400, days=duration_days,
            )
            avg_conn = await _get_cms_metric_avg(
                cms_client, "acs_rds_dashboard", "ConnectionUsage",
                [{"instanceId": inst_id}],
                period=86400, days=duration_days,
            )

            is_idle = avg_cpu < cpu_threshold and avg_conn <= conn_threshold

            if is_idle:
                inst_class = inst.dbinstance_class if hasattr(inst, "dbinstance_class") else ""
                engine = inst.engine if hasattr(inst, "engine") else ""
                charge_type = inst.pay_type if hasattr(inst, "pay_type") else ""

                idle_instances.append({
                    "instance_id": inst_id,
                    "engine": engine,
                    "instance_class": inst_class,
                    "charge_type": charge_type,
                    "avg_cpu_percent": round(avg_cpu, 2),
                    "avg_connection_usage": round(avg_conn, 2),
                    "duration_days": duration_days,
                    "recommendation": "连接数和 CPU 均极低，建议确认是否仍需该实例",
                })

        # =====================================================================
        # 自动导入 Action Store（联动 aliyun-resource-ops）
        # =====================================================================
        action_store_result = {"imported": 0, "message": ""}
        if idle_instances:
            try:
                from datetime import datetime as dt
                from datetime import timedelta
                from pathlib import Path
                import json as _json
                
                store_path = Path.home() / ".copaw" / "data" / "optimization_actions.json"
                store_path.parent.mkdir(parents=True, exist_ok=True)
                
                try:
                    store_data = _json.loads(store_path.read_text(encoding="utf-8"))
                except (FileNotFoundError, _json.JSONDecodeError):
                    store_data = {
                        "version": "1.0",
                        "actions": [],
                        "stats": {"total_created": 0, "total_executed": 0, "total_skipped": 0, "total_savings_realized": 0.0},
                        "updated_at": "",
                    }
                
                existing = {a["resource_id"]: a for a in store_data["actions"]}
                analysis_id = f"rds_idle_{dt.now().strftime('%Y%m%d%H%M%S')}"
                now_iso = dt.now().isoformat()
                expires_iso = (dt.now() + timedelta(days=7)).isoformat()
                
                added = 0
                for inst in idle_instances:
                    resource_id = inst.get("instance_id", "")
                    if not resource_id:
                        continue
                    if resource_id in existing and existing[resource_id].get("status") in ["executed", "skipped"]:
                        continue
                    
                    action = {
                        "action_id": f"act_{resource_id[-8:]}_{dt.now().strftime('%H%M%S')}",
                        "product": "RDS",
                        "resource_id": resource_id,
                        "resource_name": inst.get("engine", "") + " " + inst.get("instance_class", ""),
                        "region_id": region_id,
                        "strategy": "Release",
                        "current_spec": inst.get("instance_class", ""),
                        "target_spec": "",
                        "cost_before": 0.0,
                        "cost_after": 0.0,
                        "cost_saving": 0.0,
                        "reason": inst.get("recommendation", "闲置实例建议释放"),
                        "check_id": "IdleRdsCheck",
                        "status": "pending",
                        "created_at": now_iso,
                        "executed_at": None,
                        "expires_at": expires_iso,
                        "source_analysis_id": analysis_id,
                        "source_product": "RDS",
                        "execute_result": {},
                        "skip_reason": "",
                    }
                    existing[resource_id] = action
                    added += 1
                
                store_data["actions"] = list(existing.values())
                store_data["stats"]["total_created"] += added
                store_data["updated_at"] = now_iso
                store_path.write_text(_json.dumps(store_data, ensure_ascii=False, indent=2), encoding="utf-8")
                action_store_result = {"imported": added, "analysis_id": analysis_id}
                
            except Exception as e:
                logger.warning("自动导入 Action Store 失败: %s", e)
                action_store_result = {"imported": 0, "error": str(e)}

        result_data = {
            "success": True,
            "region": region_id,
            "strategy": thresholds.get("name", "moderate"),
            "thresholds": {
                "cpu_percent": cpu_threshold,
                "conn_threshold": conn_threshold,
                "duration_days": duration_days,
            },
            "total_running": len([i for i in all_instances if (i.dbinstance_status if hasattr(i, "dbinstance_status") else "") == "Running"]),
            "idle_count": len(idle_instances),
            "idle_instances": idle_instances,
        }
        
        if action_store_result.get("imported", 0) > 0:
            result_data["action_store"] = {
                "imported": action_store_result["imported"],
                "analysis_id": action_store_result.get("analysis_id", ""),
                "note": "可通过 ops_list_pending_actions 查询待执行动作",
            }
        
        return json.dumps(result_data, ensure_ascii=False, indent=2)

    except Exception as e:
        return json.dumps({
            "success": False, "error": str(e),
        }, ensure_ascii=False)


async def opt_detect_idle_slb(
    region_id: str = "cn-hangzhou",
    strategy: str = "",
    **kwargs,
) -> str:
    """检测闲置 SLB（负载均衡）实例。

    基于 CloudMonitor 流量和活跃连接数判定闲置 SLB。

    Args:
        region_id: 区域 ID
        strategy: 策略名
        **kwargs: 框架注入的参数

    Returns:
        闲置 SLB 列表
    """
    credential = kwargs.get("credential") or get_credential()
    slb_client = _build_client(credential, "slb", region_id)
    cms_client = _build_client(credential, "cms", region_id)
    thresholds = _load_thresholds(strategy)

    duration_days = thresholds.get("slb_idle_duration_days", 7)

    try:
        # 获取所有 SLB
        all_slbs = []
        page = 1
        while True:
            req = slb_models.DescribeLoadBalancersRequest(
                region_id=region_id,
                page_number=page,
                page_size=100,
            )
            resp = await asyncio.to_thread(slb_client.describe_load_balancers, req)
            body = resp.body
            lbs = body.load_balancers
            items = lbs.load_balancer if lbs and hasattr(lbs, "load_balancer") and lbs.load_balancer else []
            all_slbs.extend(items)
            total = body.total_count or 0
            if len(all_slbs) >= total:
                break
            page += 1

        idle_slbs = []

        for slb in all_slbs:
            slb_id = slb.load_balancer_id if hasattr(slb, "load_balancer_id") else ""
            slb_name = slb.load_balancer_name if hasattr(slb, "load_balancer_name") else ""
            status = slb.load_balancer_status if hasattr(slb, "load_balancer_status") else ""

            if status != "active":
                continue

            # 查询流量
            avg_traffic = await _get_cms_metric_avg(
                cms_client, "acs_slb_dashboard", "TrafficRXNew",
                [{"instanceId": slb_id}],
                period=86400, days=duration_days,
            )
            avg_conn = await _get_cms_metric_avg(
                cms_client, "acs_slb_dashboard", "ActiveConnection",
                [{"instanceId": slb_id}],
                period=86400, days=duration_days,
            )

            if avg_traffic < 1.0 and avg_conn < 1.0:
                spec = slb.load_balancer_spec if hasattr(slb, "load_balancer_spec") else ""
                charge_type = slb.internet_charge_type if hasattr(slb, "internet_charge_type") else ""

                idle_slbs.append({
                    "load_balancer_id": slb_id,
                    "name": slb_name,
                    "spec": spec,
                    "charge_type": charge_type,
                    "avg_traffic_bps": round(avg_traffic, 2),
                    "avg_active_connections": round(avg_conn, 2),
                    "duration_days": duration_days,
                    "recommendation": "流量和连接数均为零，建议确认是否仍需要该 SLB",
                })

        return json.dumps({
            "success": True,
            "region": region_id,
            "strategy": thresholds.get("name", "moderate"),
            "total_slbs": len(all_slbs),
            "active_slbs": len([s for s in all_slbs if (s.load_balancer_status if hasattr(s, "load_balancer_status") else "") == "active"]),
            "idle_count": len(idle_slbs),
            "idle_slbs": idle_slbs,
        }, ensure_ascii=False, indent=2)

    except Exception as e:
        return json.dumps({
            "success": False, "error": str(e),
        }, ensure_ascii=False)


async def opt_get_advisor_recommendations(
    region_id: str = "cn-hangzhou",
    **kwargs,
) -> str:
    """获取阿里云 Advisor 智能顾问的优化建议。

    通过 ECS DescribeRecommendationTasks 获取平台级优化建议。

    Args:
        region_id: 区域 ID
        **kwargs: 框架注入的参数

    Returns:
        Advisor 建议列表
    """
    credential = kwargs.get("credential") or get_credential()
    ecs_client = _build_client(credential, "ecs", region_id)

    try:
        # 查询可降配的实例（通过 DescribeInstances 获取基本信息后由 Agent 综合分析）
        all_instances = []
        page = 1
        while True:
            req = ecs_models.DescribeInstancesRequest(
                region_id=region_id,
                status="Running",
                page_number=page,
                page_size=100,
            )
            resp = await asyncio.to_thread(ecs_client.describe_instances, req)
            body = resp.body
            if body.instances and body.instances.instance:
                all_instances.extend(body.instances.instance)
            total = body.total_count or 0
            if len(all_instances) >= total:
                break
            page += 1

        recommendations = []
        for inst in all_instances:
            inst_type = inst.instance_type or ""
            # 检查是否为老代实例
            is_old_gen = any(inst_type.startswith(prefix) for prefix in OLD_GENERATION_PREFIXES)
            if is_old_gen:
                recommendations.append({
                    "type": "old_generation_upgrade",
                    "instance_id": inst.instance_id or "",
                    "instance_name": inst.instance_name or "",
                    "current_type": inst_type,
                    "recommendation": f"实例使用老代规格 {inst_type}，建议升级到当代规格以获得更好的性价比",
                })

        return json.dumps({
            "success": True,
            "region": region_id,
            "total_running": len(all_instances),
            "recommendation_count": len(recommendations),
            "recommendations": recommendations[:50],
            "note": "建议配合 opt_ecs_rightsizing 获取更精确的降配建议",
        }, ensure_ascii=False, indent=2)

    except Exception as e:
        return json.dumps({
            "success": False, "error": str(e),
        }, ensure_ascii=False)


# =============================================================================
# P1 工具函数（利用率分析与 Rightsizing）
# =============================================================================


async def opt_ecs_utilization_report(
    region_id: str = "cn-hangzhou",
    env_filter: Optional[str] = None,
    **kwargs,
) -> str:
    """ECS 利用率报告。

    查询 Running 实例的 7 天 CPU 和内存利用率，
    标记利用率过低或过高的实例。支持按 env 标签过滤。

    Args:
        region_id: 区域 ID
        env_filter: 按 env 标签过滤，如 "dev"、"test"、"prod"，为空则查询全部
        **kwargs: 框架注入的参数

    Returns:
        ECS 利用率报告
    """
    credential = kwargs.get("credential") or get_credential()
    ecs_client = _build_client(credential, "ecs", region_id)
    cms_client = _build_client(credential, "cms", region_id)

    try:
        all_instances = []
        page = 1
        while True:
            req = ecs_models.DescribeInstancesRequest(
                region_id=region_id,
                status="Running",
                page_number=page,
                page_size=100,
            )
            resp = await asyncio.to_thread(ecs_client.describe_instances, req)
            body = resp.body
            if body.instances and body.instances.instance:
                all_instances.extend(body.instances.instance)
            total = body.total_count or 0
            if len(all_instances) >= total:
                break
            page += 1

        # 按 env 标签过滤
        if env_filter:
            filtered_instances = [
                inst for inst in all_instances
                if _get_tag_value(inst, "env") == env_filter
            ]
        else:
            filtered_instances = all_instances

        utilization_data = []
        low_util = 0
        high_util = 0

        for inst in filtered_instances:
            inst_id = inst.instance_id or ""
            env_tag = _get_tag_value(inst, "env")

            avg_cpu = await _get_cms_metric_avg(
                cms_client, "acs_ecs_dashboard", "CPUUtilization",
                [{"instanceId": inst_id}], days=7,
            )
            p95_cpu = await _get_cms_metric_percentile(
                cms_client, "acs_ecs_dashboard", "CPUUtilization",
                [{"instanceId": inst_id}], days=7,
            )
            avg_mem = await _get_cms_metric_avg(
                cms_client, "acs_ecs_dashboard", "memory_usedutilization",
                [{"instanceId": inst_id}], days=7,
            )

            status_tag = "normal"
            if p95_cpu < 20 and avg_mem < 20:
                status_tag = "underutilized"
                low_util += 1
            elif p95_cpu > 80 or avg_mem > 80:
                status_tag = "overutilized"
                high_util += 1

            utilization_data.append({
                "instance_id": inst_id,
                "instance_name": inst.instance_name or "",
                "instance_type": inst.instance_type or "",
                "env": env_tag or "unknown",
                "avg_cpu_7d": round(avg_cpu, 1),
                "p95_cpu_7d": round(p95_cpu, 1),
                "avg_memory_7d": round(avg_mem, 1),
                "status": status_tag,
            })

        return json.dumps({
            "success": True,
            "region": region_id,
            "env_filter": env_filter,
            "total_running": len(all_instances),
            "filtered_count": len(filtered_instances),
            "underutilized_count": low_util,
            "overutilized_count": high_util,
            "normal_count": len(utilization_data) - low_util - high_util,
            "instances": utilization_data,
        }, ensure_ascii=False, indent=2)

    except Exception as e:
        return json.dumps({
            "success": False, "error": str(e),
        }, ensure_ascii=False)


async def opt_ecs_rightsizing(
    region_id: str = "cn-hangzhou",
    **kwargs,
) -> str:
    """ECS 规格调整建议。

    基于 7 天 P95 CPU/Memory 利用率，建议降配或升配。
    P95 < 50%  -> 建议降一档
    P95 > 80%  -> 建议升一档

    Args:
        region_id: 区域 ID
        **kwargs: 框架注入的参数

    Returns:
        规格调整建议列表
    """
    credential = kwargs.get("credential") or get_credential()
    ecs_client = _build_client(credential, "ecs", region_id)
    cms_client = _build_client(credential, "cms", region_id)

    # 规格族内升降档映射
    size_order = ["large", "xlarge", "2xlarge", "4xlarge", "8xlarge", "16xlarge"]

    def _get_adjacent_type(inst_type: str, direction: str) -> Optional[str]:
        parts = inst_type.split(".")
        if len(parts) < 3:
            return None
        family = ".".join(parts[:2])
        size = parts[2]
        if size in size_order:
            idx = size_order.index(size)
            if direction == "down" and idx > 0:
                return f"{family}.{size_order[idx - 1]}"
            elif direction == "up" and idx < len(size_order) - 1:
                return f"{family}.{size_order[idx + 1]}"
        return None

    try:
        all_instances = []
        page = 1
        while True:
            req = ecs_models.DescribeInstancesRequest(
                region_id=region_id,
                status="Running",
                page_number=page,
                page_size=100,
            )
            resp = await asyncio.to_thread(ecs_client.describe_instances, req)
            body = resp.body
            if body.instances and body.instances.instance:
                all_instances.extend(body.instances.instance)
            total = body.total_count or 0
            if len(all_instances) >= total:
                break
            page += 1

        rightsizing_suggestions = []
        total_saving = 0.0

        for inst in all_instances:
            inst_id = inst.instance_id or ""
            inst_type = inst.instance_type or ""

            p95_cpu = await _get_cms_metric_percentile(
                cms_client, "acs_ecs_dashboard", "CPUUtilization",
                [{"instanceId": inst_id}], days=7,
            )
            p95_mem = await _get_cms_metric_percentile(
                cms_client, "acs_ecs_dashboard", "memory_usedutilization",
                [{"instanceId": inst_id}], days=7,
            )

            suggestion = None
            if p95_cpu < 50 and p95_mem < 50:
                new_type = _get_adjacent_type(inst_type, "down")
                if new_type:
                    current_cost = _estimate_monthly_cost(inst_type, inst.instance_charge_type or "")
                    new_cost = _estimate_monthly_cost(new_type, inst.instance_charge_type or "")
                    saving = current_cost - new_cost
                    total_saving += saving
                    suggestion = {
                        "direction": "downsize",
                        "current_type": inst_type,
                        "suggested_type": new_type,
                        "current_monthly_cost": round(current_cost, 2),
                        "suggested_monthly_cost": round(new_cost, 2),
                        "monthly_saving": round(saving, 2),
                    }
            elif p95_cpu > 80 or p95_mem > 80:
                new_type = _get_adjacent_type(inst_type, "up")
                if new_type:
                    suggestion = {
                        "direction": "upsize",
                        "current_type": inst_type,
                        "suggested_type": new_type,
                        "note": "P95 利用率偏高，建议升配以避免性能瓶颈",
                    }

            if suggestion:
                rightsizing_suggestions.append({
                    "instance_id": inst_id,
                    "instance_name": inst.instance_name or "",
                    "p95_cpu": round(p95_cpu, 1),
                    "p95_memory": round(p95_mem, 1),
                    **suggestion,
                })

        downsize = [s for s in rightsizing_suggestions if s.get("direction") == "downsize"]
        upsize = [s for s in rightsizing_suggestions if s.get("direction") == "upsize"]

        return json.dumps({
            "success": True,
            "region": region_id,
            "total_analyzed": len(all_instances),
            "downsize_count": len(downsize),
            "upsize_count": len(upsize),
            "total_potential_monthly_saving_cny": round(total_saving, 2),
            "suggestions": rightsizing_suggestions,
        }, ensure_ascii=False, indent=2)

    except Exception as e:
        return json.dumps({
            "success": False, "error": str(e),
        }, ensure_ascii=False)


async def opt_detect_old_generation(
    region_id: str = "cn-hangzhou",
    **kwargs,
) -> str:
    """检测老代实例。

    列出使用已淘汰规格族（如 ecs.s1/ecs.m1/ecs.c1/ecs.n1 等）的实例，
    建议升级到当代规格。

    Args:
        region_id: 区域 ID
        **kwargs: 框架注入的参数

    Returns:
        老代实例列表
    """
    credential = kwargs.get("credential") or get_credential()
    ecs_client = _build_client(credential, "ecs", region_id)

    try:
        all_instances = []
        page = 1
        while True:
            req = ecs_models.DescribeInstancesRequest(
                region_id=region_id,
                page_number=page,
                page_size=100,
            )
            resp = await asyncio.to_thread(ecs_client.describe_instances, req)
            body = resp.body
            if body.instances and body.instances.instance:
                all_instances.extend(body.instances.instance)
            total = body.total_count or 0
            if len(all_instances) >= total:
                break
            page += 1

        old_gen_instances = []
        for inst in all_instances:
            inst_type = inst.instance_type or ""
            if any(inst_type.startswith(prefix) for prefix in OLD_GENERATION_PREFIXES):
                old_gen_instances.append({
                    "instance_id": inst.instance_id or "",
                    "instance_name": inst.instance_name or "",
                    "instance_type": inst_type,
                    "status": inst.status or "",
                    "charge_type": inst.instance_charge_type or "",
                    "recommendation": (
                        f"规格 {inst_type} 为老代产品，建议升级到当代规格族"
                        "（如 g7/c7/r7 系列）以获得更好性价比和性能"
                    ),
                })

        return json.dumps({
            "success": True,
            "region": region_id,
            "total_instances": len(all_instances),
            "old_generation_count": len(old_gen_instances),
            "old_generation_instances": old_gen_instances,
            "old_generation_prefixes": OLD_GENERATION_PREFIXES,
        }, ensure_ascii=False, indent=2)

    except Exception as e:
        return json.dumps({
            "success": False, "error": str(e),
        }, ensure_ascii=False)


async def opt_rds_utilization_report(
    region_id: str = "cn-hangzhou",
    idle_threshold: float = 1.0,
    low_util_threshold: float = 20.0,
    hold_days: int = 30,
    **kwargs,
) -> str:
    """RDS 利用率与成本优化报告。

    Args:
        region_id: 区域 ID
        idle_threshold: 闲置判定阈值（%）
        low_util_threshold: 低利用率 P95 阈值（%）
        hold_days: 按量付费持有天数阈值
        **kwargs: 框架注入的参数

    Returns:
        RDS 成本优化报告（Markdown 格式）
    """
    from core.base import OptimizeResult, OptimizeStrategy
    from core.report import generate_cost_report
    
    credential = kwargs.get("credential") or get_credential()
    rds_client = _build_client(credential, "rds", region_id)
    cms_client = _build_client(credential, "cms", region_id)

    try:
        all_instances = []
        page = 1
        while True:
            req = rds_models.DescribeDBInstancesRequest(
                region_id=region_id,
                page_number=page,
                page_size=100,
            )
            resp = await asyncio.to_thread(rds_client.describe_dbinstances, req)
            body = resp.body
            items = body.items
            instances = items.dbinstance if items and hasattr(items, "dbinstance") and items.dbinstance else []
            all_instances.extend(instances)
            total = body.total_record_count or 0
            if len(all_instances) >= total:
                break
            page += 1

        # 统计数据
        stats = {
            "total": 0,
            "idle": 0,
            "low_util": 0,
            "postpaid_longterm": 0,
            "normal": 0,
        }
        
        results: list[OptimizeResult] = []

        for inst in all_instances:
            inst_id = inst.dbinstance_id if hasattr(inst, "dbinstance_id") else ""
            inst_name = inst.dbinstance_description if hasattr(inst, "dbinstance_description") else ""
            inst_class = inst.dbinstance_class if hasattr(inst, "dbinstance_class") else ""
            engine = inst.engine if hasattr(inst, "engine") else ""
            status = inst.dbinstance_status if hasattr(inst, "dbinstance_status") else ""
            charge_type = inst.pay_type if hasattr(inst, "pay_type") else "Postpaid"
            create_time = inst.create_time if hasattr(inst, "create_time") else ""

            if status != "Running":
                continue
            
            stats["total"] += 1

            # 获取监控数据
            avg_cpu = await _get_cms_metric_avg(
                cms_client, "acs_rds_dashboard", "CpuUsage",
                [{"instanceId": inst_id}], days=7,
            )
            avg_conn = await _get_cms_metric_avg(
                cms_client, "acs_rds_dashboard", "ConnectionUsage",
                [{"instanceId": inst_id}], days=7,
            )
            avg_disk = await _get_cms_metric_avg(
                cms_client, "acs_rds_dashboard", "DiskUsage",
                [{"instanceId": inst_id}], days=7,
            )
            max_cpu = await _get_cms_metric_max(
                cms_client, "acs_rds_dashboard", "CpuUsage",
                [{"instanceId": inst_id}], days=7,
            )
            p95_cpu = await _get_cms_metric_percentile(
                cms_client, "acs_rds_dashboard", "CpuUsage",
                [{"instanceId": inst_id}], days=7,
            )
            
            # 估算价格（RDS 按规格估算）
            cost_before = _estimate_rds_monthly_cost(inst_class, charge_type)
            
            # 计算持有天数
            days_held = 0
            if create_time:
                try:
                    from datetime import datetime
                    ct = datetime.fromisoformat(create_time.replace("Z", "+00:00"))
                    days_held = (datetime.now(ct.tzinfo) - ct).days
                except:
                    pass

            # 判断优化策略
            # 1. 闲置检测：CPU 和连接数都极低
            if max_cpu >= 0 and max_cpu < idle_threshold and avg_conn < 5:
                stats["idle"] += 1
                results.append(OptimizeResult(
                    product="rds",
                    resource_id=inst_id,
                    resource_name=inst_name or f"{engine}-{inst_id[-8:]}",
                    region_id=region_id,
                    instance_type=inst_class,
                    charge_type=charge_type,
                    strategy=OptimizeStrategy.RELEASE,
                    optimized_config="",
                    cost_before=cost_before,
                    cost_after=0.0,
                    cost_savings=cost_before,
                    savings_pct=100.0,
                    extend_result={
                        "engine": engine,
                        "metrics": {
                            "avg_cpu_7d": round(avg_cpu, 1),
                            "max_cpu_7d": round(max_cpu, 1),
                            "avg_conn_7d": round(avg_conn, 1),
                            "avg_disk_7d": round(avg_disk, 1),
                        },
                    },
                ))
                continue
            
            # 2. 低利用率检测：P95 CPU < 阈值
            if p95_cpu >= 0 and p95_cpu < low_util_threshold:
                stats["low_util"] += 1
                # 尝试推荐更低规格
                target_class = _get_rds_lower_class(inst_class)
                cost_after = _estimate_rds_monthly_cost(target_class or inst_class, charge_type) if target_class else cost_before * 0.6
                cost_savings = max(0, cost_before - cost_after)
                
                if cost_savings > 0:
                    results.append(OptimizeResult(
                        product="rds",
                        resource_id=inst_id,
                        resource_name=inst_name or f"{engine}-{inst_id[-8:]}",
                        region_id=region_id,
                        instance_type=inst_class,
                        charge_type=charge_type,
                        strategy=OptimizeStrategy.DOWN_SCALING,
                        optimized_config=target_class or "更低规格",
                        cost_before=cost_before,
                        cost_after=cost_after,
                        cost_savings=cost_savings,
                        savings_pct=round(cost_savings / cost_before * 100, 1) if cost_before > 0 else 0,
                        extend_result={
                            "engine": engine,
                            "low_util_threshold": low_util_threshold,
                            "metrics": {
                                "avg_cpu_7d": round(avg_cpu, 1),
                                "p95_cpu_7d": round(p95_cpu, 1),
                                "avg_conn_7d": round(avg_conn, 1),
                                "avg_disk_7d": round(avg_disk, 1),
                            },
                        },
                    ))
                    continue
            
            # 3. 按量长期持有检测
            if charge_type in ("Postpaid", "PostPaid") and days_held > hold_days:
                stats["postpaid_longterm"] += 1
                # 转包月约省 30%
                cost_after = cost_before * 0.7
                cost_savings = cost_before - cost_after
                
                results.append(OptimizeResult(
                    product="rds",
                    resource_id=inst_id,
                    resource_name=inst_name or f"{engine}-{inst_id[-8:]}",
                    region_id=region_id,
                    instance_type=inst_class,
                    charge_type=charge_type,
                    strategy=OptimizeStrategy.CONVERT_TO_PREPAID,
                    optimized_config=inst_class,
                    cost_before=cost_before,
                    cost_after=cost_after,
                    cost_savings=cost_savings,
                    savings_pct=30.0,
                    extend_result={
                        "engine": engine,
                        "hold_days": days_held,
                        "threshold": hold_days,
                        "metrics": {
                            "avg_cpu_7d": round(avg_cpu, 1),
                            "avg_conn_7d": round(avg_conn, 1),
                            "avg_disk_7d": round(avg_disk, 1),
                        },
                    },
                ))
                continue
            
            # 4. 正常
            stats["normal"] += 1

        # 使用统一报告生成器
        report = generate_cost_report(
            results=results,
            region_id=region_id,
            products=["RDS"],
            stats=stats,
            params={
                "idle_threshold": idle_threshold,
                "low_util_threshold": low_util_threshold,
                "hold_days": hold_days,
            },
            title="RDS 成本优化分析报告",
        )
        
        return report

    except Exception as e:
        return f"# RDS 分析失败\n\n错误信息: {str(e)}"


def _estimate_rds_monthly_cost(instance_class: str, charge_type: str) -> float:
    """估算 RDS 月费用。"""
    # 简化估算：基于规格关键字
    base_prices = {
        "small": 200,
        "medium": 400,
        "large": 800,
        "xlarge": 1200,
        "2xlarge": 2000,
        "4xlarge": 3500,
        "8xlarge": 6000,
    }
    
    price = 300  # 默认
    for key, val in base_prices.items():
        if key in instance_class.lower():
            price = val
            break
    
    # 按量付费通常比包月贵 30%
    if charge_type in ("Postpaid", "PostPaid"):
        price *= 1.3
    
    return round(price, 2)


def _get_rds_lower_class(current_class: str) -> str:
    """获取 RDS 更低一级的规格。"""
    # 简化映射
    mappings = {
        "8xlarge": "4xlarge",
        "4xlarge": "2xlarge",
        "2xlarge": "xlarge",
        "xlarge": "large",
        "large": "medium",
        "medium": "small",
    }
    
    for k, v in mappings.items():
        if k in current_class.lower():
            return current_class.lower().replace(k, v)
    
    return ""


async def opt_detect_schedule_candidates(
    region_id: str = "cn-hangzhou",
    strategy: str = "",
    **kwargs,
) -> str:
    """检测可在非工作时间关停的资源。

    通过 env 标签识别 dev/test/staging 环境的按量实例，
    作为定时关停的候选。

    Args:
        region_id: 区域 ID
        strategy: 策略名
        **kwargs: 框架注入的参数

    Returns:
        可定时关停的候选列表
    """
    credential = kwargs.get("credential") or get_credential()
    ecs_client = _build_client(credential, "ecs", region_id)
    thresholds = _load_thresholds(strategy)

    non_prod_envs = [e for e in thresholds.get("target_environments", []) if e != "production"]

    try:
        all_instances = []
        page = 1
        while True:
            req = ecs_models.DescribeInstancesRequest(
                region_id=region_id,
                status="Running",
                page_number=page,
                page_size=100,
            )
            resp = await asyncio.to_thread(ecs_client.describe_instances, req)
            body = resp.body
            if body.instances and body.instances.instance:
                all_instances.extend(body.instances.instance)
            total = body.total_count or 0
            if len(all_instances) >= total:
                break
            page += 1

        candidates = []
        total_potential_saving = 0.0

        for inst in all_instances:
            env = _get_tag_value(inst, "env")
            charge_type = inst.instance_charge_type or ""

            # 仅按量付费的非生产实例有关停收益
            if env in non_prod_envs and charge_type == "PostPaid":
                cost = _estimate_monthly_cost(inst.instance_type or "", "PostPaid")
                # 假设非工作时间占 60%（工作日 18h/24h + 周末）
                saving = round(cost * 0.6, 2)
                total_potential_saving += saving

                candidates.append({
                    "instance_id": inst.instance_id or "",
                    "instance_name": inst.instance_name or "",
                    "instance_type": inst.instance_type or "",
                    "env": env,
                    "monthly_cost_cny": round(cost, 2),
                    "potential_saving_cny": saving,
                    "recommendation": f"非生产环境({env})按量实例，建议配置非工作时间自动关停",
                })

        return json.dumps({
            "success": True,
            "region": region_id,
            "strategy": thresholds.get("name", "moderate"),
            "non_prod_environments": non_prod_envs,
            "total_running": len(all_instances),
            "candidate_count": len(candidates),
            "total_potential_monthly_saving_cny": round(total_potential_saving, 2),
            "candidates": candidates,
            "note": "节省金额假设非工作时间占月度 60%，仅对按量付费实例有效",
        }, ensure_ascii=False, indent=2)

    except Exception as e:
        return json.dumps({
            "success": False, "error": str(e),
        }, ensure_ascii=False)


# =============================================================================
# P2 工具函数（综合报告）
# =============================================================================


async def opt_generate_savings_report(
    region_id: str = "cn-hangzhou",
    strategy: str = "",
    **kwargs,
) -> str:
    """生成综合节省报告。

    编排调用闲置检测和 rightsizing 函数，汇总为优先级排序的 action items。

    Args:
        region_id: 区域 ID
        strategy: 策略名
        **kwargs: 框架注入的参数

    Returns:
        综合节省报告
    """
    credential = kwargs.get("credential") or get_credential()
    thresholds = _load_thresholds(strategy)
    strategy_name = thresholds.get("name", "moderate")

    action_items: list[dict] = []
    total_saving = 0.0

    # --- 闲置 ECS ---
    try:
        ecs_result = json.loads(
            await opt_detect_idle_ecs(region_id=region_id, strategy=strategy, credential=credential)
        )
        if ecs_result.get("success"):
            saving = ecs_result.get("total_potential_monthly_saving_cny", 0)
            count = ecs_result.get("idle_count", 0)
            if saving > 0:
                action_items.append({
                    "priority": 0,
                    "category": "闲置 ECS 停止/释放",
                    "saving_cny": saving,
                    "count": count,
                    "effort": "低",
                    "risk": "中（需确认业务状态）",
                    "action": f"停止 {count} 个闲置 ECS 实例",
                })
                total_saving += saving
    except Exception:
        pass

    # --- 闲置 RDS ---
    try:
        rds_result = json.loads(
            await opt_detect_idle_rds(region_id=region_id, strategy=strategy, credential=credential)
        )
        if rds_result.get("success"):
            count = rds_result.get("idle_count", 0)
            if count > 0:
                action_items.append({
                    "priority": 0,
                    "category": "闲置 RDS 审查",
                    "count": count,
                    "effort": "中",
                    "risk": "中",
                    "action": f"审查 {count} 个闲置 RDS 实例",
                })
    except Exception:
        pass

    # --- 闲置 SLB ---
    try:
        slb_result = json.loads(
            await opt_detect_idle_slb(region_id=region_id, strategy=strategy, credential=credential)
        )
        if slb_result.get("success"):
            count = slb_result.get("idle_count", 0)
            if count > 0:
                action_items.append({
                    "priority": 0,
                    "category": "闲置 SLB 清理",
                    "count": count,
                    "effort": "低",
                    "risk": "低",
                    "action": f"清理 {count} 个闲置 SLB",
                })
    except Exception:
        pass

    # --- Rightsizing ---
    try:
        rs_result = json.loads(
            await opt_ecs_rightsizing(region_id=region_id, credential=credential)
        )
        if rs_result.get("success"):
            saving = rs_result.get("total_potential_monthly_saving_cny", 0)
            count = rs_result.get("downsize_count", 0)
            if saving > 0:
                action_items.append({
                    "priority": 0,
                    "category": "ECS 规格降配",
                    "saving_cny": saving,
                    "count": count,
                    "effort": "中（需停机变配）",
                    "risk": "中",
                    "action": f"{count} 个实例建议降配",
                })
                total_saving += saving
    except Exception:
        pass

    # --- 定时关停 ---
    try:
        sched_result = json.loads(
            await opt_detect_schedule_candidates(region_id=region_id, strategy=strategy, credential=credential)
        )
        if sched_result.get("success"):
            saving = sched_result.get("total_potential_monthly_saving_cny", 0)
            count = sched_result.get("candidate_count", 0)
            if saving > 0:
                action_items.append({
                    "priority": 0,
                    "category": "非生产环境定时关停",
                    "saving_cny": saving,
                    "count": count,
                    "effort": "低（配置定时任务）",
                    "risk": "低",
                    "action": f"{count} 个非生产按量实例可在非工作时间关停",
                })
                total_saving += saving
    except Exception:
        pass

    # 按节省金额排序并分配优先级
    action_items.sort(key=lambda x: x.get("saving_cny", 0), reverse=True)
    for i, item in enumerate(action_items, 1):
        item["priority"] = i

    return json.dumps({
        "success": True,
        "report_time": datetime.now(timezone.utc).isoformat(),
        "region": region_id,
        "strategy": strategy_name,
        "total_potential_monthly_saving_cny": round(total_saving, 2),
        "action_items": action_items,
    }, ensure_ascii=False, indent=2)


# =============================================================================
# 通用云监控查询
# =============================================================================


async def _get_cms_metric_datapoints(
    cms_client: CmsClient,
    namespace: str,
    metric_name: str,
    dimensions: list[dict],
    period: int = 86400,
    days: int = 7,
) -> list[dict]:
    """查询 CloudMonitor 指标原始数据点。"""
    now = datetime.now(timezone.utc)
    start_ts = int((now - timedelta(days=days)).timestamp() * 1000)
    end_ts = int(now.timestamp() * 1000)
    try:
        req = cms_models.DescribeMetricListRequest(
            namespace=namespace,
            metric_name=metric_name,
            dimensions=json.dumps(dimensions),
            period=str(period),
            start_time=str(start_ts),
            end_time=str(end_ts),
        )
        resp = await asyncio.to_thread(cms_client.describe_metric_list, req)
        body = resp.body
        if body.datapoints:
            return json.loads(body.datapoints)
    except Exception as e:
        logger.warning("CMS datapoints query %s/%s failed: %s", namespace, metric_name, e)
    return []


def _compute_percentile(values: list[float], percentile: float) -> float:
    """计算百分位数。"""
    if not values:
        return 0.0
    sorted_vals = sorted(values)
    idx = min(int(len(sorted_vals) * percentile), len(sorted_vals) - 1)
    return sorted_vals[idx]


async def opt_cloudmonitor_query(
    region_id: str = "cn-hangzhou",
    namespace: str = "acs_ecs_dashboard",
    metric_name: str = "CPUUtilization",
    instance_ids: Optional[list[str]] = None,
    days: int = 7,
    period: int = 3600,
    **kwargs,
) -> str:
    """通用云监控水位查询。

    支持查询任意产品、任意指标的历史水位数据，返回聚合统计结果。

    Args:
        region_id: 区域 ID
        namespace: 产品命名空间，如 acs_ecs_dashboard、acs_rds_dashboard、acs_kvstore 等
        metric_name: 指标名，如 CPUUtilization、memory_usedutilization、CpuUsage 等
        instance_ids: 实例 ID 列表，为空时返回错误提示
        days: 查询天数，默认 7
        period: 聚合周期秒，默认 3600（1小时）。可选：60/300/900/3600/86400
        **kwargs: 框架注入的参数

    Returns:
        各实例的聚合统计数据（avg、max、min、p95、p99）

    常用 namespace / metric_name:
        ECS: acs_ecs_dashboard / CPUUtilization, memory_usedutilization
        RDS: acs_rds_dashboard / CpuUsage, MemoryUsage, DiskUsage, ConnectionUsage
        Redis: acs_kvstore / CpuUsage, MemoryUsage, ConnectionUsage
        SLB: acs_slb_dashboard / ActiveConnection, TrafficRXNew, TrafficTXNew
        NAS: acs_nas / read_iops, write_iops
    """
    # === 参数解析：处理 Agent 传入 JSON 字符串的情况 ===
    if isinstance(instance_ids, str):
        try:
            instance_ids = json.loads(instance_ids)
        except json.JSONDecodeError:
            # 如果不是 JSON，尝试按逗号分割
            instance_ids = [s.strip() for s in instance_ids.split(",") if s.strip()]
    
    if not instance_ids:
        return json.dumps({
            "success": False,
            "error": "instance_ids 参数不能为空，请提供要查询的实例 ID 列表",
        }, ensure_ascii=False)

    credential = kwargs.get("credential") or get_credential()
    cms_client = _build_client(credential, "cms", region_id)

    try:
        results = []

        for inst_id in instance_ids:
            dimensions = [{"instanceId": inst_id}]
            datapoints = await _get_cms_metric_datapoints(
                cms_client, namespace, metric_name,
                dimensions, period=period, days=days,
            )

            if not datapoints:
                results.append({
                    "instance_id": inst_id,
                    "data_points_count": 0,
                    "avg": None,
                    "max": None,
                    "min": None,
                    "p95": None,
                    "p99": None,
                    "note": "无数据或指标不存在",
                })
                continue

            # 提取 Average 值（CloudMonitor 返回的聚合值）
            values = [
                _safe_float(p.get("Average", p.get("average", 0)))
                for p in datapoints
            ]
            max_values = [
                _safe_float(p.get("Maximum", p.get("maximum", 0)))
                for p in datapoints
            ]
            min_values = [
                _safe_float(p.get("Minimum", p.get("minimum", 0)))
                for p in datapoints
            ]

            avg_val = sum(values) / len(values) if values else 0.0
            max_val = max(max_values) if max_values else 0.0
            min_val = min(min_values) if min_values else 0.0
            p95_val = _compute_percentile(values, 0.95)
            p99_val = _compute_percentile(values, 0.99)

            results.append({
                "instance_id": inst_id,
                "data_points_count": len(datapoints),
                "avg": round(avg_val, 2),
                "max": round(max_val, 2),
                "min": round(min_val, 2),
                "p95": round(p95_val, 2),
                "p99": round(p99_val, 2),
            })

        return json.dumps({
            "success": True,
            "region": region_id,
            "namespace": namespace,
            "metric_name": metric_name,
            "period_seconds": period,
            "days": days,
            "instance_count": len(results),
            "instances": results,
        }, ensure_ascii=False, indent=2)

    except Exception as e:
        return json.dumps({
            "success": False,
            "error": str(e),
        }, ensure_ascii=False)


# =============================================================================
# 实时规格查询与推荐
# =============================================================================


async def _query_ecs_available_specs(
    ecs_client: EcsClient,
    region_id: str,
    zone_id: str,
    instance_type: str,
) -> tuple[list[dict], dict]:
    """查询 ECS 可用规格（实时 API）。
    
    返回同系列规格列表和库存概况。
    """
    # 提取规格族前缀，如 ecs.g6 -> g6
    parts = instance_type.split(".")
    family = parts[1] if len(parts) >= 2 else ""
    
    stock_summary = {
        "zone_id": zone_id,
        "family": family,
        "total_specs": 0,
        "available_count": 0,
        "sold_out_count": 0,
        "available_specs": [],
        "sold_out_specs": [],
    }
    
    try:
        req = ecs_models.DescribeAvailableResourceRequest(
            region_id=region_id,
            zone_id=zone_id,
            destination_resource="InstanceType",
            instance_charge_type="PostPaid",
        )
        resp = await asyncio.to_thread(ecs_client.describe_available_resource, req)
        body = resp.body
        
        available_specs = []
        if body.available_zones and body.available_zones.available_zone:
            for zone in body.available_zones.available_zone:
                if zone.available_resources and zone.available_resources.available_resource:
                    for res in zone.available_resources.available_resource:
                        if res.supported_resources and res.supported_resources.supported_resource:
                            for spec in res.supported_resources.supported_resource:
                                spec_value = spec.value or ""
                                status = spec.status or ""
                                status_category = spec.status_category or ""
                                
                                # 只过滤同系列
                                if family and f".{family}." in spec_value:
                                    stock_summary["total_specs"] += 1
                                    
                                    if status == "Available":
                                        stock_summary["available_count"] += 1
                                        stock_summary["available_specs"].append(spec_value)
                                        available_specs.append({
                                            "instance_type": spec_value,
                                            "status": status,
                                            "status_category": status_category,
                                        })
                                    else:
                                        stock_summary["sold_out_count"] += 1
                                        stock_summary["sold_out_specs"].append({
                                            "type": spec_value,
                                            "status": status,
                                        })
        
        return available_specs, stock_summary
    except Exception as e:
        logger.warning("Query available specs failed: %s", e)
        return [], stock_summary


async def _query_ecs_instance_types(
    ecs_client: EcsClient,
    instance_types: list[str],
) -> dict[str, dict]:
    """查询 ECS 规格配置（CPU/内存）。"""
    result = {}
    try:
        req = ecs_models.DescribeInstanceTypesRequest(
            instance_types=instance_types,
        )
        resp = await asyncio.to_thread(ecs_client.describe_instance_types, req)
        body = resp.body
        if body.instance_types and body.instance_types.instance_type:
            for spec in body.instance_types.instance_type:
                result[spec.instance_type_id or ""] = {
                    "cpu": spec.cpu_core_count or 0,
                    "memory_gb": (spec.memory_size or 0),
                }
    except Exception as e:
        logger.warning("Query instance types failed: %s", e)
    return result


async def _query_ecs_price(
    ecs_client: EcsClient,
    region_id: str,
    instance_type: str,
    period: int = 1,
) -> float:
    """查询 ECS 实时价格（月费）。
    
    针对不同区域尝试多种系统盘类型，确保海外区域（如法兰克福）兼容。
    """
    # 尝试多种系统盘类型，应对不同区域的兼容性问题
    disk_categories = ["cloud_essd", "cloud_ssd", "cloud_efficiency", "cloud", "cloud_auto"]
    
    for disk_category in disk_categories:
        try:
            req = ecs_models.DescribePriceRequest(
                region_id=region_id,
                resource_type="instance",
                instance_type=instance_type,
                price_unit="Month",
                period=period,
                system_disk=ecs_models.DescribePriceRequestSystemDisk(
                    category=disk_category,
                    size=40,
                ),
            )
            resp = await asyncio.to_thread(ecs_client.describe_price, req)
            body = resp.body
            if body.price_info and body.price_info.price:
                return body.price_info.price.trade_price or 0.0
        except Exception as e:
            error_msg = str(e)
            # 如果是系统盘类型不支持，尝试下一个类型
            if "InvalidSystemDiskCategory" in error_msg:
                continue
            # 其他错误记录日志并返回
            logger.warning("Query ECS price failed for %s: %s", instance_type, e)
            return 0.0
    
    # 所有云盘类型都失败了
    logger.warning("Query ECS price failed for %s in %s: all disk categories unsupported", instance_type, region_id)
    return 0.0


async def opt_ecs_spec_recommend(
    region_id: str = "cn-hangzhou",
    instance_ids: Optional[list[str]] = None,
    **kwargs,
) -> str:
    """ECS 具体规格推荐。

    基于 P95 CPU/内存利用率，实时查询可用规格和价格，
    给出有库存且更优性价比的目标规格。

    Args:
        region_id: 区域 ID
        instance_ids: 实例 ID 列表，为空时查询所有 Running 实例
        **kwargs: 框架注入的参数

    Returns:
        具体规格推荐列表
    """
    # === 参数解析 ===
    if isinstance(instance_ids, str):
        try:
            instance_ids = json.loads(instance_ids)
        except json.JSONDecodeError:
            instance_ids = [s.strip() for s in instance_ids.split(",") if s.strip()]
    
    credential = kwargs.get("credential") or get_credential()
    ecs_client = _build_client(credential, "ecs", region_id)
    cms_client = _build_client(credential, "cms", region_id)

    try:
        # 获取实例列表
        all_instances = []
        if instance_ids:
            for inst_id in instance_ids:
                req = ecs_models.DescribeInstancesRequest(
                    region_id=region_id,
                    instance_ids=json.dumps([inst_id]),
                )
                resp = await asyncio.to_thread(ecs_client.describe_instances, req)
                body = resp.body
                if body.instances and body.instances.instance:
                    all_instances.extend(body.instances.instance)
        else:
            page = 1
            while True:
                req = ecs_models.DescribeInstancesRequest(
                    region_id=region_id,
                    status="Running",
                    page_number=page,
                    page_size=100,
                )
                resp = await asyncio.to_thread(ecs_client.describe_instances, req)
                body = resp.body
                if body.instances and body.instances.instance:
                    all_instances.extend(body.instances.instance)
                total = body.total_count or 0
                if len(all_instances) >= total:
                    break
                page += 1

        recommendations = []
        total_saving = 0.0

        for inst in all_instances:
            inst_id = inst.instance_id or ""
            inst_name = inst.instance_name or ""
            inst_type = inst.instance_type or ""
            zone_id = inst.zone_id or ""
            env_tag = _get_tag_value(inst, "env")

            # 查询 P95 利用率
            p95_cpu = await _get_cms_metric_percentile(
                cms_client, "acs_ecs_dashboard", "CPUUtilization",
                [{"instanceId": inst_id}], days=7,
            )
            p95_mem = await _get_cms_metric_percentile(
                cms_client, "acs_ecs_dashboard", "memory_usedutilization",
                [{"instanceId": inst_id}], days=7,
            )

            # 查询当前规格配置和价格
            type_info = await _query_ecs_instance_types(ecs_client, [inst_type])
            current_info = type_info.get(inst_type, {"cpu": 0, "memory_gb": 0})
            current_price = await _query_ecs_price(ecs_client, region_id, inst_type)

            # 计算实际需要的 CPU
            max_util = max(p95_cpu, p95_mem)
            needed_cpu = max(1, int(current_info.get("cpu", 2) * (max_util / 100) * 1.3))

            # 查询可用规格（同系列）和库存概况
            available_specs, stock_summary = await _query_ecs_available_specs(
                ecs_client, region_id, zone_id, inst_type
            )

            # 查询所有可用规格的配置
            available_types = [s["instance_type"] for s in available_specs]
            all_type_info = await _query_ecs_instance_types(ecs_client, available_types)

            # 查找更优规格
            best_target = None
            best_price = current_price
            direction = "none"

            for spec in available_specs:
                target_type = spec["instance_type"]
                target_info = all_type_info.get(target_type, {})
                target_cpu = target_info.get("cpu", 0)
                
                if target_cpu < needed_cpu:
                    continue  # CPU 不足
                
                target_price = await _query_ecs_price(ecs_client, region_id, target_type)
                
                # 找最便宜且满足需求的规格
                if target_price > 0 and target_price < best_price:
                    best_target = {
                        "type": target_type,
                        "cpu": target_cpu,
                        "memory_gb": target_info.get("memory_gb", 0),
                        "price": target_price,
                    }
                    best_price = target_price
                    direction = "downsize"

            if best_target:
                saving = current_price - best_target["price"]
                total_saving += saving
                recommendations.append({
                    "instance_id": inst_id,
                    "instance_name": inst_name,
                    "zone_id": zone_id,
                    "env": env_tag,
                    "direction": direction,
                    "current": {
                        "type": inst_type,
                        "cpu": current_info.get("cpu", 0),
                        "memory_gb": current_info.get("memory_gb", 0),
                        "monthly_price": round(current_price, 2),
                    },
                    "target": {
                        "type": best_target["type"],
                        "cpu": best_target["cpu"],
                        "memory_gb": best_target["memory_gb"],
                        "monthly_price": round(best_target["price"], 2),
                        "stock_status": "Available",
                    },
                    "stock_summary": {
                        "zone_id": stock_summary["zone_id"],
                        "family": stock_summary["family"],
                        "available_count": stock_summary["available_count"],
                        "sold_out_count": stock_summary["sold_out_count"],
                        "available_specs": stock_summary["available_specs"][:5],  # 只显示前5个
                    },
                    "utilization": {
                        "p95_cpu": round(p95_cpu, 1),
                        "p95_memory": round(p95_mem, 1),
                    },
                    "monthly_saving": round(saving, 2),
                    "action": f"建议 {inst_type}({current_info.get('cpu', 0)}C{current_info.get('memory_gb', 0)}G) -> "
                              f"{best_target['type']}({best_target['cpu']}C{best_target['memory_gb']}G), "
                              f"月省{round(saving, 2)}元",
                })
            else:
                # 分析无法推荐的原因
                if stock_summary["available_count"] == 0:
                    reason = f"当前可用区 {zone_id} 该系列无库存"
                elif stock_summary["available_count"] > 0:
                    reason = "当前规格已是最优，无更便宜有库存规格"
                else:
                    reason = "当前规格匹配或无更优有库存规格"
                
                recommendations.append({
                    "instance_id": inst_id,
                    "instance_name": inst_name,
                    "zone_id": zone_id,
                    "env": env_tag,
                    "direction": "none",
                    "current": {
                        "type": inst_type,
                        "cpu": current_info.get("cpu", 0),
                        "memory_gb": current_info.get("memory_gb", 0),
                        "monthly_price": round(current_price, 2),
                    },
                    "stock_summary": {
                        "zone_id": stock_summary["zone_id"],
                        "family": stock_summary["family"],
                        "available_count": stock_summary["available_count"],
                        "sold_out_count": stock_summary["sold_out_count"],
                        "sold_out_specs": [s["type"] for s in stock_summary["sold_out_specs"][:3]],
                    },
                    "utilization": {
                        "p95_cpu": round(p95_cpu, 1),
                        "p95_memory": round(p95_mem, 1),
                    },
                    "action": reason,
                })

        downsize = [r for r in recommendations if r.get("direction") == "downsize"]

        return json.dumps({
            "success": True,
            "region": region_id,
            "total_analyzed": len(all_instances),
            "downsize_count": len(downsize),
            "total_monthly_saving_cny": round(total_saving, 2),
            "recommendations": recommendations,
        }, ensure_ascii=False, indent=2)

    except Exception as e:
        return json.dumps({
            "success": False, "error": str(e),
        }, ensure_ascii=False)


# =============================================================================
# 综合分析报告
# =============================================================================


async def opt_all_resources_analysis(
    region_id: str = "cn-hangzhou",
    days: int = 7,
    **kwargs,
) -> str:
    """综合资源分析报告。

    查询所有产品的水位，并给出具体的升降配建议。

    Args:
        region_id: 区域 ID
        days: 查询天数，默认 7
        **kwargs: 框架注入的参数

    Returns:
        综合分析报告
    """
    credential = kwargs.get("credential") or get_credential()
    ecs_client = _build_client(credential, "ecs", region_id)
    rds_client = _build_client(credential, "rds", region_id)
    redis_client = _build_client(credential, "redis", region_id)
    vpc_client = _build_client(credential, "vpc", region_id)
    slb_client = _build_client(credential, "slb", region_id)
    mongo_client = _build_client(credential, "mongodb", region_id)
    cms_client = _build_client(credential, "cms", region_id)

    report = {
        "region": region_id,
        "days": days,
        "summary": {},
        "recommendations": [],
        "details": {},
    }
    total_saving = 0.0

    # ECS 规格升降映射
    size_order = ["large", "xlarge", "2xlarge", "4xlarge", "8xlarge", "16xlarge"]

    def _get_adjacent_type(inst_type: str, direction: str) -> str | None:
        parts = inst_type.split(".")
        if len(parts) < 3:
            return None
        family = ".".join(parts[:2])
        size = parts[2]
        if size in size_order:
            idx = size_order.index(size)
            if direction == "down" and idx > 0:
                return f"{family}.{size_order[idx - 1]}"
            elif direction == "up" and idx < len(size_order) - 1:
                return f"{family}.{size_order[idx + 1]}"
        return None

    # --- ECS 分析 ---
    try:
        ecs_instances = []
        page = 1
        while True:
            req = ecs_models.DescribeInstancesRequest(
                region_id=region_id,
                status="Running",
                page_number=page,
                page_size=100,
            )
            resp = await asyncio.to_thread(ecs_client.describe_instances, req)
            body = resp.body
            if body.instances and body.instances.instance:
                ecs_instances.extend(body.instances.instance)
            total = body.total_count or 0
            if len(ecs_instances) >= total:
                break
            page += 1

        ecs_data = []
        ecs_underutil = 0
        ecs_overutil = 0

        for inst in ecs_instances:
            inst_id = inst.instance_id or ""
            inst_name = inst.instance_name or ""
            inst_type = inst.instance_type or ""

            avg_cpu = await _get_cms_metric_avg(
                cms_client, "acs_ecs_dashboard", "CPUUtilization",
                [{"instanceId": inst_id}], days=days,
            )
            avg_mem = await _get_cms_metric_avg(
                cms_client, "acs_ecs_dashboard", "memory_usedutilization",
                [{"instanceId": inst_id}], days=days,
            )
            p95_cpu = await _get_cms_metric_percentile(
                cms_client, "acs_ecs_dashboard", "CPUUtilization",
                [{"instanceId": inst_id}], days=days,
            )

            status = "normal"
            recommendation = None
            
            if p95_cpu < 20 and avg_mem < 20:
                status = "underutilized"
                ecs_underutil += 1
                current_cost = _estimate_monthly_cost(inst_type, inst.instance_charge_type or "")
                target_type = _get_adjacent_type(inst_type, "down")
                if target_type:
                    target_cost = _estimate_monthly_cost(target_type, inst.instance_charge_type or "")
                    saving = current_cost - target_cost
                else:
                    target_type = "无更小规格可用"
                    target_cost = current_cost
                    saving = 0
                total_saving += saving
                recommendation = {
                    "product": "ECS",
                    "instance_id": inst_id,
                    "instance_name": inst_name,
                    "direction": "downsize",
                    "current_spec": inst_type,
                    "target_spec": target_type,
                    "current_monthly_cost": round(current_cost, 2),
                    "target_monthly_cost": round(target_cost, 2),
                    "monthly_saving": round(saving, 2),
                    "utilization": {
                        "p95_cpu": round(p95_cpu, 1),
                        "avg_memory": round(avg_mem, 1),
                    },
                    "reason": f"P95 CPU {round(p95_cpu, 1)}%，内存 {round(avg_mem, 1)}%，利用率过低",
                    "action": f"建议从 {inst_type} 降配到 {target_type}，月费从 {round(current_cost, 0)}元 → {round(target_cost, 0)}元，月省 {round(saving, 0)}元",
                }
            elif p95_cpu > 80 or avg_mem > 80:
                status = "overutilized"
                ecs_overutil += 1
                current_cost = _estimate_monthly_cost(inst_type, inst.instance_charge_type or "")
                target_type = _get_adjacent_type(inst_type, "up")
                if target_type:
                    target_cost = _estimate_monthly_cost(target_type, inst.instance_charge_type or "")
                    extra_cost = target_cost - current_cost
                else:
                    target_type = "无更大规格可用"
                    target_cost = current_cost
                    extra_cost = 0
                recommendation = {
                    "product": "ECS",
                    "instance_id": inst_id,
                    "instance_name": inst_name,
                    "direction": "upsize",
                    "current_spec": inst_type,
                    "target_spec": target_type,
                    "current_monthly_cost": round(current_cost, 2),
                    "target_monthly_cost": round(target_cost, 2),
                    "extra_monthly_cost": round(extra_cost, 2),
                    "utilization": {
                        "p95_cpu": round(p95_cpu, 1),
                        "avg_memory": round(avg_mem, 1),
                    },
                    "reason": f"P95 CPU {round(p95_cpu, 1)}%，利用率过高",
                    "action": f"建议从 {inst_type} 升配到 {target_type}，月费从 {round(current_cost, 0)}元 → {round(target_cost, 0)}元，避免性能瓶颈",
                    "monthly_saving": 0,
                }

            ecs_data.append({
                "instance_id": inst_id,
                "instance_name": inst_name,
                "instance_type": inst_type,
                f"avg_cpu_{days}d": round(avg_cpu, 1),
                f"p95_cpu_{days}d": round(p95_cpu, 1),
                f"avg_memory_{days}d": round(avg_mem, 1),
                "status": status,
            })

            if recommendation:
                report["recommendations"].append(recommendation)

        report["summary"]["ecs"] = {
            "total": len(ecs_instances),
            "underutilized": ecs_underutil,
            "overutilized": ecs_overutil,
            "normal": len(ecs_instances) - ecs_underutil - ecs_overutil,
        }
        report["details"]["ecs"] = ecs_data

    except Exception as e:
        report["details"]["ecs_error"] = str(e)

    # --- RDS 分析 ---
    try:
        rds_instances = []
        page = 1
        while True:
            req = rds_models.DescribeDBInstancesRequest(
                region_id=region_id,
                page_number=page,
                page_size=100,
            )
            resp = await asyncio.to_thread(rds_client.describe_dbinstances, req)
            body = resp.body
            items = body.items
            instances = items.dbinstance if items and hasattr(items, "dbinstance") and items.dbinstance else []
            rds_instances.extend(instances)
            total = body.total_record_count or 0
            if len(rds_instances) >= total:
                break
            page += 1

        rds_data = []
        rds_underutil = 0

        for inst in rds_instances:
            inst_id = inst.dbinstance_id if hasattr(inst, "dbinstance_id") else ""
            inst_class = inst.dbinstance_class if hasattr(inst, "dbinstance_class") else ""
            status_db = inst.dbinstance_status if hasattr(inst, "dbinstance_status") else ""

            if status_db != "Running":
                continue

            avg_cpu = await _get_cms_metric_avg(
                cms_client, "acs_rds_dashboard", "CpuUsage",
                [{"instanceId": inst_id}], days=days,
            )
            avg_conn = await _get_cms_metric_avg(
                cms_client, "acs_rds_dashboard", "ConnectionUsage",
                [{"instanceId": inst_id}], days=days,
            )

            status = "normal"
            if avg_cpu < 10 and avg_conn < 10:
                status = "underutilized"
                rds_underutil += 1
                # RDS 规格估价：根据 CPU 核数估算
                current_cpu = _parse_rds_cpu(inst_class)
                current_cost = current_cpu * 150  # 约 150元/核/月
                target_cpu = max(1, current_cpu // 2)
                target_cost = target_cpu * 150
                saving = current_cost - target_cost
                total_saving += saving
                report["recommendations"].append({
                    "product": "RDS",
                    "instance_id": inst_id,
                    "direction": "downsize",
                    "current_spec": inst_class,
                    "current_cpu": current_cpu,
                    "target_cpu": target_cpu,
                    "current_monthly_cost": round(current_cost, 2),
                    "target_monthly_cost": round(target_cost, 2),
                    "monthly_saving": round(saving, 2),
                    "utilization": {
                        "avg_cpu": round(avg_cpu, 1),
                        "avg_connection": round(avg_conn, 1),
                    },
                    "reason": f"CPU {round(avg_cpu, 1)}%，连接数 {round(avg_conn, 1)}%，利用率过低",
                    "action": f"建议从 {current_cpu}核 降配到 {target_cpu}核，月费从 {round(current_cost, 0)}元 → {round(target_cost, 0)}元，月省 {round(saving, 0)}元",
                })

            rds_data.append({
                "instance_id": inst_id,
                "instance_class": inst_class,
                f"avg_cpu_{days}d": round(avg_cpu, 1),
                f"avg_connection_{days}d": round(avg_conn, 1),
                "status": status,
            })

        report["summary"]["rds"] = {
            "total": len(rds_data),
            "underutilized": rds_underutil,
        }
        report["details"]["rds"] = rds_data

    except Exception as e:
        report["details"]["rds_error"] = str(e)

    # --- EIP 分析 ---
    try:
        all_eips = []
        page = 1
        while True:
            req = vpc_models.DescribeEipAddressesRequest(
                region_id=region_id,
                page_number=page,
                page_size=50,
            )
            resp = await asyncio.to_thread(vpc_client.describe_eip_addresses, req)
            body = resp.body
            if body.eip_addresses and body.eip_addresses.eip_address:
                all_eips.extend(body.eip_addresses.eip_address)
            total = body.total_count or 0
            if len(all_eips) >= total:
                break
            page += 1

        eip_data = []
        eip_idle = 0
        eip_underutil = 0

        for eip in all_eips:
            eip_id = eip.allocation_id or ""
            ip_addr = eip.ip_address or ""
            status_eip = eip.status or ""
            bandwidth = _safe_int(eip.bandwidth or "0")

            status = "normal"
            if status_eip != "InUse":
                status = "idle"
                eip_idle += 1
                saving = bandwidth * 20  # 估算
                total_saving += saving
                report["recommendations"].append({
                    "product": "EIP",
                    "instance_id": eip_id,
                    "ip_address": ip_addr,
                    "direction": "release",
                    "reason": "未绑定任何实例，处于闲置状态",
                    "action": f"建议释放，预估月省 {saving} 元",
                    "monthly_saving": saving,
                })
            else:
                avg_rx = await _get_cms_metric_avg(
                    cms_client, "acs_vpc_eip", "net_rx.rate",
                    [{"instanceId": eip_id}], days=days,
                )
                avg_tx = await _get_cms_metric_avg(
                    cms_client, "acs_vpc_eip", "net_tx.rate",
                    [{"instanceId": eip_id}], days=days,
                )
                max_bw_bps = bandwidth * 1024 * 1024 if bandwidth > 0 else 1
                max_util = max((avg_rx / max_bw_bps) * 100, (avg_tx / max_bw_bps) * 100)
                
                if max_util < 5:
                    status = "underutilized"
                    eip_underutil += 1

            eip_data.append({
                "eip_id": eip_id,
                "ip_address": ip_addr,
                "bandwidth_mb": bandwidth,
                "bindwidth_status": status_eip,
                "status": status,
            })

        report["summary"]["eip"] = {
            "total": len(all_eips),
            "idle": eip_idle,
            "underutilized": eip_underutil,
        }
        report["details"]["eip"] = eip_data

    except Exception as e:
        report["details"]["eip_error"] = str(e)

    # --- Redis 分析 ---
    try:
        redis_instances = []
        page = 1
        while True:
            req = redis_models.DescribeInstancesRequest(
                region_id=region_id,
                page_number=page,
                page_size=50,
            )
            resp = await asyncio.to_thread(redis_client.describe_instances, req)
            body = resp.body
            if body.instances and body.instances.kvstore_instance:
                redis_instances.extend(body.instances.kvstore_instance)
            total = body.total_count or 0
            if len(redis_instances) >= total:
                break
            page += 1

        redis_data = []
        redis_underutil = 0

        for inst in redis_instances:
            inst_id = inst.instance_id or ""
            inst_name = inst.instance_name or ""
            inst_class = inst.instance_class or ""
            status_redis = inst.instance_status or ""

            if status_redis != "Normal":
                continue

            avg_cpu = await _get_cms_metric_avg(
                cms_client, "acs_kvstore", "CpuUsage",
                [{"instanceId": inst_id}], days=days,
            )
            avg_mem = await _get_cms_metric_avg(
                cms_client, "acs_kvstore", "MemoryUsage",
                [{"instanceId": inst_id}], days=days,
            )

            status = "normal"
            if avg_cpu < 10 and avg_mem < 30:
                status = "underutilized"
                redis_underutil += 1
                saving = 100  # 估算
                total_saving += saving
                report["recommendations"].append({
                    "product": "Redis",
                    "instance_id": inst_id,
                    "instance_name": inst_name,
                    "current_spec": inst_class,
                    "direction": "downsize",
                    "reason": f"CPU {round(avg_cpu, 1)}%，内存 {round(avg_mem, 1)}%，利用率过低",
                    "action": f"建议降配，预估月省 {saving} 元",
                    "monthly_saving": saving,
                })

            redis_data.append({
                "instance_id": inst_id,
                "instance_name": inst_name,
                "instance_class": inst_class,
                f"avg_cpu_{days}d": round(avg_cpu, 1),
                f"avg_memory_{days}d": round(avg_mem, 1),
                "status": status,
            })

        report["summary"]["redis"] = {
            "total": len(redis_data),
            "underutilized": redis_underutil,
        }
        report["details"]["redis"] = redis_data

    except Exception as e:
        import traceback
        report["details"]["redis_error"] = f"{type(e).__name__}: {str(e)}"
        report["summary"]["redis"] = {"total": 0, "error": f"{type(e).__name__}: {str(e)}"}

    # --- CLB 分析 ---
    try:
        slb_instances = []
        page = 1
        while True:
            req = slb_models.DescribeLoadBalancersRequest(
                region_id=region_id,
                page_number=page,
                page_size=50,
            )
            resp = await asyncio.to_thread(slb_client.describe_load_balancers, req)
            body = resp.body
            if body.load_balancers and body.load_balancers.load_balancer:
                slb_instances.extend(body.load_balancers.load_balancer)
            total = body.total_count or 0
            if len(slb_instances) >= total:
                break
            page += 1

        clb_data = []
        clb_idle = 0

        for lb in slb_instances:
            lb_id = lb.load_balancer_id or ""
            lb_name = lb.load_balancer_name or ""
            lb_status = lb.load_balancer_status or ""

            avg_conn = await _get_cms_metric_avg(
                cms_client, "acs_slb_dashboard", "ActiveConnection",
                [{"instanceId": lb_id}], days=days,
            )
            avg_qps = await _get_cms_metric_avg(
                cms_client, "acs_slb_dashboard", "Qps",
                [{"instanceId": lb_id}], days=days,
            )

            status = "normal"
            if avg_conn < 5 and avg_qps < 1:
                status = "idle"
                clb_idle += 1
                saving = 50  # 估算
                total_saving += saving
                report["recommendations"].append({
                    "product": "CLB",
                    "instance_id": lb_id,
                    "instance_name": lb_name,
                    "direction": "release",
                    "reason": f"平均连接数 {round(avg_conn, 1)}，QPS {round(avg_qps, 1)}，基本无流量",
                    "action": f"建议释放，预估月省 {saving} 元",
                    "monthly_saving": saving,
                })

            clb_data.append({
                "lb_id": lb_id,
                "lb_name": lb_name,
                f"avg_connection_{days}d": round(avg_conn, 1),
                f"avg_qps_{days}d": round(avg_qps, 1),
                "status": status,
            })

        report["summary"]["clb"] = {
            "total": len(clb_data),
            "idle": clb_idle,
        }
        report["details"]["clb"] = clb_data

    except Exception as e:
        report["details"]["clb_error"] = str(e)

    # 汇总
    report["total_potential_monthly_saving"] = round(total_saving, 2)
    report["success"] = True

    # === 直接生成 Markdown 报告 ===
    md_lines = []
    md_lines.append(f"# 阿里云资源水位分析与优化建议报告（近{days}天）")
    md_lines.append("")
    md_lines.append(f"> 生成时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    md_lines.append(f"> 区域: {region_id}")
    md_lines.append("")

    # 概览
    md_lines.append("## 概览")
    md_lines.append("")
    md_lines.append("| 指标 | 数值 |")
    md_lines.append("|------|------|")
    
    if "ecs" in report["summary"]:
        ecs_sum = report["summary"]["ecs"]
        md_lines.append(f"| ECS 实例总数 | {ecs_sum.get('total', 0)} 个 |")
        md_lines.append(f"| ECS 低利用率 | {ecs_sum.get('underutilized', 0)} 个 |")
    if "rds" in report["summary"]:
        rds_sum = report["summary"]["rds"]
        md_lines.append(f"| RDS 实例总数 | {rds_sum.get('total', 0)} 个 |")
        md_lines.append(f"| RDS 低利用率 | {rds_sum.get('underutilized', 0)} 个 |")
    if "eip" in report["summary"]:
        eip_sum = report["summary"]["eip"]
        md_lines.append(f"| EIP 总数 | {eip_sum.get('total', 0)} 个 |")
        md_lines.append(f"| EIP 闲置 | {eip_sum.get('idle', 0)} 个 |")
    if "redis" in report["summary"]:
        redis_sum = report["summary"]["redis"]
        md_lines.append(f"| Redis 总数 | {redis_sum.get('total', 0)} 个 |")
    if "clb" in report["summary"]:
        clb_sum = report["summary"]["clb"]
        md_lines.append(f"| CLB 总数 | {clb_sum.get('total', 0)} 个 |")
    
    md_lines.append(f"| **预估月节省** | **{round(total_saving, 0)} 元** |")
    md_lines.append("")

    # 优化建议
    recommendations = report.get("recommendations", [])
    if recommendations:
        md_lines.append("## 优化建议")
        md_lines.append("")
        
        # 按产品分组
        by_product = {}
        for rec in recommendations:
            product = rec.get("product", "未知")
            by_product.setdefault(product, []).append(rec)
        
        for product, recs in by_product.items():
            md_lines.append(f"### {product}")
            md_lines.append("")
            md_lines.append("| 实例 ID | 实例名称 | 当前规格 | 目标规格 | 当前月费 | 目标月费 | 月节省 | 操作 |")
            md_lines.append("|----------|----------|----------|----------|----------|----------|--------|------|")
            
            for rec in recs:
                inst_id = rec.get("instance_id", "-")
                inst_name = rec.get("instance_name", "-") or "-"
                current_spec = rec.get("current_spec", "-")
                target_spec = rec.get("target_spec", "-")
                current_cost = rec.get("current_monthly_cost", 0)
                target_cost = rec.get("target_monthly_cost", 0)
                saving = rec.get("monthly_saving", 0)
                direction = rec.get("direction", "")
                
                if direction == "downsize":
                    action = "⬇️ 降配"
                elif direction == "upsize":
                    action = "⬆️ 升配"
                elif direction == "release":
                    action = "🗑️ 释放"
                else:
                    action = "-"
                
                md_lines.append(f"| {inst_id} | {inst_name} | {current_spec} | {target_spec} | {current_cost:.0f}元 | {target_cost:.0f}元 | {saving:.0f}元 | {action} |")
            
            md_lines.append("")
        
        # 详细说明
        md_lines.append("### 详细说明")
        md_lines.append("")
        for i, rec in enumerate(recommendations, 1):
            inst_id = rec.get("instance_id", "-")
            inst_name = rec.get("instance_name", "")
            reason = rec.get("reason", "")
            action_desc = rec.get("action", "")
            
            name_str = f" ({inst_name})" if inst_name else ""
            md_lines.append(f"**{i}. {inst_id}{name_str}**")
            md_lines.append("")
            md_lines.append(f"- 原因: {reason}")
            md_lines.append(f"- 建议: {action_desc}")
            md_lines.append("")
    else:
        md_lines.append("## 优化建议")
        md_lines.append("")
        md_lines.append("暂无优化建议，所有资源利用率正常。")
        md_lines.append("")

    # 错误信息
    errors = []
    for key, val in report.get("details", {}).items():
        if key.endswith("_error"):
            product = key.replace("_error", "").upper()
            errors.append(f"- {product}: {val}")
    
    if errors:
        md_lines.append("## 注意")
        md_lines.append("")
        md_lines.append("以下产品查询失败：")
        md_lines.append("")
        md_lines.extend(errors)
        md_lines.append("")

    md_lines.append("---")
    md_lines.append("")
    md_lines.append("状态说明: 低利用率 = P95 CPU < 20% 且 内存 < 20%")

    return "\n".join(md_lines)


# =============================================================================
# Redis / EIP / CLB / MongoDB 利用率报告
# =============================================================================


async def opt_redis_utilization_report(
    region_id: str = "cn-hangzhou",
    days: int = 7,
    **kwargs,
) -> str:
    """Redis 利用率报告。

    查询所有 Redis 实例的 CPU、内存、连接数、QPS 利用率。

    Args:
        region_id: 区域 ID
        days: 查询天数，默认 7
        **kwargs: 框架注入的参数

    Returns:
        Redis 利用率报告
    """
    credential = kwargs.get("credential") or get_credential()
    redis_client = _build_client(credential, "redis", region_id)
    cms_client = _build_client(credential, "cms", region_id)

    try:
        all_instances = []
        page = 1
        while True:
            req = redis_models.DescribeInstancesRequest(
                region_id=region_id,
                page_number=page,
                page_size=50,
            )
            resp = await asyncio.to_thread(redis_client.describe_instances, req)
            body = resp.body
            if body.instances and body.instances.kvstore_instance:
                all_instances.extend(body.instances.kvstore_instance)
            total = body.total_count or 0
            if len(all_instances) >= total:
                break
            page += 1

        utilization_data = []

        for inst in all_instances:
            inst_id = inst.instance_id or ""
            status = inst.instance_status or ""

            if status != "Normal":
                continue

            avg_cpu = await _get_cms_metric_avg(
                cms_client, "acs_kvstore", "CpuUsage",
                [{"instanceId": inst_id}], days=days,
            )
            avg_mem = await _get_cms_metric_avg(
                cms_client, "acs_kvstore", "MemoryUsage",
                [{"instanceId": inst_id}], days=days,
            )
            avg_conn = await _get_cms_metric_avg(
                cms_client, "acs_kvstore", "ConnectionUsage",
                [{"instanceId": inst_id}], days=days,
            )
            avg_qps = await _get_cms_metric_avg(
                cms_client, "acs_kvstore", "UsedQPS",
                [{"instanceId": inst_id}], days=days,
            )

            status_tag = "normal"
            if avg_cpu < 10 and avg_mem < 30 and avg_conn < 10:
                status_tag = "underutilized"
            elif avg_cpu > 80 or avg_mem > 80:
                status_tag = "overutilized"

            utilization_data.append({
                "instance_id": inst_id,
                "instance_name": inst.instance_name or "",
                "instance_class": inst.instance_class or "",
                "capacity_mb": inst.capacity or 0,
                f"avg_cpu_{days}d": round(avg_cpu, 1),
                f"avg_memory_{days}d": round(avg_mem, 1),
                f"avg_connection_{days}d": round(avg_conn, 1),
                f"avg_qps_{days}d": round(avg_qps, 1),
                "status": status_tag,
            })

        underutilized = [d for d in utilization_data if d["status"] == "underutilized"]
        overutilized = [d for d in utilization_data if d["status"] == "overutilized"]

        return json.dumps({
            "success": True,
            "region": region_id,
            "days": days,
            "total_instances": len(utilization_data),
            "underutilized_count": len(underutilized),
            "overutilized_count": len(overutilized),
            "instances": utilization_data,
        }, ensure_ascii=False, indent=2)

    except Exception as e:
        return json.dumps({
            "success": False, "error": str(e),
        }, ensure_ascii=False)


async def opt_eip_utilization_report(
    region_id: str = "cn-hangzhou",
    days: int = 7,
    **kwargs,
) -> str:
    """EIP 利用率报告。

    查询所有 EIP 的带宽使用情况，检测闲置和低利用率 EIP。

    Args:
        region_id: 区域 ID
        days: 查询天数，默认 7
        **kwargs: 框架注入的参数

    Returns:
        EIP 利用率报告
    """
    days = _validate_days(days, default=7)
    
    credential = kwargs.get("credential") or get_credential()
    vpc_client = _build_client(credential, "vpc", region_id)
    cms_client = _build_client(credential, "cms", region_id)

    try:
        all_eips = []
        page = 1
        while True:
            req = vpc_models.DescribeEipAddressesRequest(
                region_id=region_id,
                page_number=page,
                page_size=50,
            )
            resp = await asyncio.to_thread(vpc_client.describe_eip_addresses, req)
            body = resp.body
            if body.eip_addresses and body.eip_addresses.eip_address:
                all_eips.extend(body.eip_addresses.eip_address)
            total = body.total_count or 0
            if len(all_eips) >= total:
                break
            page += 1

        utilization_data = []

        for eip in all_eips:
            eip_id = eip.allocation_id or ""
            ip_address = eip.ip_address or ""
            status = eip.status or ""
            bandwidth = eip.bandwidth or "0"
            bandwidth_mb = _safe_int(bandwidth)

            avg_rx = await _get_cms_metric_avg(
                cms_client, "acs_vpc_eip", "net_rx.rate",
                [{"instanceId": eip_id}], days=days,
            )
            avg_tx = await _get_cms_metric_avg(
                cms_client, "acs_vpc_eip", "net_tx.rate",
                [{"instanceId": eip_id}], days=days,
            )

            max_bw_bps = bandwidth_mb * 1024 * 1024 if bandwidth_mb > 0 else 1
            rx_util = (avg_rx / max_bw_bps) * 100 if max_bw_bps > 0 else 0
            tx_util = (avg_tx / max_bw_bps) * 100 if max_bw_bps > 0 else 0
            max_util = max(rx_util, tx_util)

            status_tag = "normal"
            if status != "InUse":
                status_tag = "idle"
            elif max_util < 5:
                status_tag = "underutilized"
            elif max_util > 80:
                status_tag = "overutilized"

            utilization_data.append({
                "eip_id": eip_id,
                "ip_address": ip_address,
                "bandwidth_mb": bandwidth_mb,
                "bindwidth_status": status,
                "bindwidth_instance": eip.instance_id or "(unbindwidth)",
                f"avg_rx_rate_{days}d_bps": round(avg_rx, 2),
                f"avg_tx_rate_{days}d_bps": round(avg_tx, 2),
                f"rx_utilization_{days}d": round(rx_util, 1),
                f"tx_utilization_{days}d": round(tx_util, 1),
                "status": status_tag,
            })

        idle = [d for d in utilization_data if d["status"] == "idle"]
        underutilized = [d for d in utilization_data if d["status"] == "underutilized"]

        return json.dumps({
            "success": True,
            "region": region_id,
            "days": days,
            "total_eips": len(utilization_data),
            "idle_count": len(idle),
            "underutilized_count": len(underutilized),
            "eips": utilization_data,
        }, ensure_ascii=False, indent=2)

    except Exception as e:
        return json.dumps({
            "success": False, "error": str(e),
        }, ensure_ascii=False)


async def opt_clb_utilization_report(
    region_id: str = "cn-hangzhou",
    days: int = 7,
    **kwargs,
) -> str:
    """CLB 利用率报告。

    查询所有 CLB 的连接数、流量使用情况。

    Args:
        region_id: 区域 ID
        days: 查询天数，默认 7
        **kwargs: 框架注入的参数

    Returns:
        CLB 利用率报告
    """
    days = _validate_days(days, default=7)
    
    credential = kwargs.get("credential") or get_credential()
    slb_client = _build_client(credential, "slb", region_id)
    cms_client = _build_client(credential, "cms", region_id)

    try:
        all_slbs = []
        page = 1
        while True:
            req = slb_models.DescribeLoadBalancersRequest(
                region_id=region_id,
                page_number=page,
                page_size=50,
            )
            resp = await asyncio.to_thread(slb_client.describe_load_balancers, req)
            body = resp.body
            if body.load_balancers and body.load_balancers.load_balancer:
                all_slbs.extend(body.load_balancers.load_balancer)
            total = body.total_count or 0
            if len(all_slbs) >= total:
                break
            page += 1

        utilization_data = []

        for slb in all_slbs:
            slb_id = slb.load_balancer_id or ""
            status = slb.load_balancer_status or ""

            if status != "active":
                continue

            avg_conn = await _get_cms_metric_avg(
                cms_client, "acs_slb_dashboard", "ActiveConnection",
                [{"instanceId": slb_id}], days=days,
            )
            avg_rx = await _get_cms_metric_avg(
                cms_client, "acs_slb_dashboard", "TrafficRXNew",
                [{"instanceId": slb_id}], days=days,
            )
            avg_tx = await _get_cms_metric_avg(
                cms_client, "acs_slb_dashboard", "TrafficTXNew",
                [{"instanceId": slb_id}], days=days,
            )
            avg_qps = await _get_cms_metric_avg(
                cms_client, "acs_slb_dashboard", "Qps",
                [{"instanceId": slb_id}], days=days,
            )

            status_tag = "normal"
            if avg_conn < 10 and avg_qps < 10:
                status_tag = "underutilized"

            utilization_data.append({
                "slb_id": slb_id,
                "slb_name": slb.load_balancer_name or "",
                "address_type": slb.address_type or "",
                "pay_type": slb.pay_type or "",
                f"avg_active_conn_{days}d": round(avg_conn, 1),
                f"avg_traffic_rx_{days}d_bytes": round(avg_rx, 2),
                f"avg_traffic_tx_{days}d_bytes": round(avg_tx, 2),
                f"avg_qps_{days}d": round(avg_qps, 1),
                "status": status_tag,
            })

        underutilized = [d for d in utilization_data if d["status"] == "underutilized"]

        return json.dumps({
            "success": True,
            "region": region_id,
            "days": days,
            "total_slbs": len(utilization_data),
            "underutilized_count": len(underutilized),
            "slbs": utilization_data,
        }, ensure_ascii=False, indent=2)

    except Exception as e:
        return json.dumps({
            "success": False, "error": str(e),
        }, ensure_ascii=False)


async def opt_mongodb_utilization_report(
    region_id: str = "cn-hangzhou",
    days: int = 7,
    **kwargs,
) -> str:
    """MongoDB 利用率报告。

    查询所有 MongoDB 实例的 CPU、内存、磁盘、连接数利用率。

    Args:
        region_id: 区域 ID
        days: 查询天数，默认 7
        **kwargs: 框架注入的参数

    Returns:
        MongoDB 利用率报告
    """
    credential = kwargs.get("credential") or get_credential()
    mongo_client = _build_client(credential, "mongodb", region_id)
    cms_client = _build_client(credential, "cms", region_id)

    try:
        all_instances = []
        page = 1
        while True:
            req = mongo_models.DescribeDBInstancesRequest(
                region_id=region_id,
                page_number=page,
                page_size=30,
            )
            resp = await asyncio.to_thread(mongo_client.describe_dbinstances, req)
            body = resp.body
            if body.dbinstances and body.dbinstances.dbinstance:
                all_instances.extend(body.dbinstances.dbinstance)
            total = body.total_count or 0
            if len(all_instances) >= total:
                break
            page += 1

        utilization_data = []

        for inst in all_instances:
            inst_id = inst.dbinstance_id or ""
            status = inst.dbinstance_status or ""

            if status != "Running":
                continue

            avg_cpu = await _get_cms_metric_avg(
                cms_client, "acs_mongodb", "CPUUtilization",
                [{"instanceId": inst_id, "role": "Primary"}], days=days,
            )
            avg_mem = await _get_cms_metric_avg(
                cms_client, "acs_mongodb", "MemoryUtilization",
                [{"instanceId": inst_id, "role": "Primary"}], days=days,
            )
            avg_disk = await _get_cms_metric_avg(
                cms_client, "acs_mongodb", "DiskUtilization",
                [{"instanceId": inst_id, "role": "Primary"}], days=days,
            )
            avg_conn = await _get_cms_metric_avg(
                cms_client, "acs_mongodb", "ConnectionsInUse",
                [{"instanceId": inst_id, "role": "Primary"}], days=days,
            )

            status_tag = "normal"
            if avg_cpu < 10 and avg_mem < 30 and avg_conn < 10:
                status_tag = "underutilized"
            elif avg_cpu > 80 or avg_mem > 80 or avg_disk > 80:
                status_tag = "overutilized"

            utilization_data.append({
                "instance_id": inst_id,
                "instance_desc": inst.dbinstance_description or "",
                "instance_class": inst.dbinstance_class or "",
                "engine_version": inst.engine_version or "",
                f"avg_cpu_{days}d": round(avg_cpu, 1),
                f"avg_memory_{days}d": round(avg_mem, 1),
                f"avg_disk_{days}d": round(avg_disk, 1),
                f"avg_connections_{days}d": round(avg_conn, 1),
                "status": status_tag,
            })

        underutilized = [d for d in utilization_data if d["status"] == "underutilized"]
        overutilized = [d for d in utilization_data if d["status"] == "overutilized"]

        return json.dumps({
            "success": True,
            "region": region_id,
            "days": days,
            "total_instances": len(utilization_data),
            "underutilized_count": len(underutilized),
            "overutilized_count": len(overutilized),
            "instances": utilization_data,
        }, ensure_ascii=False, indent=2)

    except Exception as e:
        return json.dumps({
            "success": False, "error": str(e),
        }, ensure_ascii=False)


async def _query_rds_available_classes(
    rds_client: RdsClient,
    region_id: str,
    zone_id: str,
    engine: str,
    engine_version: str,
    current_class: str,
    category: str = "HighAvailability",
) -> list[dict]:
    """查询 RDS 可用规格（实时 API）。
    
    Args:
        category: 实例类型（Basic/HighAvailability/cluster/AlwaysOn/Finance）
    """
    try:
        req = rds_models.DescribeAvailableClassesRequest(
            region_id=region_id,
            zone_id=zone_id,
            engine=engine,
            engine_version=engine_version,
            dbinstance_storage_type="cloud_essd",
            instance_charge_type="PostPaid",
            category=category,
        )
        resp = await asyncio.to_thread(rds_client.describe_available_classes, req)
        body = resp.body
        
        available_classes = []
        if body.dbinstance_classes and body.dbinstance_classes.dbinstance_class:
            for cls in body.dbinstance_classes.dbinstance_class:
                class_code = cls.dbinstance_class or ""
                cpu = cls.cpu or "0"
                memory = cls.max_connections  # 注意：RDS API 返回的是 max_connections，需要另外获取内存
                available_classes.append({
                    "class_code": class_code,
                    "cpu": _safe_int(cpu),
                    "reference_price": cls.reference_price or "0",
                })
        return available_classes
    except Exception as e:
        logger.warning("Query RDS available classes failed: %s", e)
        return []


async def opt_rds_spec_recommend(
    region_id: str = "cn-hangzhou",
    instance_ids: Optional[list[str]] = None,
    **kwargs,
) -> str:
    """RDS 具体规格推荐。

    基于 P95 CPU/连接数利用率，实时查询可用规格，
    给出更优性价比的目标规格。

    Args:
        region_id: 区域 ID
        instance_ids: 实例 ID 列表，为空时查询所有 Running 实例
        **kwargs: 框架注入的参数

    Returns:
        具体规格推荐列表
    """
    # === 参数解析 ===
    if isinstance(instance_ids, str):
        try:
            instance_ids = json.loads(instance_ids)
        except json.JSONDecodeError:
            instance_ids = [s.strip() for s in instance_ids.split(",") if s.strip()]
    
    credential = kwargs.get("credential") or get_credential()
    rds_client = _build_client(credential, "rds", region_id)
    cms_client = _build_client(credential, "cms", region_id)

    try:
        # 获取实例列表
        all_instances = []
        if instance_ids:
            for inst_id in instance_ids:
                req = rds_models.DescribeDBInstancesRequest(
                    region_id=region_id,
                    dbinstance_id=inst_id,
                )
                resp = await asyncio.to_thread(rds_client.describe_dbinstances, req)
                body = resp.body
                items = body.items
                if items and hasattr(items, "dbinstance") and items.dbinstance:
                    all_instances.extend(items.dbinstance)
        else:
            page = 1
            while True:
                req = rds_models.DescribeDBInstancesRequest(
                    region_id=region_id,
                    page_number=page,
                    page_size=100,
                )
                resp = await asyncio.to_thread(rds_client.describe_dbinstances, req)
                body = resp.body
                items = body.items
                instances = items.dbinstance if items and hasattr(items, "dbinstance") and items.dbinstance else []
                all_instances.extend(instances)
                total = body.total_record_count or 0
                if len(all_instances) >= total:
                    break
                page += 1

        recommendations = []
        total_saving = 0.0

        for inst in all_instances:
            inst_id = inst.dbinstance_id if hasattr(inst, "dbinstance_id") else ""
            inst_desc = inst.dbinstance_description if hasattr(inst, "dbinstance_description") else ""
            inst_class = inst.dbinstance_class if hasattr(inst, "dbinstance_class") else ""
            engine = inst.engine if hasattr(inst, "engine") else "mysql"
            engine_version = inst.engine_version if hasattr(inst, "engine_version") else "8.0"
            zone_id = inst.zone_id if hasattr(inst, "zone_id") else ""
            status = inst.dbinstance_status if hasattr(inst, "dbinstance_status") else ""
            # 获取实例类型（Basic/HighAvailability/cluster/AlwaysOn/Finance）
            category = inst.category if hasattr(inst, "category") else "HighAvailability"
            
            if status != "Running":
                continue

            # 查询 P95 利用率
            p95_cpu = await _get_cms_metric_percentile(
                cms_client, "acs_rds_dashboard", "CpuUsage",
                [{"instanceId": inst_id}], days=7,
            )
            p95_conn = await _get_cms_metric_percentile(
                cms_client, "acs_rds_dashboard", "ConnectionUsage",
                [{"instanceId": inst_id}], days=7,
            )

            # 查询可用规格
            available_classes = await _query_rds_available_classes(
                rds_client, region_id, zone_id, engine, engine_version, inst_class, category
            )

            # 计算需要的 CPU
            max_util = max(p95_cpu, p95_conn)
            # 从当前规格名推断 CPU（简化处理）
            current_cpu = 2
            if "xlarge" in inst_class:
                current_cpu = 8
            elif "large" in inst_class:
                current_cpu = 4
            elif "medium" in inst_class:
                current_cpu = 2
            elif "small" in inst_class:
                current_cpu = 1
            
            needed_cpu = max(1, int(current_cpu * (max_util / 100) * 1.3))

            # 查找更优规格
            best_target = None
            current_price = 0.0
            
            # 获取当前规格的参考价
            for cls in available_classes:
                if cls["class_code"] == inst_class:
                    current_price = _safe_float(cls.get("reference_price", 0))
                    break
            
            if current_price == 0:
                current_price = current_cpu * 200  # 估算
            
            best_price = current_price

            for cls in available_classes:
                target_class = cls["class_code"]
                target_cpu = cls.get("cpu", 0)
                target_price = _safe_float(cls.get("reference_price", 0))
                
                if target_cpu < needed_cpu:
                    continue
                
                if target_price > 0 and target_price < best_price:
                    best_target = {
                        "class_code": target_class,
                        "cpu": target_cpu,
                        "price": target_price,
                    }
                    best_price = target_price

            if best_target and best_target["class_code"] != inst_class:
                saving = current_price - best_target["price"]
                total_saving += saving
                recommendations.append({
                    "instance_id": inst_id,
                    "instance_desc": inst_desc,
                    "engine": engine,
                    "zone_id": zone_id,
                    "direction": "downsize",
                    "current": {
                        "class": inst_class,
                        "cpu": current_cpu,
                        "monthly_price": round(current_price, 2),
                    },
                    "target": {
                        "class": best_target["class_code"],
                        "cpu": best_target["cpu"],
                        "monthly_price": round(best_target["price"], 2),
                        "stock_status": "Available",
                    },
                    "utilization": {
                        "p95_cpu": round(p95_cpu, 1),
                        "p95_connection": round(p95_conn, 1),
                    },
                    "monthly_saving": round(saving, 2),
                    "action": f"建议 {inst_class}({current_cpu}C) -> {best_target['class_code']}({best_target['cpu']}C), "
                              f"月省{round(saving, 2)}元",
                })
            else:
                recommendations.append({
                    "instance_id": inst_id,
                    "instance_desc": inst_desc,
                    "engine": engine,
                    "zone_id": zone_id,
                    "direction": "none",
                    "current": {
                        "class": inst_class,
                        "cpu": current_cpu,
                        "monthly_price": round(current_price, 2),
                    },
                    "utilization": {
                        "p95_cpu": round(p95_cpu, 1),
                        "p95_connection": round(p95_conn, 1),
                    },
                    "action": "当前规格匹配或无更优可用规格",
                })

        downsize = [r for r in recommendations if r.get("direction") == "downsize"]

        return json.dumps({
            "success": True,
            "region": region_id,
            "total_analyzed": len(all_instances),
            "downsize_count": len(downsize),
            "total_monthly_saving_cny": round(total_saving, 2),
            "recommendations": recommendations,
        }, ensure_ascii=False, indent=2)

    except Exception as e:
        return json.dumps({
            "success": False, "error": str(e),
        }, ensure_ascii=False)


# =============================================================================
# ECS 成本优化 - 责任链模式
# =============================================================================


async def opt_ecs_cost_optimization(
    region_id: str = "cn-hangzhou",
    idle_cpu_threshold: float = 1.0,
    idle_mem_threshold: float = 1.0,
    idle_days: int = 14,
    low_util_threshold: float = 20.0,
    postpaid_hold_days: int = 30,
    use_bss_pricing: bool = True,
    **kwargs,
) -> str:
    """ECS 成本优化分析（责任链模式）。

    每台 ECS 依次经过 3 个规则节点，按优先级从高到低：
    1. 闲置资源检测 (Release) - CPU/内存 Maximum < 1%
    2. 低利用率检测 (DownScaling) - P95 CPU/内存 < 20%
    3. 按量长期持有检测 (ConvertToPrePaid) - 持有天数 > 30

    同一资源命中多条建议时，只保留优先级最高的一条。

    Args:
        region_id: 区域 ID
        idle_cpu_threshold: 闲置判定 CPU 阈值 (%)
        idle_mem_threshold: 闲置判定内存阈值 (%)
        idle_days: 闲置检测回溯天数
        low_util_threshold: 低利用率 P95 阈值 (%)
        postpaid_hold_days: 按量付费持有天数阈值
        use_bss_pricing: 是否使用 BSS API 精确询价
        **kwargs: 框架注入的参数

    Returns:
        优化建议报告（Markdown 格式）
    """
    credential = kwargs.get("credential") or get_credential()
    ecs_client = _build_client(credential, "ecs", region_id)
    cms_client = _build_client(credential, "cms", region_id)
    bss_client = _build_client(credential, "bss", region_id) if use_bss_pricing else None

    # ECS 规格升降映射
    size_order = ["large", "xlarge", "2xlarge", "4xlarge", "8xlarge", "16xlarge"]

    def _get_adjacent_type(inst_type: str, direction: str) -> str | None:
        parts = inst_type.split(".")
        if len(parts) < 3:
            return None
        family = ".".join(parts[:2])
        size = parts[2]
        if size in size_order:
            idx = size_order.index(size)
            if direction == "down" and idx > 0:
                return f"{family}.{size_order[idx - 1]}"
            elif direction == "up" and idx < len(size_order) - 1:
                return f"{family}.{size_order[idx + 1]}"
        return None

    try:
        # 获取所有 Running 实例
        all_instances = []
        page = 1
        while True:
            req = ecs_models.DescribeInstancesRequest(
                region_id=region_id,
                status="Running",
                page_number=page,
                page_size=100,
            )
            resp = await asyncio.to_thread(ecs_client.describe_instances, req)
            body = resp.body
            if body.instances and body.instances.instance:
                all_instances.extend(body.instances.instance)
            total = body.total_count or 0
            if len(all_instances) >= total:
                break
            page += 1

        recommendations = []  # 优化建议列表
        stats = {
            "total": len(all_instances),
            "idle": 0,
            "low_util": 0,
            "postpaid_longterm": 0,
            "normal": 0,
        }
        total_cost_before = 0.0
        total_cost_after = 0.0

        for inst in all_instances:
            inst_id = inst.instance_id or ""
            inst_name = inst.instance_name or ""
            inst_type = inst.instance_type or ""
            charge_type = inst.instance_charge_type or "PostPaid"
            creation_time = inst.creation_time or ""

            # === 规则 1：闲置资源检测 (Release) ===
            is_idle, max_cpu, max_mem = await _check_idle_resource(
                cms_client, "acs_ecs_dashboard",
                "CPUUtilization", "memory_usedutilization",
                inst_id,
                cpu_threshold=idle_cpu_threshold,
                mem_threshold=idle_mem_threshold,
                days=idle_days,
            )

            if is_idle:
                stats["idle"] += 1
                # 查询价格：账单 → BSS 询价 → ECS OpenAPI 询价 → 估算
                price_source = "estimate"
                cost_before = 0.0
                
                if bss_client:
                    # 1. 优先查账单
                    cost_before = await _bss_query_instance_bill(bss_client, inst_id, "ecs")
                    if cost_before > 0:
                        price_source = "bill"
                        print(f"[价格查询-闲置] {inst_id} ({inst_type}) costBefore: {cost_before:.2f} 元/月 <- 账单(bill)")
                    else:
                        print(f"  [账单查询] {inst_id} 返回 {cost_before}，尝试 BSS 询价...")
                        # 2. BSS 询价
                        cost_before = await _bss_get_payg_price(bss_client, region_id, inst_type, "ecs")
                        if cost_before > 0:
                            price_source = "bss"
                            print(f"[价格查询-闲置] {inst_id} ({inst_type}) costBefore: {cost_before:.2f} 元/月 <- BSS询价(bss)")
                        else:
                            print(f"  [BSS询价] {inst_type} 返回 {cost_before}，尝试 OpenAPI 询价...")
                            # 3. ECS OpenAPI 询价
                            cost_before = await _ecs_describe_price(ecs_client, region_id, inst_type, "PostPaid")
                            if cost_before > 0:
                                price_source = "openapi"
                                print(f"[价格查询-闲置] {inst_id} ({inst_type}) costBefore: {cost_before:.2f} 元/月 <- OpenAPI询价(openapi)")
                            else:
                                # 4. 估算
                                cost_before = _estimate_monthly_cost(inst_type, charge_type)
                                price_source = "estimate"
                                print(f"[价格查询-闲置] {inst_id} ({inst_type}) costBefore: {cost_before:.2f} 元/月 <- 估算(estimate)")
                                logger.warning("All pricing methods failed for %s, using estimate: %.2f", inst_id, cost_before)
                else:
                    print(f"  [警告] 无 BSS 客户端，直接使用 OpenAPI 询价")
                    # 没有 bss_client，直接调用 ECS OpenAPI
                    cost_before = await _ecs_describe_price(ecs_client, region_id, inst_type, "PostPaid")
                    if cost_before > 0:
                        price_source = "openapi"
                        print(f"[价格查询-闲置] {inst_id} ({inst_type}) costBefore: {cost_before:.2f} 元/月 <- OpenAPI询价(openapi)")
                    else:
                        cost_before = _estimate_monthly_cost(inst_type, charge_type)
                        price_source = "estimate"
                        print(f"[价格查询-闲置] {inst_id} ({inst_type}) costBefore: {cost_before:.2f} 元/月 <- 估算(estimate)")
                
                total_cost_before += cost_before
                # Release 策略: costAfter = 0
                cost_after = 0.0
                cost_saving = cost_before

                recommendations.append({
                    "priority": 1,
                    "strategy": "Release",
                    "strategy_cn": "释放资源",
                    "instance_id": inst_id,
                    "instance_name": inst_name,
                    "instance_type": inst_type,
                    "charge_type": charge_type,
                    "cost_before": round(cost_before, 2),
                    "cost_after": round(cost_after, 2),
                    "cost_saving": round(cost_saving, 2),
                    "price_source": price_source,  # 价格来源
                    "utilization": {
                        f"max_cpu_{idle_days}d": round(max_cpu, 2),
                        f"max_mem_{idle_days}d": round(max_mem, 2),
                    },
                    "reason": f"CPU 最大值 {round(max_cpu, 1)}% 或内存最大值 {round(max_mem, 1)}% 低于 {idle_cpu_threshold}%，资源完全闲置",
                    "action": f"建议直接释放该实例，月节省 {round(cost_saving, 0)} 元",
                })
                continue  # 进入下一个实例

            # === 规则 2：低利用率检测 (DownScaling) ===
            p95_cpu = await _get_cms_metric_percentile(
                cms_client, "acs_ecs_dashboard", "CPUUtilization",
                [{"instanceId": inst_id}], days=7,
            )
            p95_mem = await _get_cms_metric_percentile(
                cms_client, "acs_ecs_dashboard", "memory_usedutilization",
                [{"instanceId": inst_id}], days=7,
            )

            if p95_cpu < low_util_threshold and p95_mem < low_util_threshold:
                stats["low_util"] += 1
                target_type = _get_adjacent_type(inst_type, "down")
                
                # 查询价格：账单 → BSS 询价 → ECS OpenAPI 询价 → 估算
                price_source = "estimate"
                cost_before = 0.0
                cost_after = 0.0
                
                if bss_client:
                    # 1. 优先查账单
                    cost_before = await _bss_query_instance_bill(bss_client, inst_id, "ecs")
                    if cost_before > 0:
                        price_source = "bill"
                        print(f"[价格查询-降配] {inst_id} ({inst_type}) costBefore: {cost_before:.2f} 元/月 <- 账单(bill)")
                    else:
                        print(f"  [账单查询] {inst_id} 返回 {cost_before}，尝试 BSS 询价...")
                        # 2. BSS 询价
                        cost_before = await _bss_get_payg_price(bss_client, region_id, inst_type, "ecs")
                        if cost_before > 0:
                            price_source = "bss"
                            print(f"[价格查询-降配] {inst_id} ({inst_type}) costBefore: {cost_before:.2f} 元/月 <- BSS询价(bss)")
                        else:
                            print(f"  [BSS询价] {inst_type} 返回 {cost_before}，尝试 OpenAPI 询价...")
                            # 3. ECS OpenAPI 询价
                            cost_before = await _ecs_describe_price(ecs_client, region_id, inst_type, "PostPaid")
                            if cost_before > 0:
                                price_source = "openapi"
                                print(f"[价格查询-降配] {inst_id} ({inst_type}) costBefore: {cost_before:.2f} 元/月 <- OpenAPI询价(openapi)")
                            else:
                                # 4. 估算
                                cost_before = _estimate_monthly_cost(inst_type, charge_type)
                                price_source = "estimate"
                                print(f"[价格查询-降配] {inst_id} ({inst_type}) costBefore: {cost_before:.2f} 元/月 <- 估算(estimate)")
                                logger.warning("All pricing methods failed for %s (current), using estimate", inst_id)
                    
                    # 查询目标规格价格
                    if target_type:
                        target_source = "estimate"
                        cost_after = await _bss_get_payg_price(bss_client, region_id, target_type, "ecs")
                        if cost_after > 0:
                            target_source = "bss"
                            print(f"[价格查询-降配] {inst_id} ({target_type}) costAfter: {cost_after:.2f} 元/月 <- BSS询价(bss)")
                        else:
                            print(f"  [BSS询价] {target_type} 返回 {cost_after}，尝试 OpenAPI 询价...")
                            cost_after = await _ecs_describe_price(ecs_client, region_id, target_type, "PostPaid")
                            if cost_after > 0:
                                target_source = "openapi"
                                print(f"[价格查询-降配] {inst_id} ({target_type}) costAfter: {cost_after:.2f} 元/月 <- OpenAPI询价(openapi)")
                            else:
                                cost_after = _estimate_monthly_cost(target_type, charge_type)
                                print(f"[价格查询-降配] {inst_id} ({target_type}) costAfter: {cost_after:.2f} 元/月 <- 估算(estimate)")
                    else:
                        cost_after = cost_before
                else:
                    print(f"  [警告] 无 BSS 客户端，直接使用 OpenAPI 询价")
                    # 没有 bss_client，直接调用 ECS OpenAPI
                    cost_before = await _ecs_describe_price(ecs_client, region_id, inst_type, "PostPaid")
                    if cost_before > 0:
                        price_source = "openapi"
                        print(f"[价格查询-降配] {inst_id} ({inst_type}) costBefore: {cost_before:.2f} 元/月 <- OpenAPI询价(openapi)")
                    else:
                        cost_before = _estimate_monthly_cost(inst_type, charge_type)
                        price_source = "estimate"
                        print(f"[价格查询-降配] {inst_id} ({inst_type}) costBefore: {cost_before:.2f} 元/月 <- 估算(estimate)")
                    
                    if target_type:
                        cost_after = await _ecs_describe_price(ecs_client, region_id, target_type, "PostPaid")
                        if cost_after > 0:
                            print(f"[价格查询-降配] {inst_id} ({target_type}) costAfter: {cost_after:.2f} 元/月 <- OpenAPI询价(openapi)")
                        else:
                            cost_after = _estimate_monthly_cost(target_type, charge_type)
                            print(f"[价格查询-降配] {inst_id} ({target_type}) costAfter: {cost_after:.2f} 元/月 <- 估算(estimate)")
                    else:
                        cost_after = cost_before
                
                total_cost_before += cost_before
                total_cost_after += cost_after
                cost_saving = max(0, cost_before - cost_after)

                if target_type and cost_saving > 0:
                    recommendations.append({
                        "priority": 2,
                        "strategy": "DownScaling",
                        "strategy_cn": "降配",
                        "instance_id": inst_id,
                        "instance_name": inst_name,
                        "instance_type": inst_type,
                        "target_type": target_type,
                        "charge_type": charge_type,
                        "cost_before": round(cost_before, 2),
                        "cost_after": round(cost_after, 2),
                        "cost_saving": round(cost_saving, 2),
                        "price_source": price_source,  # 价格来源
                        "utilization": {
                            "p95_cpu_7d": round(p95_cpu, 1),
                            "p95_mem_7d": round(p95_mem, 1),
                        },
                        "reason": f"P95 CPU {round(p95_cpu, 1)}%，P95 内存 {round(p95_mem, 1)}%，利用率偏低",
                        "action": f"建议 {inst_type} 降配到 {target_type}，月费 {round(cost_before, 0)}元 → {round(cost_after, 0)}元，月节省 {round(cost_saving, 0)} 元",
                    })
                    continue

            # === 规则 3：按量付费长期持有检测 (ConvertToPrePaid) ===
            should_convert, hold_days = _check_postpaid_longterm(
                charge_type, creation_time, postpaid_hold_days
            )

            if should_convert:
                stats["postpaid_longterm"] += 1
                
                # 查询价格：账单 → BSS 询价 → ECS OpenAPI 询价 → 估算
                price_source = "estimate"
                cost_before = 0.0
                cost_after = 0.0
                
                if bss_client:
                    # 1. 账单查询当前按量价格
                    cost_before = await _bss_query_instance_bill(bss_client, inst_id, "ecs")
                    if cost_before > 0:
                        price_source = "bill"
                        print(f"[价格查询] {inst_id} ({inst_type}) costBefore: {cost_before:.2f} 元/月 <- 账单(bill)")
                    else:
                        # 2. BSS 询价
                        cost_before = await _bss_get_payg_price(bss_client, region_id, inst_type, "ecs")
                        if cost_before > 0:
                            price_source = "bss"
                            print(f"[价格查询] {inst_id} ({inst_type}) costBefore: {cost_before:.2f} 元/月 <- BSS询价(bss)")
                        else:
                            # 3. ECS OpenAPI 询价
                            cost_before = await _ecs_describe_price(ecs_client, region_id, inst_type, "PostPaid")
                            if cost_before > 0:
                                price_source = "openapi"
                                print(f"[价格查询] {inst_id} ({inst_type}) costBefore: {cost_before:.2f} 元/月 <- OpenAPI询价(openapi)")
                            else:
                                cost_before = _estimate_monthly_cost(inst_type, "PostPaid")
                                print(f"[价格查询] {inst_id} ({inst_type}) costBefore: {cost_before:.2f} 元/月 <- 估算(estimate)")
                    
                    # 包年包月价格
                    cost_after = await _bss_get_subscription_price(bss_client, region_id, inst_type, "ecs")
                    if cost_after > 0:
                        print(f"[价格查询] {inst_id} ({inst_type}) costAfter: {cost_after:.2f} 元/月 <- BSS询价(bss)")
                    else:
                        cost_after = await _ecs_describe_price(ecs_client, region_id, inst_type, "PrePaid")
                        if cost_after > 0:
                            print(f"[价格查询] {inst_id} ({inst_type}) costAfter: {cost_after:.2f} 元/月 <- OpenAPI询价(openapi)")
                        else:
                            cost_after = _estimate_monthly_cost(inst_type, "PrePaid")
                            print(f"[价格查询] {inst_id} ({inst_type}) costAfter: {cost_after:.2f} 元/月 <- 估算(estimate)")
                else:
                    # 没有 bss_client，直接调用 ECS OpenAPI
                    cost_before = await _ecs_describe_price(ecs_client, region_id, inst_type, "PostPaid")
                    if cost_before > 0:
                        price_source = "openapi"
                        print(f"[价格查询] {inst_id} ({inst_type}) costBefore: {cost_before:.2f} 元/月 <- OpenAPI询价(openapi)")
                    else:
                        cost_before = _estimate_monthly_cost(inst_type, "PostPaid")
                        print(f"[价格查询] {inst_id} ({inst_type}) costBefore: {cost_before:.2f} 元/月 <- 估算(estimate)")
                    
                    cost_after = await _ecs_describe_price(ecs_client, region_id, inst_type, "PrePaid")
                    if cost_after > 0:
                        print(f"[价格查询] {inst_id} ({inst_type}) costAfter: {cost_after:.2f} 元/月 <- OpenAPI询价(openapi)")
                    else:
                        cost_after = _estimate_monthly_cost(inst_type, "PrePaid")
                        print(f"[价格查询] {inst_id} ({inst_type}) costAfter: {cost_after:.2f} 元/月 <- 估算(estimate)")
                
                total_cost_before += cost_before
                total_cost_after += cost_after
                cost_saving = max(0, cost_before - cost_after)

                if cost_saving > 0:
                    recommendations.append({
                        "priority": 3,
                        "strategy": "ConvertToPrePaid",
                        "strategy_cn": "转包年包月",
                        "instance_id": inst_id,
                        "instance_name": inst_name,
                        "instance_type": inst_type,
                        "charge_type": charge_type,
                        "hold_days": hold_days,
                        "cost_before": round(cost_before, 2),
                        "cost_after": round(cost_after, 2),
                        "cost_saving": round(cost_saving, 2),
                        "reason": f"按量付费已持有 {hold_days} 天，超过 {postpaid_hold_days} 天阈值",
                        "action": f"建议转为包年包月，月费 {round(cost_before, 0)}元 → {round(cost_after, 0)}元，月节省 {round(cost_saving, 0)} 元",
                    })
                    continue

            # 未命中任何规则
            stats["normal"] += 1

        # 汇总
        total_saving = sum(r.get("cost_saving", 0) for r in recommendations)

        # =====================================================================
        # 自动导入 Action Store（联动 aliyun-resource-ops）
        # =====================================================================
        action_store_result = {"imported": 0, "message": ""}
        if recommendations:
            try:
                from datetime import datetime as dt
                from pathlib import Path
                import json as _json
                
                # Action Store 路径
                store_path = Path.home() / ".copaw" / "data" / "optimization_actions.json"
                store_path.parent.mkdir(parents=True, exist_ok=True)
                
                # 加载现有数据
                try:
                    store_data = _json.loads(store_path.read_text(encoding="utf-8"))
                except (FileNotFoundError, _json.JSONDecodeError):
                    store_data = {
                        "version": "1.0",
                        "actions": [],
                        "stats": {"total_created": 0, "total_executed": 0, "total_skipped": 0, "total_savings_realized": 0.0},
                        "updated_at": "",
                    }
                
                # 现有动作索引（以 resource_id 为 key）
                existing = {a["resource_id"]: a for a in store_data["actions"]}
                
                # 生成分析 ID
                analysis_id = f"ecs_{dt.now().strftime('%Y%m%d%H%M%S')}"
                now_iso = dt.now().isoformat()
                expires_iso = (dt.now() + timedelta(days=7)).isoformat()
                
                added = 0
                # 只导入可执行策略（Release / DownScaling）
                executable_strategies = {"Release", "DownScaling"}
                
                for rec in recommendations:
                    strategy = rec.get("strategy", "")
                    if strategy not in executable_strategies:
                        continue
                    
                    resource_id = rec.get("instance_id", "")
                    if not resource_id:
                        continue
                    
                    # 跳过已执行/已跳过的
                    if resource_id in existing:
                        if existing[resource_id].get("status") in ["executed", "skipped"]:
                            continue
                    
                    # 创建动作
                    action = {
                        "action_id": f"act_{resource_id[-8:]}_{dt.now().strftime('%H%M%S')}",
                        "product": "ECS",
                        "resource_id": resource_id,
                        "resource_name": rec.get("instance_name", ""),
                        "region_id": region_id,
                        "strategy": strategy,
                        "current_spec": rec.get("instance_type", ""),
                        "target_spec": rec.get("target_type", ""),
                        "cost_before": rec.get("cost_before", 0.0),
                        "cost_after": rec.get("cost_after", 0.0),
                        "cost_saving": rec.get("cost_saving", 0.0),
                        "reason": rec.get("reason", ""),
                        "check_id": "",
                        "status": "pending",
                        "created_at": now_iso,
                        "executed_at": None,
                        "expires_at": expires_iso,
                        "source_analysis_id": analysis_id,
                        "source_product": "ECS",
                        "execute_result": {},
                        "skip_reason": "",
                    }
                    
                    existing[resource_id] = action
                    added += 1
                
                # 保存
                store_data["actions"] = list(existing.values())
                store_data["stats"]["total_created"] += added
                store_data["updated_at"] = now_iso
                store_path.write_text(_json.dumps(store_data, ensure_ascii=False, indent=2), encoding="utf-8")
                
                action_store_result = {"imported": added, "analysis_id": analysis_id}
                logger.info("已导入 %d 条可执行动作到 Action Store (analysis_id=%s)", added, analysis_id)
                
            except Exception as e:
                logger.warning("自动导入 Action Store 失败: %s", e)
                action_store_result = {"imported": 0, "error": str(e)}

        # 使用专业报告生成器生成报告
        from core.report import generate_report_from_dict
        
        report = generate_report_from_dict(
            recommendations=recommendations,
            region_id=region_id,
            product_name="ECS",
            stats=stats,
            params={
                "idle_threshold": idle_cpu_threshold,
                "low_util_threshold": low_util_threshold,
                "hold_days": postpaid_hold_days,
                "use_bss_pricing": use_bss_pricing,
            },
        )
        
        # 在报告末尾追加 Action Store 信息
        if action_store_result.get("imported", 0) > 0:
            report += f"\n\n---\n\n**Action Store**: 已导入 {action_store_result['imported']} 条可执行动作，可通过 `ops_list_pending_actions` 查询并执行。\n"
        
        return report

    except Exception as e:
        return f"# 错误\n\n分析失败: {str(e)}"


# =============================================================================
# 通用成本优化入口（多产品）
# =============================================================================


async def opt_cost_optimization(
    region_id: str = "cn-hangzhou",
    products: str = "ecs",
    idle_threshold: float = 1.0,
    low_util_threshold: float = 20.0,
    hold_days: int = 30,
    use_bss_pricing: bool = True,
    **kwargs,
) -> str:
    """多产品云资源成本优化分析（通用框架）。

    基于责任链模式，对每个产品的资源依次执行：
    1. 闲置资源检测 (Release) - 完全闲置建议释放
    2. 低利用率检测 (DownScaling) - 利用率低建议降配
    3. 按量长期持有检测 (ConvertToPrePaid) - 按量超30天建议转包月

    同一资源命中多条建议时，只保留优先级最高的一条。

    Args:
        region_id: 区域 ID
        products: 产品列表，逗号分隔（ecs,rds,disk,eip,slb）
        idle_threshold: 闲置判定阈值（%）
        low_util_threshold: 低利用率 P95 阈值（%）
        hold_days: 按量付费持有天数阈值
        use_bss_pricing: 是否使用 BSS API 精确询价
        **kwargs: 框架注入的参数

    Returns:
        优化建议报告（Markdown 格式）
    """
    from datetime import datetime
    from core.base import OptimizeStrategy, STRATEGY_PRIORITY, STRATEGY_CN
    from core.bss import BssService
    from core.rules import CmsService, build_rule_chain
    from core.pipeline import PostProcessor, generate_markdown_report
    from products import get_product_config, list_products

    credential = kwargs.get("credential") or get_credential()
    ak, sk = _get_ak_sk(credential)

    # 解析产品列表
    product_list = [p.strip().lower() for p in products.split(",") if p.strip()]
    if not product_list:
        product_list = ["ecs"]
    
    # 产品代码别名映射（兼容常见别名）
    PRODUCT_ALIAS = {
        "ebs": "disk",      # 云盘
        "cloud_disk": "disk",
        "elasticip": "eip", # 弹性IP
        "clb": "slb",       # 负载均衡
        "mysql": "rds",     # 数据库
        "postgresql": "rds",
    }
    product_list = [PRODUCT_ALIAS.get(p, p) for p in product_list]

    # 初始化服务
    bss = BssService(ak, sk) if use_bss_pricing else None
    cms = CmsService(ak, sk, region_id)

    all_results = []
    all_stats = {
        "total": 0,
        "idle": 0,
        "low_util": 0,
        "postpaid_longterm": 0,
        "normal": 0,
    }
    product_reports = []

    for product_code in product_list:
        config = get_product_config(product_code)
        if not config:
            product_reports.append(f"### {product_code}\n\n产品不支持或未注册。\n")
            continue

        # 更新配置中的闲置阈值
        for metric in config.idle_metrics:
            metric.threshold = idle_threshold

        # 列举实例
        if not config.list_instances_fn:
            product_reports.append(f"### {config.product_name}\n\n无法列举实例。\n")
            continue

        try:
            instances = await config.list_instances_fn(ak, sk, region_id)
        except Exception as e:
            product_reports.append(f"### {config.product_name}\n\n列举实例失败: {e}\n")
            continue

        all_stats["total"] += len(instances)

        if not instances:
            product_reports.append(f"### {config.product_name}\n\n该区域无实例。\n")
            continue

        # ECS 特殊处理：预取可降配实例列表（使用 DescribeResourceStatusDiagnosis API）
        extra_kwargs = {"ak": ak, "sk": sk}
        if product_code == "ecs":
            try:
                from products import get_downscaling_instances
                downscaling_instances = await get_downscaling_instances(ak, sk, region_id)
                extra_kwargs["downscaling_instances"] = downscaling_instances
            except Exception as e:
                logger.warning("获取可降配实例列表失败: %s", e)

        # 构建规则链
        rule_chain = build_rule_chain(
            config,
            low_util_threshold=low_util_threshold,
            hold_days_threshold=hold_days,
        )

        # 后处理器
        processor = PostProcessor(bss, config, use_bss_pricing)

        # 执行分析
        results = []
        for inst in instances:
            result = await rule_chain.execute(inst, config, cms, **extra_kwargs)
            if result:
                results.append(result)
                # 统计
                if result.strategy == OptimizeStrategy.RELEASE:
                    all_stats["idle"] += 1
                elif result.strategy == OptimizeStrategy.DOWN_SCALING:
                    all_stats["low_util"] += 1
                elif result.strategy == OptimizeStrategy.CONVERT_TO_PREPAID:
                    all_stats["postpaid_longterm"] += 1
            else:
                all_stats["normal"] += 1

        # 后处理
        if results:
            results = await processor.process_batch(results)
            all_results.extend(results)

    # =========================================================================
    # 自动导入 Action Store（联动 aliyun-resource-ops）
    # =========================================================================
    action_store_result = {"imported": 0, "message": ""}
    if all_results:
        try:
            from pathlib import Path
            import json as _json
            
            # Action Store 路径
            store_path = Path.home() / ".copaw" / "data" / "optimization_actions.json"
            store_path.parent.mkdir(parents=True, exist_ok=True)
            
            # 加载现有数据
            try:
                store_data = _json.loads(store_path.read_text(encoding="utf-8"))
            except (FileNotFoundError, _json.JSONDecodeError):
                store_data = {
                    "version": "1.0",
                    "actions": [],
                    "stats": {"total_created": 0, "total_executed": 0, "total_skipped": 0, "total_savings_realized": 0.0},
                    "updated_at": "",
                }
            
            # 现有动作索引
            existing = {a["resource_id"]: a for a in store_data["actions"]}
            
            # 生成分析 ID
            analysis_id = f"multi_{datetime.now().strftime('%Y%m%d%H%M%S')}"
            now_iso = datetime.now().isoformat()
            expires_iso = (datetime.now() + __import__("datetime").timedelta(days=7)).isoformat()
            
            added = 0
            executable_strategies = {OptimizeStrategy.RELEASE, OptimizeStrategy.DOWN_SCALING}
            
            for result in all_results:
                if result.strategy not in executable_strategies:
                    continue
                
                resource_id = result.resource_id
                if not resource_id:
                    continue
                
                # 跳过已执行/已跳过的
                if resource_id in existing:
                    if existing[resource_id].get("status") in ["executed", "skipped"]:
                        continue
                
                # 创建动作
                action = {
                    "action_id": f"act_{resource_id[-8:]}_{datetime.now().strftime('%H%M%S')}",
                    "product": result.product.upper(),
                    "resource_id": resource_id,
                    "resource_name": result.resource_name,
                    "region_id": result.region_id or region_id,
                    "strategy": result.strategy.value,
                    "current_spec": result.instance_type,
                    "target_spec": result.optimized_config or "",
                    "cost_before": result.cost_before,
                    "cost_after": result.cost_after,
                    "cost_saving": result.cost_savings,
                    "reason": result.extend_result.get("reason", ""),
                    "check_id": result.check_id,
                    "status": "pending",
                    "created_at": now_iso,
                    "executed_at": None,
                    "expires_at": expires_iso,
                    "source_analysis_id": analysis_id,
                    "source_product": result.product,
                    "execute_result": {},
                    "skip_reason": "",
                }
                
                existing[resource_id] = action
                added += 1
            
            # 保存
            store_data["actions"] = list(existing.values())
            store_data["stats"]["total_created"] += added
            store_data["updated_at"] = now_iso
            store_path.write_text(_json.dumps(store_data, ensure_ascii=False, indent=2), encoding="utf-8")
            
            action_store_result = {"imported": added, "analysis_id": analysis_id}
            logger.info("已导入 %d 条可执行动作到 Action Store (analysis_id=%s)", added, analysis_id)
            
        except Exception as e:
            logger.warning("自动导入 Action Store 失败: %s", e)
            action_store_result = {"imported": 0, "error": str(e)}

    # 使用专业报告生成器生成报告
    from core.report import generate_cost_report
    
    report = generate_cost_report(
        results=all_results,
        region_id=region_id,
        products=product_list,
        stats=all_stats,
        params={
            "idle_threshold": idle_threshold,
            "low_util_threshold": low_util_threshold,
            "hold_days": hold_days,
            "use_bss_pricing": use_bss_pricing,
        },
        title="云资源成本优化分析报告",
    )
    
    # 在报告末尾追加 Action Store 信息
    if action_store_result.get("imported", 0) > 0:
        report += f"\n\n---\n\n**Action Store**: 已导入 {action_store_result['imported']} 条可执行动作，可通过 `ops_list_pending_actions` 查询并执行。\n"
    
    return report


# =============================================================================
# 按标签进行成本优化分析
# =============================================================================


async def opt_cost_by_tag(
    tag_key: str,
    tag_value: str,
    region_id: str = "cn-hangzhou",
    products: str = "ecs,slb",
    idle_threshold: float = 1.0,
    low_util_threshold: float = 20.0,
    hold_days: int = 30,
    **kwargs,
) -> str:
    """按标签查询资源并进行成本优化分析。

    一站式工具：
    1. 按指定标签查询资源
    2. 对这些资源进行成本优化分析
    3. 返回统一格式的报告

    Args:
        tag_key: 标签键
        tag_value: 标签值
        region_id: 区域 ID
        products: 产品列表，逗号分隔（ecs,slb,rds,eip,disk）
        idle_threshold: 闲置判定阈值（%）
        low_util_threshold: 低利用率 P95 阈值（%）
        hold_days: 按量付费持有天数阈值
        **kwargs: 框架注入的参数

    Returns:
        优化建议报告（Markdown 格式）
    """
    credential = kwargs.get("credential") or get_credential()
    ak, sk = _get_ak_sk(credential)
    
    # 解析产品列表
    product_list = [p.strip().lower() for p in products.split(",") if p.strip()]
    if not product_list:
        product_list = ["ecs", "slb"]
    
    # 初始化客户端
    ecs_client = _build_client(credential, "ecs", region_id)
    slb_client = _build_client(credential, "slb", region_id)
    cms_client = _build_client(credential, "cms", region_id)
    
    # 结果汇总
    all_results = []
    all_stats = {
        "total": 0,
        "idle": 0,
        "low_util": 0,
        "postpaid_longterm": 0,
        "normal": 0,
    }
    
    # --- 查询带标签的 ECS ---
    if "ecs" in product_list:
        try:
            ecs_instances = []
            page = 1
            while True:
                tag_filter = ecs_models.DescribeInstancesRequestTag(
                    key=tag_key,
                    value=tag_value,
                )
                req = ecs_models.DescribeInstancesRequest(
                    region_id=region_id,
                    tag=[tag_filter],
                    page_number=page,
                    page_size=100,
                )
                resp = await asyncio.to_thread(ecs_client.describe_instances, req)
                body = resp.body
                if body.instances and body.instances.instance:
                    ecs_instances.extend(body.instances.instance)
                total = body.total_count or 0
                if len(ecs_instances) >= total:
                    break
                page += 1
            
            all_stats["total"] += len(ecs_instances)
            
            # 分析每个 ECS 实例
            for inst in ecs_instances:
                inst_id = inst.instance_id or ""
                inst_name = inst.instance_name or ""
                inst_type = inst.instance_type or ""
                charge_type = inst.instance_charge_type or "PostPaid"
                status = inst.status or ""
                
                if status != "Running":
                    all_stats["normal"] += 1
                    continue
                
                # 查询监控数据
                avg_cpu = await _get_cms_metric_avg(
                    cms_client, "acs_ecs_dashboard", "CPUUtilization",
                    [{"instanceId": inst_id}], days=7,
                )
                avg_mem = await _get_cms_metric_avg(
                    cms_client, "acs_ecs_dashboard", "memory_usedutilization",
                    [{"instanceId": inst_id}], days=7,
                )
                p95_cpu = await _get_cms_metric_percentile(
                    cms_client, "acs_ecs_dashboard", "CPUUtilization",
                    [{"instanceId": inst_id}], days=7,
                )
                p95_mem = await _get_cms_metric_percentile(
                    cms_client, "acs_ecs_dashboard", "memory_usedutilization",
                    [{"instanceId": inst_id}], days=7,
                )
                max_cpu = await _get_cms_metric_max(
                    cms_client, "acs_ecs_dashboard", "CPUUtilization",
                    [{"instanceId": inst_id}], days=14,
                )
                max_mem = await _get_cms_metric_max(
                    cms_client, "acs_ecs_dashboard", "memory_usedutilization",
                    [{"instanceId": inst_id}], days=14,
                )
                
                # 估算价格
                cost_before = _estimate_monthly_cost(inst_type, charge_type)
                
                # 闲置检测
                if max_cpu >= 0 and max_cpu < idle_threshold or max_mem >= 0 and max_mem < idle_threshold:
                    all_stats["idle"] += 1
                    all_results.append({
                        "product": "ECS",
                        "resource_id": inst_id,
                        "resource_name": inst_name,
                        "instance_type": inst_type,
                        "charge_type": charge_type,
                        "strategy": "Release",
                        "strategy_cn": "释放资源",
                        "cost_before": round(cost_before, 2),
                        "cost_after": 0.0,
                        "cost_saving": round(cost_before, 2),
                        "metrics": {
                            "avg_cpu_7d": round(avg_cpu, 2),
                            "avg_mem_7d": round(avg_mem, 2),
                            "p95_cpu_7d": round(p95_cpu, 2),
                            "p95_mem_7d": round(p95_mem, 2),
                            "max_cpu_14d": round(max_cpu, 2),
                            "max_mem_14d": round(max_mem, 2),
                        },
                        "reason": f"CPU 最大值 {round(max_cpu, 1)}%，内存最大值 {round(max_mem, 1)}%，资源完全闲置",
                        "action": f"建议释放该实例，预估月省 {round(cost_before, 0)} 元",
                    })
                    continue
                
                # 低利用率检测
                if p95_cpu < low_util_threshold and p95_mem < low_util_threshold:
                    all_stats["low_util"] += 1
                    target_type = _get_adjacent_type(inst_type, "down")
                    cost_after = _estimate_monthly_cost(target_type or inst_type, charge_type) if target_type else cost_before
                    cost_saving = max(0, cost_before - cost_after)
                    
                    if target_type and cost_saving > 0:
                        all_results.append({
                            "product": "ECS",
                            "resource_id": inst_id,
                            "resource_name": inst_name,
                            "instance_type": inst_type,
                            "target_type": target_type,
                            "charge_type": charge_type,
                            "strategy": "DownScaling",
                            "strategy_cn": "降配",
                            "cost_before": round(cost_before, 2),
                            "cost_after": round(cost_after, 2),
                            "cost_saving": round(cost_saving, 2),
                            "metrics": {
                                "avg_cpu_7d": round(avg_cpu, 2),
                                "avg_mem_7d": round(avg_mem, 2),
                                "p95_cpu_7d": round(p95_cpu, 2),
                                "p95_mem_7d": round(p95_mem, 2),
                            },
                            "reason": f"P95 CPU {round(p95_cpu, 1)}%，P95 内存 {round(p95_mem, 1)}%，利用率偏低",
                            "action": f"建议从 {inst_type} 降配到 {target_type}，预估月省 {round(cost_saving, 0)} 元",
                        })
                        continue
                
                all_stats["normal"] += 1
        
        except Exception as e:
            logger.warning("ECS 分析失败: %s", e)
    
    # --- 查询带标签的 SLB ---
    if "slb" in product_list:
        try:
            slb_instances = []
            page = 1
            while True:
                tag_filter = slb_models.DescribeLoadBalancersRequestTag(
                    key=tag_key,
                    value=tag_value,
                )
                req = slb_models.DescribeLoadBalancersRequest(
                    region_id=region_id,
                    tags=[tag_filter],
                    page_number=page,
                    page_size=100,
                )
                resp = await asyncio.to_thread(slb_client.describe_load_balancers, req)
                body = resp.body
                lbs = body.load_balancers
                items = lbs.load_balancer if lbs and hasattr(lbs, "load_balancer") and lbs.load_balancer else []
                slb_instances.extend(items)
                total = body.total_count or 0
                if len(slb_instances) >= total:
                    break
                page += 1
            
            all_stats["total"] += len(slb_instances)
            
            for slb in slb_instances:
                slb_id = slb.load_balancer_id or ""
                slb_name = slb.load_balancer_name or ""
                slb_status = slb.load_balancer_status or ""
                spec = slb.load_balancer_spec or "slb.s1.small"
                address_type = slb.address_type or ""
                
                if slb_status != "active":
                    all_stats["normal"] += 1
                    continue
                
                # 查询监控数据
                avg_conn = await _get_cms_metric_avg(
                    cms_client, "acs_slb_dashboard", "ActiveConnection",
                    [{"instanceId": slb_id}], days=7,
                )
                avg_traffic = await _get_cms_metric_avg(
                    cms_client, "acs_slb_dashboard", "TrafficRXNew",
                    [{"instanceId": slb_id}], days=7,
                )
                
                # 估算价格（公网 SLB 约 50 元/月，内网 SLB 差不多免费）
                if address_type == "internet":
                    cost_before = 50.0  # 公网 SLB 基础费用
                else:
                    cost_before = 0.0   # 内网 SLB
                
                # 闲置检测
                if avg_conn < 1.0 and avg_traffic < 1.0:
                    all_stats["idle"] += 1
                    all_results.append({
                        "product": "SLB",
                        "resource_id": slb_id,
                        "resource_name": slb_name,
                        "instance_type": f"{address_type} SLB" if address_type else spec,
                        "charge_type": "PostPaid",
                        "strategy": "Release",
                        "strategy_cn": "释放",
                        "cost_before": round(cost_before, 2),
                        "cost_after": 0.0,
                        "cost_saving": round(cost_before, 2),
                        "metrics": {
                            "avg_conn_7d": round(avg_conn, 2),
                            "avg_traffic_7d": round(avg_traffic, 2),
                        },
                        "reason": f"7天平均活跃连接数 {round(avg_conn, 1)}，流量接近 0",
                        "action": f"建议释放或检查业务是否正常" if cost_before > 0 else "建议评估是否可以合并或释放",
                    })
                    continue
                
                all_stats["normal"] += 1
        
        except Exception as e:
            logger.warning("SLB 分析失败: %s", e)
    
    # 生成报告
    total_saving = sum(r.get("cost_saving", 0) for r in all_results)
    
    # 生成 Markdown 报告
    lines = []
    lines.append(f"# {tag_key}:{tag_value} 标签资源成本优化报告")
    lines.append("")
    lines.append(f"> 生成时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    lines.append(f"> 分析区域: {region_id}")
    lines.append(f"> 产品范围: {', '.join(product_list)}")
    lines.append("")
    
    # 概览
    lines.append("## 概览")
    lines.append("")
    lines.append("| 指标 | 数值 | 状态 |")
    lines.append("|------|------|------|")
    lines.append(f"| 资源总数 | {all_stats['total']} 个 | - |")
    lines.append(f"| 闲置资源 | {all_stats['idle']} 个 | {'🔴 需关注' if all_stats['idle'] > 0 else '✅ 正常'} |")
    lines.append(f"| 低利用率 | {all_stats['low_util']} 个 | {'🟡 可优化' if all_stats['low_util'] > 0 else '✅ 正常'} |")
    lines.append(f"| 正常资源 | {all_stats['normal']} 个 | ✅ 健康 |")
    lines.append(f"| **预估月总节省** | **{round(total_saving, 0)} 元** | - |")
    lines.append("")
    
    # 优化建议
    if all_results:
        lines.append("## 优化建议")
        lines.append("")
        
        # 按产品分组
        by_product: dict[str, list] = {}
        for r in all_results:
            by_product.setdefault(r["product"], []).append(r)
        
        for product, items in by_product.items():
            lines.append(f"### {product}")
            lines.append("")
            lines.append("| 实例 ID | 实例名称 | 当前规格 | 目标规格 | 当前月费 | 目标月费 | 月节省 | 操作建议 |")
            lines.append("|----------|----------|----------|----------|----------:|---------:|-------:|----------|")
            
            for item in items:
                target = item.get("target_type", "-")
                if item["strategy"] == "Release":
                    target = "🗑️ 释放"
                elif item["strategy"] == "DownScaling" and item.get("target_type"):
                    target = f"⬇️ {item['target_type']}"
                
                name = item.get("resource_name", "-") or "-"
                if len(name) > 15:
                    name = name[:12] + "..."
                
                lines.append(
                    f"| `{item['resource_id']}` | {name} | {item['instance_type']} | {target} | "
                    f"{item['cost_before']}元 | {item['cost_after']}元 | **{item['cost_saving']}元** | {item['strategy_cn']} |"
                )
            lines.append("")
        
        # 详细说明
        lines.append("### 详细说明")
        lines.append("")
        for i, item in enumerate(all_results, 1):
            name_str = f" ({item['resource_name']})" if item.get('resource_name') else ""
            lines.append(f"**{i}. {item['resource_id']}{name_str}**")
            lines.append(f"- 原因: {item['reason']}")
            lines.append(f"- 建议: {item['action']}")
            if item.get("metrics"):
                metrics_str = ", ".join(f"{k}={v}" for k, v in item["metrics"].items())
                lines.append(f"- 监控指标: {metrics_str}")
            lines.append("")
    else:
        lines.append("## 分析结论")
        lines.append("")
        lines.append("> 所有资源均处于健康状态，无需优化操作。")
        lines.append("")
    
    # 实例明细（包含所有资源的监控数据）
    lines.append("## 实例明细")
    lines.append("")
    
    if all_results:
        # 按产品分组显示
        by_product = {}
        for r in all_results:
            by_product.setdefault(r["product"], []).append(r)
        
        for product, items in by_product.items():
            lines.append(f"### {product} 明细")
            lines.append("")
            
            if product == "ECS":
                lines.append("| 实例 ID | 平均 CPU | 平均内存 | P95 CPU | P95 内存 | 状态 |")
                lines.append("|----------|--------:|--------:|--------:|--------:|------|")
                for item in items:
                    m = item.get("metrics", {})
                    status = "🔴 闲置" if item["strategy"] == "Release" else "🟡 低利用"
                    lines.append(
                        f"| `{item['resource_id']}` | {m.get('avg_cpu_7d', 0):.1f}% | {m.get('avg_mem_7d', 0):.1f}% | "
                        f"{m.get('p95_cpu_7d', 0):.1f}% | {m.get('p95_mem_7d', 0):.1f}% | {status} |"
                    )
            elif product == "SLB":
                lines.append("| 实例 ID | 平均连接数 | 平均流量 | 状态 |")
                lines.append("|----------|----------:|--------:|------|")
                for item in items:
                    m = item.get("metrics", {})
                    status = "🔴 闲置" if item["strategy"] == "Release" else "🟡 低利用"
                    lines.append(
                        f"| `{item['resource_id']}` | {m.get('avg_conn_7d', 0):.1f} | {m.get('avg_traffic_7d', 0):.1f} | {status} |"
                    )
            lines.append("")
    else:
        lines.append("> 无需优化的资源")
        lines.append("")
    
    lines.append("---")
    lines.append("")
    lines.append("状态说明: 🔴 闲置 | 🟡 低利用率 | ✅ 健康")
    
    return "\n".join(lines)


# ECS 规格升降映射
_SIZE_ORDER_GLOBAL = ["large", "xlarge", "2xlarge", "4xlarge", "8xlarge", "16xlarge"]


def _get_adjacent_type(inst_type: str, direction: str) -> Optional[str]:
    """获取相邻规格（升配/降配）。"""
    parts = inst_type.split(".")
    if len(parts) < 3:
        return None
    family = ".".join(parts[:2])
    size = parts[2]
    if size in _SIZE_ORDER_GLOBAL:
        idx = _SIZE_ORDER_GLOBAL.index(size)
        if direction == "down" and idx > 0:
            return f"{family}.{_SIZE_ORDER_GLOBAL[idx - 1]}"
        elif direction == "up" and idx < len(_SIZE_ORDER_GLOBAL) - 1:
            return f"{family}.{_SIZE_ORDER_GLOBAL[idx + 1]}"
    return None


# =============================================================================
# CDN 成本优化
# =============================================================================


async def opt_cdn_cost_optimization(
    domain_filter: str = "",
    **kwargs,
) -> str:
    """CDN 成本优化分析。

    检测规则：
    1. 计费方式优化: 带宽利用率 < 30% 推荐按流量计费
    2. RANGE功能: 大文件加速域名应开启 Range 回源
    3. 智能压缩: 文本类资源域名应开启 Gzip/Brotli
    4. 缓存规则: 必须配置缓存规则
    5. 共享缓存: 同源站多域名建议共享缓存

    Args:
        domain_filter: 域名过滤（支持模糊匹配，如 "example.com"）
        **kwargs: 框架注入的参数

    Returns:
        CDN 成本优化报告 (Markdown)
    """
    from products.cdn import (
        list_cdn_domains,
        analyze_cdn_domain,
        analyze_shared_cache_opportunity,
        format_bandwidth,
    )
    
    credential = kwargs.get("credential") or get_credential()
    ak, sk = _get_ak_sk(credential)
    
    # 1. 获取域名列表
    domains = await list_cdn_domains(ak, sk, domain_status="online")
    
    # 过滤域名
    if domain_filter:
        domains = [d for d in domains if domain_filter.lower() in d.domain_name.lower()]
    
    if not domains:
        return json.dumps({
            "success": True,
            "message": "未找到 CDN 域名" + (f"（过滤条件: {domain_filter}）" if domain_filter else ""),
            "domain_count": 0,
        }, ensure_ascii=False, indent=2)
    
    # 2. 分析每个域名
    analyzed_domains = []
    for d in domains:
        try:
            analyzed = await analyze_cdn_domain(ak, sk, d)
            analyzed_domains.append(analyzed)
        except Exception as e:
            logger.warning("分析域名 %s 失败: %s", d.domain_name, e)
    
    # 3. 分析共享缓存机会
    shared_cache_suggestions = await analyze_shared_cache_opportunity(analyzed_domains)
    
    # 4. 汇总问题
    all_issues = []
    for d in analyzed_domains:
        for issue in d.issues:
            all_issues.append({
                "domain": d.domain_name,
                **issue,
            })
    
    # 添加共享缓存建议
    all_issues.extend(shared_cache_suggestions)
    
    # 5. 生成报告
    lines = []
    lines.append("# CDN 成本优化报告")
    lines.append("")
    lines.append(f"> 生成时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    lines.append(f"> 域名数量: {len(analyzed_domains)} 个")
    if domain_filter:
        lines.append(f"> 过滤条件: {domain_filter}")
    lines.append("")
    
    # 概览
    lines.append("## 概览")
    lines.append("")
    
    # 统计
    billing_issues = len([i for i in all_issues if i.get("rule") == "BillingOptimization"])
    range_issues = len([i for i in all_issues if i.get("rule") == "RangeEnable"])
    compress_issues = len([i for i in all_issues if i.get("rule") == "CompressionEnable"])
    cache_issues = len([i for i in all_issues if i.get("rule") == "CacheConfig"])
    shared_issues = len([i for i in all_issues if i.get("rule") == "SharedCache"])
    
    lines.append("| 检测项 | 问题数 | 状态 |")
    lines.append("|--------|-------:|------|")
    lines.append(f"| 计费方式优化 | {billing_issues} | {'🟡 可优化' if billing_issues > 0 else '✅ 正常'} |")
    lines.append(f"| Range 回源 | {range_issues} | {'🔴 需开启' if range_issues > 0 else '✅ 正常'} |")
    lines.append(f"| 智能压缩 | {compress_issues} | {'🟡 建议开启' if compress_issues > 0 else '✅ 正常'} |")
    lines.append(f"| 缓存规则 | {cache_issues} | {'🔴 必须配置' if cache_issues > 0 else '✅ 正常'} |")
    lines.append(f"| 共享缓存 | {shared_issues} | {'🟡 可优化' if shared_issues > 0 else '✅ 正常'} |")
    lines.append("")
    
    # 优化建议
    if all_issues:
        lines.append("## 优化建议")
        lines.append("")
        
        # 按严重程度分组
        high_severity = [i for i in all_issues if i.get("severity") == "high"]
        medium_severity = [i for i in all_issues if i.get("severity") == "medium"]
        
        if high_severity:
            lines.append("### 🔴 高优先级（必须处理）")
            lines.append("")
            lines.append("| 域名 | 检测项 | 问题 | 建议 | 预期效果 |")
            lines.append("|------|--------|------|------|----------|")
            for issue in high_severity:
                domain = issue.get("domain", "-")
                rule_names = {
                    "RangeEnable": "Range 回源",
                    "CacheConfig": "缓存规则",
                }
                rule = rule_names.get(issue.get("rule", ""), issue.get("rule", ""))
                lines.append(
                    f"| {domain} | {rule} | {issue.get('issue', '')} | "
                    f"{issue.get('recommendation', '')} | {issue.get('potential_saving', '')} |"
                )
            lines.append("")
        
        if medium_severity:
            lines.append("### 🟡 中优先级（建议处理）")
            lines.append("")
            lines.append("| 域名 | 检测项 | 问题 | 建议 | 预期效果 |")
            lines.append("|------|--------|------|------|----------|")
            for issue in medium_severity:
                domain = issue.get("domain", "-")
                rule_names = {
                    "BillingOptimization": "计费方式",
                    "CompressionEnable": "智能压缩",
                    "SharedCache": "共享缓存",
                }
                rule = rule_names.get(issue.get("rule", ""), issue.get("rule", ""))
                # 共享缓存特殊处理
                if issue.get("rule") == "SharedCache":
                    domain = f"源站: {issue.get('source', '')[:30]}"
                    issue_text = f"{issue.get('domain_count', 0)} 个域名可共享"
                else:
                    issue_text = issue.get("issue", "")
                lines.append(
                    f"| {domain} | {rule} | {issue_text} | "
                    f"{issue.get('recommendation', '')} | {issue.get('potential_saving', '')} |"
                )
            lines.append("")
    else:
        lines.append("## 分析结论")
        lines.append("")
        lines.append("> 所有 CDN 域名配置均处于健康状态，无需优化操作。")
        lines.append("")
    
    # 域名明细
    lines.append("## 域名明细")
    lines.append("")
    lines.append("| 域名 | 类型 | 源站 | 峰值带宽 | 平均带宽 | 利用率 | Range | 压缩 | 缓存 |")
    lines.append("|------|------|------|-------:|-------:|-------:|:-----:|:----:|:----:|")
    
    for d in analyzed_domains:
        cdn_type_map = {"web": "网页", "download": "下载", "video": "视频"}
        cdn_type = cdn_type_map.get(d.cdn_type, d.cdn_type or "-")
        source = d.source_content[:20] + "..." if len(d.source_content) > 20 else d.source_content or "-"
        peak = format_bandwidth(d.peak_bps) if d.peak_bps > 0 else "-"
        avg = format_bandwidth(d.avg_bps) if d.avg_bps > 0 else "-"
        util = f"{d.utilization_percent:.1f}%" if d.peak_bps > 0 else "-"
        range_icon = "✅" if d.range_enabled else "❌"
        gzip_icon = "✅" if d.gzip_enabled else "❌"
        cache_icon = "✅" if d.cache_configured else "❌"
        
        lines.append(
            f"| {d.domain_name} | {cdn_type} | {source} | {peak} | {avg} | {util} | "
            f"{range_icon} | {gzip_icon} | {cache_icon} |"
        )
    lines.append("")
    
    # 说明
    lines.append("---")
    lines.append("")
    lines.append("注释：")
    lines.append("- **带宽利用率**: 平均带宽 / 峰值带宽×100%，< 30% 推荐流量计费，≥ 30% 推荐带宽计费")
    lines.append("- **Range 回源**: 大文件场景必开，可减少 30%-50% 回源流量")
    lines.append("- **智能压缩**: 文本类资源场景建议开启，可减少 50%-70% 传输流量")
    lines.append("- **缓存规则**: 必须配置，否则回源流量高")
    
    return "\n".join(lines)


async def opt_cdn_utilization_report(
    domain_filter: str = "",
    days: int = 7,
    **kwargs,
) -> str:
    """CDN 域名利用率报告。

    查询域名的带宽使用情况，计算利用率，给出计费方式建议。

    Args:
        domain_filter: 域名过滤（支持模糊匹配）
        days: 查询天数（默认 7 天）
        **kwargs: 框架注入的参数

    Returns:
        CDN 利用率报告 (JSON)
    """
    from products.cdn import (
        list_cdn_domains,
        get_domain_bandwidth_data,
        format_bandwidth,
    )
    
    credential = kwargs.get("credential") or get_credential()
    ak, sk = _get_ak_sk(credential)
    
    # 获取域名列表
    domains = await list_cdn_domains(ak, sk, domain_status="online")
    
    if domain_filter:
        domains = [d for d in domains if domain_filter.lower() in d.domain_name.lower()]
    
    results = []
    for d in domains:
        bw_data = await get_domain_bandwidth_data(ak, sk, d.domain_name, days=days)
        
        # 计费建议
        util = bw_data["utilization_percent"]
        if bw_data["peak_bps"] > 0:
            if util < 30:
                billing_advice = "推荐按流量计费"
            else:
                billing_advice = "推荐按带宽峰值计费"
        else:
            billing_advice = "无流量数据"
        
        results.append({
            "domain_name": d.domain_name,
            "cdn_type": d.cdn_type,
            "source": d.source_content,
            "peak_bps": bw_data["peak_bps"],
            "peak_bps_display": format_bandwidth(bw_data["peak_bps"]),
            "avg_bps": bw_data["avg_bps"],
            "avg_bps_display": format_bandwidth(bw_data["avg_bps"]),
            "utilization_percent": round(util, 1),
            "data_points": bw_data["data_points"],
            "billing_advice": billing_advice,
        })
    
    return json.dumps({
        "success": True,
        "query_days": days,
        "domain_count": len(results),
        "domains": results,
    }, ensure_ascii=False, indent=2)


async def opt_cdn_config_check(
    domain_name: str,
    **kwargs,
) -> str:
    """查询 CDN 域名配置。

    检测域名的 Range 回源、智能压缩、缓存规则配置。

    Args:
        domain_name: 域名
        **kwargs: 框架注入的参数

    Returns:
        域名配置信息 (JSON)
    """
    from products.cdn import get_domain_configs
    
    credential = kwargs.get("credential") or get_credential()
    ak, sk = _get_ak_sk(credential)
    
    configs = await get_domain_configs(ak, sk, domain_name)
    
    # 给出建议
    recommendations = []
    if not configs["range_enabled"]:
        recommendations.append({
            "item": "Range 回源",
            "status": "未开启",
            "recommendation": "大文件场景建议开启，可减少回源流量",
        })
    if not configs["gzip_enabled"] and not configs.get("brotli_enabled"):
        recommendations.append({
            "item": "智能压缩",
            "status": "未开启",
            "recommendation": "文本资源场景建议开启 Gzip 或 Brotli",
        })
    if not configs["cache_configured"]:
        recommendations.append({
            "item": "缓存规则",
            "status": "未配置",
            "recommendation": "必须配置缓存规则，否则 CDN 缓存效果差",
        })
    
    return json.dumps({
        "success": True,
        "domain_name": domain_name,
        "configs": {
            "range_enabled": configs["range_enabled"],
            "gzip_enabled": configs["gzip_enabled"],
            "brotli_enabled": configs.get("brotli_enabled", False),
            "cache_configured": configs["cache_configured"],
            "cache_rules": configs["cache_rules"],
        },
        "recommendations": recommendations,
    }, ensure_ascii=False, indent=2)


# =============================================================================
# Redis 成本优化
# =============================================================================


async def opt_redis_cost_optimization(
    region_id: str = "cn-hangzhou",
    days: int = 30,
    **kwargs,
) -> str:
    """Redis 成本优化分析。

    检测规则：
    1. 闲置资源: CPU/内存/连接数 峰值<=10% 且 均值<=5%, QPS 峰值<=50 且 均值<=25
    2. 低利用率: CPU/内存/连接数/QPS 峰值<=30% 且 均值<=15%
    3. 计费方式: 按量超过30天 + 费用对比 → 建议转包月

    Args:
        region_id: 区域 ID
        days: 检测天数（默认 30 天）
        **kwargs: 框架注入的参数

    Returns:
        Redis 成本优化报告 (Markdown)
    """
    credential = kwargs.get("credential") or get_credential()
    redis_client = _build_client(credential, "redis", region_id)
    cms_client = _build_client(credential, "cms", region_id)
    bss_client = _build_client(credential, "bss", region_id)
    
    try:
        # 1. 获取所有 Redis 实例
        all_instances = []
        page = 1
        while True:
            req = redis_models.DescribeInstancesRequest(
                region_id=region_id,
                page_number=page,
                page_size=50,
            )
            resp = await asyncio.to_thread(redis_client.describe_instances, req)
            body = resp.body
            if body.instances and body.instances.kvstore_instance:
                all_instances.extend(body.instances.kvstore_instance)
            total = body.total_count or 0
            if len(all_instances) >= total:
                break
            page += 1
        
        # 2. 分析每个实例
        issues = []
        analyzed_instances = []
        
        for inst in all_instances:
            inst_id = inst.instance_id or ""
            inst_name = inst.instance_name or ""
            inst_class = inst.instance_class or ""
            status = inst.instance_status or ""
            charge_type = inst.charge_type or ""
            create_time = inst.create_time or ""
            
            if status != "Normal":
                continue
            
            # 查询 4 项指标的峰值和均值
            cpu_avg = await _get_cms_metric_avg(
                cms_client, "acs_kvstore", "CpuUsage",
                [{"instanceId": inst_id}], days=days,
            )
            cpu_max = await _get_cms_metric_max(
                cms_client, "acs_kvstore", "CpuUsage",
                [{"instanceId": inst_id}], period=3600, days=days,
            )
            mem_avg = await _get_cms_metric_avg(
                cms_client, "acs_kvstore", "MemoryUsage",
                [{"instanceId": inst_id}], days=days,
            )
            mem_max = await _get_cms_metric_max(
                cms_client, "acs_kvstore", "MemoryUsage",
                [{"instanceId": inst_id}], period=3600, days=days,
            )
            conn_avg = await _get_cms_metric_avg(
                cms_client, "acs_kvstore", "ConnectionUsage",
                [{"instanceId": inst_id}], days=days,
            )
            conn_max = await _get_cms_metric_max(
                cms_client, "acs_kvstore", "ConnectionUsage",
                [{"instanceId": inst_id}], period=3600, days=days,
            )
            qps_avg = await _get_cms_metric_avg(
                cms_client, "acs_kvstore", "UsedQPS",
                [{"instanceId": inst_id}], days=days,
            )
            qps_max = await _get_cms_metric_max(
                cms_client, "acs_kvstore", "UsedQPS",
                [{"instanceId": inst_id}], period=3600, days=days,
            )
            
            # 处理无效数据
            cpu_max = max(cpu_max, 0)
            mem_max = max(mem_max, 0)
            conn_max = max(conn_max, 0)
            qps_max = max(qps_max, 0)
            
            metrics = {
                "cpu_avg": round(cpu_avg, 1),
                "cpu_max": round(cpu_max, 1),
                "mem_avg": round(mem_avg, 1),
                "mem_max": round(mem_max, 1),
                "conn_avg": round(conn_avg, 1),
                "conn_max": round(conn_max, 1),
                "qps_avg": round(qps_avg, 1),
                "qps_max": round(qps_max, 1),
            }
            
            # 闲置检测: 所有指标都极低
            is_idle = (
                cpu_max <= 10 and cpu_avg <= 5 and
                mem_max <= 10 and mem_avg <= 5 and
                conn_max <= 10 and conn_avg <= 5 and
                qps_max <= 50 and qps_avg <= 25
            )
            
            # 低利用率检测
            is_low_util = (
                cpu_max <= 30 and cpu_avg <= 15 and
                mem_max <= 30 and mem_avg <= 15 and
                conn_max <= 30 and conn_avg <= 15 and
                qps_max <= 30 and qps_avg <= 15  # QPS 利用率
            )
            
            # 计算持有天数
            hold_days = 0
            if create_time:
                try:
                    if "T" in create_time:
                        create_dt = datetime.fromisoformat(create_time.replace("Z", "+00:00"))
                    else:
                        create_dt = datetime.strptime(create_time[:19], "%Y-%m-%d %H:%M:%S")
                        create_dt = create_dt.replace(tzinfo=timezone.utc)
                    hold_days = (datetime.now(timezone.utc) - create_dt).days
                except:
                    pass
            
            # 按量转包月检测
            should_convert = False
            if charge_type in ["PostPaid", "POSTPAY"] and hold_days >= 30:
                # 查询账单获取当前费用
                current_cost = await _bss_query_instance_bill(
                    bss_client, inst_id, product_code="redisa"
                )
                # TODO: 查询包月价格进行对比
                if current_cost > 0:
                    should_convert = True
            
            inst_info = {
                "instance_id": inst_id,
                "instance_name": inst_name,
                "instance_class": inst_class,
                "charge_type": charge_type,
                "hold_days": hold_days,
                "metrics": metrics,
                "is_idle": is_idle,
                "is_low_util": is_low_util and not is_idle,
                "should_convert": should_convert,
            }
            analyzed_instances.append(inst_info)
            
            # 记录问题
            if is_idle:
                issues.append({
                    "instance_id": inst_id,
                    "instance_name": inst_name,
                    "rule": "IdleResource",
                    "severity": "high",
                    "issue": f"CPU/内存/连接数峰值<10%，QPS峰值<50",
                    "recommendation": "建议释放或降配",
                    "metrics": metrics,
                })
            elif is_low_util:
                issues.append({
                    "instance_id": inst_id,
                    "instance_name": inst_name,
                    "rule": "LowUtilization",
                    "severity": "medium",
                    "issue": f"CPU/内存/连接数/QPS峰值<30%，均值<15%",
                    "recommendation": "建议评估降配",
                    "metrics": metrics,
                })
            
            if should_convert:
                issues.append({
                    "instance_id": inst_id,
                    "instance_name": inst_name,
                    "rule": "BillingOptimization",
                    "severity": "medium",
                    "issue": f"按量付费已持有 {hold_days} 天",
                    "recommendation": "建议转为包年包月",
                    "hold_days": hold_days,
                })
        
        # 3. 生成报告
        lines = []
        lines.append("# Redis 成本优化报告")
        lines.append("")
        lines.append(f"> 生成时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
        lines.append(f"> 分析区域: {region_id}")
        lines.append(f"> 检测周期: {days} 天")
        lines.append("")
        
        # 概览
        idle_count = len([i for i in issues if i["rule"] == "IdleResource"])
        low_util_count = len([i for i in issues if i["rule"] == "LowUtilization"])
        billing_count = len([i for i in issues if i["rule"] == "BillingOptimization"])
        
        lines.append("## 概览")
        lines.append("")
        lines.append("| 检测项 | 问题数 | 状态 |")
        lines.append("|--------|-------:|------|")
        lines.append(f"| 实例总数 | {len(analyzed_instances)} | - |")
        lines.append(f"| 闲置资源 | {idle_count} | {'🔴 需关注' if idle_count > 0 else '✅ 正常'} |")
        lines.append(f"| 低利用率 | {low_util_count} | {'🟡 可优化' if low_util_count > 0 else '✅ 正常'} |")
        lines.append(f"| 计费优化 | {billing_count} | {'🟡 可优化' if billing_count > 0 else '✅ 正常'} |")
        lines.append("")
        
        # 优化建议
        if issues:
            lines.append("## 优化建议")
            lines.append("")
            
            if idle_count > 0:
                lines.append("### 🔴 闲置资源（建议释放）")
                lines.append("")
                lines.append("| 实例 ID | 实例名 | 规格 | CPU峰/均 | 内存峰/均 | 连接峰/均 | QPS峰/均 |")
                lines.append("|----------|--------|------|----------|----------|----------|---------|")
                for issue in [i for i in issues if i["rule"] == "IdleResource"]:
                    m = issue["metrics"]
                    inst = next((x for x in analyzed_instances if x["instance_id"] == issue["instance_id"]), {})
                    lines.append(
                        f"| `{issue['instance_id']}` | {issue['instance_name'][:10] or '-'} | "
                        f"{inst.get('instance_class', '-')} | {m['cpu_max']}/{m['cpu_avg']}% | "
                        f"{m['mem_max']}/{m['mem_avg']}% | {m['conn_max']}/{m['conn_avg']}% | "
                        f"{m['qps_max']}/{m['qps_avg']} |"
                    )
                lines.append("")
            
            if low_util_count > 0:
                lines.append("### 🟡 低利用率（建议降配）")
                lines.append("")
                lines.append("| 实例 ID | 实例名 | 规格 | CPU峰/均 | 内存峰/均 | 连接峰/均 | QPS峰/均 |")
                lines.append("|----------|--------|------|----------|----------|----------|---------|")
                for issue in [i for i in issues if i["rule"] == "LowUtilization"]:
                    m = issue["metrics"]
                    inst = next((x for x in analyzed_instances if x["instance_id"] == issue["instance_id"]), {})
                    lines.append(
                        f"| `{issue['instance_id']}` | {issue['instance_name'][:10] or '-'} | "
                        f"{inst.get('instance_class', '-')} | {m['cpu_max']}/{m['cpu_avg']}% | "
                        f"{m['mem_max']}/{m['mem_avg']}% | {m['conn_max']}/{m['conn_avg']}% | "
                        f"{m['qps_max']}/{m['qps_avg']} |"
                    )
                lines.append("")
            
            if billing_count > 0:
                lines.append("### 🟡 计费优化（建议转包月）")
                lines.append("")
                lines.append("| 实例 ID | 实例名 | 规格 | 持有天数 | 建议 |")
                lines.append("|----------|--------|------|----------|------|")
                for issue in [i for i in issues if i["rule"] == "BillingOptimization"]:
                    inst = next((x for x in analyzed_instances if x["instance_id"] == issue["instance_id"]), {})
                    lines.append(
                        f"| `{issue['instance_id']}` | {issue['instance_name'][:10] or '-'} | "
                        f"{inst.get('instance_class', '-')} | {issue['hold_days']} 天 | 转包月 |"
                    )
                lines.append("")
        else:
            lines.append("## 分析结论")
            lines.append("")
            lines.append("> 所有 Redis 实例均处于健康状态，无需优化操作。")
            lines.append("")
        
        # 检测规则说明
        lines.append("---")
        lines.append("")
        lines.append("检测规则说明：")
        lines.append("- **闲置**: CPU/内存/连接数峰值≤10% 且 均值≤5%, QPS峰值≤50 且 均值≤25")
        lines.append("- **低利用率**: CPU/内存/连接数/QPS 峰值≤30% 且 均值≤15%")
        lines.append("- **计费优化**: 按量付费超过30天，建议转包月")
        
        return "\n".join(lines)
    
    except Exception as e:
        logger.error("Redis 成本优化分析失败: %s", e)
        return json.dumps({
            "success": False, "error": str(e),
        }, ensure_ascii=False)


# =============================================================================
# NAT 网关成本优化
# =============================================================================


async def opt_nat_idle_check(
    region_id: str = "cn-hangzhou",
    days: int = 7,
    **kwargs,
) -> str:
    """NAT 网关闲置检测。

    闲置判定规则（检测周期内）：
    - 无绑定 EIP
    - 或者：无 DNAT 条目 且 无 SNAT 条目

    Args:
        region_id: 区域 ID
        days: 检测周期（默认 7 天）
        **kwargs: 框架注入的参数

    Returns:
        NAT 闲置检测报告 (Markdown)
    """
    credential = kwargs.get("credential") or get_credential()
    vpc_client = _build_client(credential, "vpc", region_id)
    
    try:
        # 1. 获取所有 NAT 网关
        all_nats = []
        page = 1
        while True:
            req = vpc_models.DescribeNatGatewaysRequest(
                region_id=region_id,
                page_number=page,
                page_size=50,
            )
            resp = await asyncio.to_thread(vpc_client.describe_nat_gateways, req)
            body = resp.body
            if body.nat_gateways and body.nat_gateways.nat_gateway:
                all_nats.extend(body.nat_gateways.nat_gateway)
            total = body.total_count or 0
            if len(all_nats) >= total:
                break
            page += 1
        
        # 2. 分析每个 NAT 网关
        issues = []
        analyzed_nats = []
        
        for nat in all_nats:
            nat_id = nat.nat_gateway_id or ""
            nat_name = nat.name or ""
            status = nat.status or ""
            nat_type = nat.nat_type or ""
            spec = nat.spec or ""
            
            if status != "Available":
                continue
            
            # 获取绑定的 EIP
            eip_list = []
            if nat.ip_lists and nat.ip_lists.ip_list:
                for ip_item in nat.ip_lists.ip_list:
                    eip_list.append(ip_item.ip_address or "")
            
            # 查询 SNAT 条目数
            snat_count = 0
            try:
                snat_req = vpc_models.DescribeSnatTableEntriesRequest(
                    region_id=region_id,
                    snat_table_id=nat.snat_table_ids.snat_table_id[0] if nat.snat_table_ids and nat.snat_table_ids.snat_table_id else "",
                    page_size=1,
                )
                if snat_req.snat_table_id:
                    snat_resp = await asyncio.to_thread(vpc_client.describe_snat_table_entries, snat_req)
                    snat_count = snat_resp.body.total_count or 0
            except:
                pass
            
            # 查询 DNAT 条目数
            dnat_count = 0
            try:
                dnat_req = vpc_models.DescribeForwardTableEntriesRequest(
                    region_id=region_id,
                    forward_table_id=nat.forward_table_ids.forward_table_id[0] if nat.forward_table_ids and nat.forward_table_ids.forward_table_id else "",
                    page_size=1,
                )
                if dnat_req.forward_table_id:
                    dnat_resp = await asyncio.to_thread(vpc_client.describe_forward_table_entries, dnat_req)
                    dnat_count = dnat_resp.body.total_count or 0
            except:
                pass
            
            # 闲置判定
            has_eip = len(eip_list) > 0
            has_rules = snat_count > 0 or dnat_count > 0
            
            is_idle = not has_eip or not has_rules
            idle_reason = []
            if not has_eip:
                idle_reason.append("无绑定EIP")
            if not has_rules:
                if snat_count == 0:
                    idle_reason.append("无SNAT条目")
                if dnat_count == 0:
                    idle_reason.append("无DNAT条目")
            
            nat_info = {
                "nat_id": nat_id,
                "nat_name": nat_name,
                "nat_type": nat_type,
                "spec": spec,
                "eip_count": len(eip_list),
                "eip_list": eip_list,
                "snat_count": snat_count,
                "dnat_count": dnat_count,
                "is_idle": is_idle,
                "idle_reason": idle_reason,
            }
            analyzed_nats.append(nat_info)
            
            if is_idle:
                issues.append({
                    "nat_id": nat_id,
                    "nat_name": nat_name,
                    "rule": "IdleResource",
                    "severity": "high",
                    "issue": ", ".join(idle_reason),
                    "recommendation": "NAT闲置资源建议结合实际业务考虑对实例进行释放",
                })
        
        # 3. 生成报告
        lines = []
        lines.append("# NAT 网关闲置检测报告")
        lines.append("")
        lines.append(f"> 生成时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
        lines.append(f"> 分析区域: {region_id}")
        lines.append("")
        
        # 概览
        idle_count = len(issues)
        
        lines.append("## 概览")
        lines.append("")
        lines.append("| 检测项 | 数量 | 状态 |")
        lines.append("|--------|-----:|------|")
        lines.append(f"| NAT 总数 | {len(analyzed_nats)} | - |")
        lines.append(f"| 闲置 NAT | {idle_count} | {'🔴 需关注' if idle_count > 0 else '✅ 正常'} |")
        lines.append("")
        
        # 闲置详情
        if issues:
            lines.append("## 闲置 NAT 详情")
            lines.append("")
            lines.append("| NAT ID | 名称 | 类型 | 规格 | EIP数 | SNAT | DNAT | 闲置原因 |")
            lines.append("|--------|------|------|------|------:|-----:|-----:|----------|")
            for nat in [n for n in analyzed_nats if n["is_idle"]]:
                lines.append(
                    f"| `{nat['nat_id']}` | {nat['nat_name'][:10] or '-'} | "
                    f"{nat['nat_type']} | {nat['spec']} | {nat['eip_count']} | "
                    f"{nat['snat_count']} | {nat['dnat_count']} | {', '.join(nat['idle_reason'])} |"
                )
            lines.append("")
            lines.append("> **建议**: NAT闲置资源建议结合实际业务考虑对实例进行释放")
        else:
            lines.append("## 分析结论")
            lines.append("")
            lines.append("> 所有 NAT 网关均正常使用，无闲置资源。")
        
        lines.append("")
        lines.append("---")
        lines.append("")
        lines.append("检测规则说明：")
        lines.append("- **闲置判定**: 无绑定EIP，或者无DNAT条目且无SNAT条目")
        
        return "\n".join(lines)
    
    except Exception as e:
        logger.error("NAT 闲置检测失败: %s", e)
        return json.dumps({
            "success": False, "error": str(e),
        }, ensure_ascii=False)


# =============================================================================
# NAS 文件存储成本优化
# =============================================================================


async def opt_nas_cost_optimization(
    region_id: str = "cn-hangzhou",
    **kwargs,
) -> str:
    """NAS 成本优化分析。

    检测规则：
    - 通用型 NAS 需开启生命周期管理（自动转储冷数据到低频介质）
    - 未开启生命周期策略的文件系统可通过此功能降低存储成本

    Args:
        region_id: 区域 ID
        **kwargs: 框架注入的参数

    Returns:
        NAS 成本优化报告 (Markdown)
    """
    credential = kwargs.get("credential") or get_credential()
    nas_client = _build_client(credential, "nas", region_id)
    
    try:
        # 1. 获取所有文件系统
        all_filesystems = []
        page = 1
        while True:
            req = nas_models.DescribeFileSystemsRequest(
                page_number=page,
                page_size=100,
            )
            resp = await asyncio.to_thread(nas_client.describe_file_systems, req)
            body = resp.body
            if body.file_systems and body.file_systems.file_system:
                all_filesystems.extend(body.file_systems.file_system)
            total = body.total_count or 0
            if len(all_filesystems) >= total:
                break
            page += 1
        
        # 2. 分析每个文件系统
        issues = []
        analyzed_fs = []
        
        for fs in all_filesystems:
            fs_id = fs.file_system_id or ""
            fs_type = fs.file_system_type or ""  # standard / extreme / cpfs
            protocol = fs.protocol_type or ""  # NFS / SMB
            storage_type = fs.storage_type or ""  # Capacity / Performance
            status = fs.status or ""
            capacity = fs.capacity or 0  # 容量 GB
            used_size = fs.metered_size or 0  # 已使用字节数
            used_gb = round(used_size / (1024 ** 3), 2) if used_size else 0
            
            if status != "Running":
                continue
            
            # 只检测通用型 NAS（standard 类型）
            is_general_purpose = fs_type == "standard"
            
            # 查询生命周期策略
            lifecycle_enabled = False
            lifecycle_policies = []
            
            if is_general_purpose:
                try:
                    lc_req = nas_models.DescribeLifecyclePoliciesRequest(
                        file_system_id=fs_id,
                        page_number=1,
                        page_size=100,
                    )
                    lc_resp = await asyncio.to_thread(nas_client.describe_lifecycle_policies, lc_req)
                    if lc_resp.body.lifecycle_policies:
                        policies = lc_resp.body.lifecycle_policies
                        if hasattr(policies, "lifecycle_policy") and policies.lifecycle_policy:
                            lifecycle_policies = [
                                {
                                    "name": p.lifecycle_policy_name or "",
                                    "path": p.path or "",
                                    "rule": p.lifecycle_rule_name or "",
                                }
                                for p in policies.lifecycle_policy
                            ]
                            lifecycle_enabled = len(lifecycle_policies) > 0
                except Exception as lc_err:
                    logger.warning("查询 NAS 生命周期策略失败 %s: %s", fs_id, lc_err)
            
            fs_info = {
                "fs_id": fs_id,
                "fs_type": fs_type,
                "protocol": protocol,
                "storage_type": storage_type,
                "capacity_gb": capacity,
                "used_gb": used_gb,
                "is_general_purpose": is_general_purpose,
                "lifecycle_enabled": lifecycle_enabled,
                "lifecycle_policies": lifecycle_policies,
            }
            analyzed_fs.append(fs_info)
            
            # 通用型 NAS 未开启生命周期管理
            if is_general_purpose and not lifecycle_enabled:
                issues.append({
                    "fs_id": fs_id,
                    "rule": "LifecycleManagement",
                    "severity": "medium",
                    "fs_type": fs_type,
                    "storage_type": storage_type,
                    "used_gb": used_gb,
                    "issue": "未开启生命周期管理",
                    "recommendation": "建议开启生命周期管理，自动将不常访问的数据转储到低频存储介质",
                    "potential_saving": "低频存储单价比通用存储低约 92%",
                })
        
        # 3. 生成报告
        lines = []
        lines.append("# NAS 成本优化报告")
        lines.append("")
        lines.append(f"> 生成时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
        lines.append(f"> 分析区域: {region_id}")
        lines.append("")
        
        # 概览
        general_count = len([f for f in analyzed_fs if f["is_general_purpose"]])
        no_lifecycle_count = len(issues)
        
        lines.append("## 概览")
        lines.append("")
        lines.append("| 检测项 | 数量 | 状态 |")
        lines.append("|--------|-----:|------|")
        lines.append(f"| NAS 文件系统总数 | {len(analyzed_fs)} | - |")
        lines.append(f"| 通用型 NAS | {general_count} | - |")
        lines.append(f"| 未开启生命周期管理 | {no_lifecycle_count} | {'🟡 可优化' if no_lifecycle_count > 0 else '✅ 正常'} |")
        lines.append("")
        
        # 优化建议
        if issues:
            lines.append("## 优化建议 - 开启生命周期管理")
            lines.append("")
            lines.append("| 文件系统 ID | 类型 | 存储类型 | 已用容量 | 建议 |")
            lines.append("|-------------|------|----------|----------|------|")
            for issue in issues:
                lines.append(
                    f"| `{issue['fs_id']}` | {issue['fs_type']} | "
                    f"{issue['storage_type']} | {issue['used_gb']} GB | 开启生命周期管理 |"
                )
            lines.append("")
            lines.append("> **建议**: 开启生命周期管理后，不常访问的数据会自动转储到低频存储介质，")
            lines.append("> 低频存储单价比通用存储低约 92%，可显著降低存储成本。")
        else:
            lines.append("## 分析结论")
            lines.append("")
            if general_count == 0:
                lines.append("> 当前区域无通用型 NAS 文件系统，无需配置生命周期管理。")
            else:
                lines.append("> 所有通用型 NAS 均已开启生命周期管理，配置良好。")
        
        lines.append("")
        lines.append("---")
        lines.append("")
        lines.append("检测规则说明：")
        lines.append("- **生命周期管理**: 通用型 NAS 应开启生命周期管理功能")
        lines.append("- **低频存储**: 自动将不常访问的数据转储，降低 92% 存储成本")
        
        return "\n".join(lines)
    
    except Exception as e:
        logger.error("NAS 成本优化分析失败: %s", e)
        return json.dumps({
            "success": False, "error": str(e),
        }, ensure_ascii=False)


# =============================================================================
# SLS 日志服务成本优化
# =============================================================================


async def opt_sls_cost_optimization(
    region_id: str = "cn-hangzhou",
    **kwargs,
) -> str:
    """SLS 成本优化分析。

    检测规则：
    - 检测未开启智能存储分层的 Logstore
    - 智能分层可自动将冷数据转储到低成本存储，降低 70% 存储成本

    Args:
        region_id: 区域 ID
        **kwargs: 框架注入的参数

    Returns:
        SLS 成本优化报告 (Markdown)

    注意：
        SLS 使用 alibabacloud_sls20201230 SDK
    """
    credential = kwargs.get("credential") or get_credential()
    ak, sk = _get_ak_sk(credential)
    
    try:
        # 动态导入 SLS SDK
        try:
            from alibabacloud_sls20201230.client import Client as SlsClient
            from alibabacloud_sls20201230 import models as sls_models
        except ImportError:
            return json.dumps({
                "success": False,
                "error": "alibabacloud_sls20201230 SDK 未安装，请执行: pip install alibabacloud_sls20201230",
            }, ensure_ascii=False)
        
        # 构建 SLS Client
        sls_config = Config(
            access_key_id=ak,
            access_key_secret=sk,
            endpoint=f"{region_id}.log.aliyuncs.com",
            region_id=region_id,
        )
        sls_client = SlsClient(sls_config)
        
        # 1. 获取所有 Project
        all_projects = []
        offset = 0
        while True:
            req = sls_models.ListProjectRequest(
                offset=offset,
                size=100,
            )
            resp = await asyncio.to_thread(sls_client.list_project, req)
            if resp.body.projects:
                all_projects.extend(resp.body.projects)
            total = resp.body.total or 0
            if len(all_projects) >= total:
                break
            offset += 100
        
        # 2. 分析每个 Project 的 Logstore
        issues = []
        analyzed_logstores = []
        
        for project in all_projects:
            project_name = project.project_name or ""
            
            # 获取 Project 下的所有 Logstore
            logstores = []
            ls_offset = 0
            while True:
                try:
                    ls_req = sls_models.ListLogStoresRequest(
                        offset=ls_offset,
                        size=100,
                    )
                    ls_resp = await asyncio.to_thread(
                        sls_client.list_log_stores, project_name, ls_req
                    )
                    if ls_resp.body.logstores:
                        logstores.extend(ls_resp.body.logstores)
                    ls_total = ls_resp.body.total or 0
                    if len(logstores) >= ls_total:
                        break
                    ls_offset += 100
                except Exception as ls_err:
                    logger.warning("列举 Logstore 失败 %s: %s", project_name, ls_err)
                    break
            
            # 检查每个 Logstore 的配置
            for logstore_name in logstores:
                try:
                    # 获取 Logstore 详情
                    detail_resp = await asyncio.to_thread(
                        sls_client.get_log_store, project_name, logstore_name
                    )
                    logstore = detail_resp.body
                    
                    # 检测智能存储分层（hot_ttl > 0 表示开启了热存储，实现了分层）
                    # 如果 hot_ttl = ttl 或 hot_ttl = 0，说明没有开启分层
                    ttl = logstore.ttl or 0
                    hot_ttl = logstore.hot_ttl or 0
                    
                    # 判断是否开启智能分层
                    # 分层条件：hot_ttl > 0 且 hot_ttl < ttl
                    has_tiering = hot_ttl > 0 and hot_ttl < ttl
                    
                    logstore_info = {
                        "project": project_name,
                        "logstore": logstore_name,
                        "ttl": ttl,
                        "hot_ttl": hot_ttl,
                        "has_tiering": has_tiering,
                    }
                    analyzed_logstores.append(logstore_info)
                    
                    # 未开启智能分层且保留时间较长的 Logstore
                    if not has_tiering and ttl > 7:
                        issues.append({
                            "project": project_name,
                            "logstore": logstore_name,
                            "rule": "NoTiering",
                            "severity": "medium",
                            "ttl": ttl,
                            "hot_ttl": hot_ttl,
                            "issue": f"保留 {ttl} 天但未开启智能分层",
                            "recommendation": "开启智能存储分层，冷数据自动转储到低成本存储",
                            "potential_saving": "冷存储成本比热存储低约 70%",
                        })
                
                except Exception as detail_err:
                    logger.warning("获取 Logstore 详情失败 %s/%s: %s", 
                                   project_name, logstore_name, detail_err)
        
        # 3. 生成报告
        lines = []
        lines.append("# SLS 成本优化报告")
        lines.append("")
        lines.append(f"> 生成时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
        lines.append(f"> 分析区域: {region_id}")
        lines.append("")
        
        # 概览
        no_tiering_count = len(issues)
        
        lines.append("## 概览")
        lines.append("")
        lines.append("| 检测项 | 数量 | 状态 |")
        lines.append("|--------|-----:|------|")
        lines.append(f"| Project 总数 | {len(all_projects)} | - |")
        lines.append(f"| Logstore 总数 | {len(analyzed_logstores)} | - |")
        lines.append(f"| 未开启智能分层 | {no_tiering_count} | {'🟡 可优化' if no_tiering_count > 0 else '✅ 正常'} |")
        lines.append("")
        
        # 优化建议
        if issues:
            lines.append("## 优化建议 - 开启智能存储分层")
            lines.append("")
            lines.append("| Project | Logstore | 保留天数 | 热存储天数 | 建议 |")
            lines.append("|---------|----------|----------|------------|------|")
            for issue in issues:
                hot_ttl_str = str(issue['hot_ttl']) if issue['hot_ttl'] > 0 else "未配置"
                lines.append(
                    f"| `{issue['project']}` | `{issue['logstore']}` | "
                    f"{issue['ttl']} | {hot_ttl_str} | 开启智能分层 |"
                )
            lines.append("")
            lines.append("> **建议**: 开启智能存储分层后，访问频率低的日志数据会自动转储到冷存储，")
            lines.append("> 冷存储成本比热存储低约 70%，可显著降低长期存储成本。")
        else:
            lines.append("## 分析结论")
            lines.append("")
            if len(analyzed_logstores) == 0:
                lines.append("> 当前区域无 SLS Logstore。")
            else:
                lines.append("> 所有 Logstore 均已开启智能存储分层或保留期较短，配置良好。")
        
        lines.append("")
        lines.append("---")
        lines.append("")
        lines.append("检测规则说明：")
        lines.append("- **智能分层**: 保留时间 > 7 天的 Logstore 应开启智能存储分层")
        lines.append("- **冷存储**: 自动将不常访问的日志转储，降低 70% 存储成本")
        
        return "\n".join(lines)
    
    except Exception as e:
        logger.error("SLS 成本优化分析失败: %s", e)
        return json.dumps({
            "success": False, "error": str(e),
        }, ensure_ascii=False)


# =============================================================================
# PolarDB-X (DRDS) 分布式数据库成本优化
# =============================================================================


async def opt_drds_cost_optimization(
    region_id: str = "cn-hangzhou",
    days: int = 30,
    **kwargs,
) -> str:
    """PolarDB-X 分布式版成本优化分析。

    检测规则：
    - 闲置: CPU峰值≤1%且均值≤1%, 内存峰值≤30%且均值≤15%, 连接数峰值≤50且均值≤25, QPS峰值≤50且均值≤25
    - 低利用率: CPU/内存 峰值≤30%且均值≤15%
    - 计费优化: 按量付费超过 30 天

    Args:
        region_id: 区域 ID
        days: 检测周期（默认 30 天）
        **kwargs: 框架注入的参数

    Returns:
        PolarDB-X 成本优化报告 (Markdown)
    """
    credential = kwargs.get("credential") or get_credential()
    cms_client = _build_client(credential, "cms", region_id)
    
    try:
        # 动态导入 PolarDB-X SDK
        try:
            from alibabacloud_polardbx20200202.client import Client as PolardbxClient
            from alibabacloud_polardbx20200202 import models as polardbx_models
        except ImportError:
            return json.dumps({
                "success": False,
                "error": "alibabacloud_polardbx20200202 SDK 未安装，请执行: pip install alibabacloud_polardbx20200202",
            }, ensure_ascii=False)
        
        # 构建 PolarDB-X Client
        ak, sk = _get_ak_sk(credential)
        polardbx_config = Config(
            access_key_id=ak,
            access_key_secret=sk,
            endpoint=f"polardbx.{region_id}.aliyuncs.com",
            region_id=region_id,
        )
        polardbx_client = PolardbxClient(polardbx_config)
        
        # 1. 获取所有实例
        all_instances = []
        page = 1
        while True:
            req = polardbx_models.DescribeDBInstancesRequest(
                region_id=region_id,
                page_number=page,
                page_size=50,
            )
            resp = await asyncio.to_thread(polardbx_client.describe_dbinstances, req)
            if resp.body.dbinstances:
                all_instances.extend(resp.body.dbinstances)
            total = resp.body.total_number or 0
            if len(all_instances) >= total:
                break
            page += 1
        
        # 2. 分析每个实例
        issues = []
        analyzed_instances = []
        
        from products import drds as drds_config
        
        for inst in all_instances:
            inst_id = inst.dbinstance_id or ""
            inst_name = inst.description or ""
            status = inst.status or ""
            
            if status not in ("Running", "RUNNING"):
                continue
            
            # 查询监控数据
            cpu_data = await _get_cms_metric_datapoints(
                cms_client, "acs_drds", "CpuUsage",
                [{"instanceId": inst_id}], days=days,
            )
            mem_data = await _get_cms_metric_datapoints(
                cms_client, "acs_drds", "MemoryUsage",
                [{"instanceId": inst_id}], days=days,
            )
            conn_data = await _get_cms_metric_datapoints(
                cms_client, "acs_drds", "ConnectionCount",
                [{"instanceId": inst_id}], days=days,
            )
            qps_data = await _get_cms_metric_datapoints(
                cms_client, "acs_drds", "LogicQPS",
                [{"instanceId": inst_id}], days=days,
            )
            
            # 计算峰值和均值
            def calc_stats(data):
                if not data:
                    return 0.0, 0.0
                values = [_safe_float(p.get("Average", p.get("average", 0))) for p in data]
                return max(values) if values else 0.0, sum(values) / len(values) if values else 0.0
            
            cpu_max, cpu_avg = calc_stats(cpu_data)
            mem_max, mem_avg = calc_stats(mem_data)
            conn_max, conn_avg = calc_stats(conn_data)
            qps_max, qps_avg = calc_stats(qps_data)
            
            metrics = drds_config.DrdsMetrics(
                cpu_max=cpu_max, cpu_avg=cpu_avg,
                mem_max=mem_max, mem_avg=mem_avg,
                conn_max=conn_max, conn_avg=conn_avg,
                qps_max=qps_max, qps_avg=qps_avg,
            )
            
            inst_info = drds_config.DrdsInstanceInfo(
                instance_id=inst_id,
                instance_name=inst_name,
                instance_class=inst.commodity_code or "",
                engine="polarx",
                engine_version=inst.engine_version or "",
                charge_type=inst.pay_type or "",
                create_time=inst.create_time or "",
                status=status,
                region_id=region_id,
                node_count=inst.node_count or 0,
                metrics=metrics,
            )
            
            # 检测闲置
            if drds_config.check_idle(metrics):
                inst_info.is_idle = True
                inst_info.issues.append({
                    "rule": "IdleResource",
                    "severity": "high",
                })
            # 检测低利用率
            elif drds_config.check_low_utilization(metrics):
                inst_info.is_low_util = True
                inst_info.issues.append({
                    "rule": "LowUtilization",
                    "severity": "medium",
                })
            
            # 检测计费优化
            needs_billing, hold_days = drds_config.check_billing_optimization(
                inst_info.charge_type, inst_info.create_time
            )
            if needs_billing:
                inst_info.billing_issue = True
                inst_info.issues.append({
                    "rule": "BillingOptimization",
                    "severity": "medium",
                    "hold_days": hold_days,
                })
            
            analyzed_instances.append(inst_info)
        
        # 3. 生成报告
        lines = drds_config.generate_report_lines(analyzed_instances, region_id, days)
        return "\n".join(lines)
    
    except Exception as e:
        logger.error("PolarDB-X 成本优化分析失败: %s", e)
        return json.dumps({
            "success": False, "error": str(e),
        }, ensure_ascii=False)


# =============================================================================
# MSE 微服务引擎注册中心成本优化
# =============================================================================


async def opt_mse_cost_optimization(
    region_id: str = "cn-hangzhou",
    days: int = 30,
    **kwargs,
) -> str:
    """MSE 注册中心成本优化分析。

    检测规则：
    - 闲置(Eureka/Nacos): 超过7天健康实例数为0
    - 闲置(Zookeeper): 超过7天TPS为0
    - 低利用率: 30天CPU峰值<30%
    - 计费优化: 按量付费超过 30 天

    Args:
        region_id: 区域 ID
        days: 检测周期（默认 30 天）
        **kwargs: 框架注入的参数

    Returns:
        MSE 成本优化报告 (Markdown)
    """
    credential = kwargs.get("credential") or get_credential()
    cms_client = _build_client(credential, "cms", region_id)
    
    try:
        # 动态导入 MSE SDK
        try:
            from alibabacloud_mse20190531.client import Client as MseClient
            from alibabacloud_mse20190531 import models as mse_models
        except ImportError:
            return json.dumps({
                "success": False,
                "error": "alibabacloud_mse20190531 SDK 未安装，请执行: pip install alibabacloud_mse20190531",
            }, ensure_ascii=False)
        
        # 构建 MSE Client
        ak, sk = _get_ak_sk(credential)
        mse_config = Config(
            access_key_id=ak,
            access_key_secret=sk,
            endpoint=f"mse.{region_id}.aliyuncs.com",
            region_id=region_id,
        )
        mse_client = MseClient(mse_config)
        
        # 1. 获取所有注册中心实例
        all_instances = []
        page = 1
        while True:
            req = mse_models.ListClustersRequest(
                region_id=region_id,
                page_num=page,
                page_size=20,
            )
            resp = await asyncio.to_thread(mse_client.list_clusters, req)
            if resp.body.data:
                all_instances.extend(resp.body.data)
            total = resp.body.total_count or 0
            if len(all_instances) >= total:
                break
            page += 1
        
        # 2. 分析每个实例
        analyzed_instances = []
        
        from products import mse as mse_config
        
        for inst in all_instances:
            inst_id = inst.instance_id or ""
            inst_name = inst.cluster_name or ""
            cluster_type = inst.cluster_type or ""
            
            # 查询 CPU 监控数据
            cpu_data = await _get_cms_metric_datapoints(
                cms_client, "acs_mse", "cpu_user",
                [{"instanceId": inst_id}], days=days,
            )
            
            def calc_stats(data):
                if not data:
                    return 0.0, 0.0
                values = [_safe_float(p.get("Average", p.get("average", 0))) for p in data]
                return max(values) if values else 0.0, sum(values) / len(values) if values else 0.0
            
            cpu_max, cpu_avg = calc_stats(cpu_data)
            
            metrics = mse_config.MseMetrics(
                cpu_max=cpu_max,
                cpu_avg=cpu_avg,
            )
            
            inst_info = mse_config.MseInstanceInfo(
                instance_id=inst_id,
                instance_name=inst_name,
                cluster_type=cluster_type,
                mse_version=inst.mse_version or "",
                spec_type=inst.version_code or "",  # 使用 version_code 代替不存在的 instance_models
                charge_type=inst.charge_type or "",
                create_time=inst.create_time or "",
                status=inst.init_status or "",
                region_id=region_id,
                metrics=metrics,
            )
            
            # 检测闲置
            is_idle, idle_reason = mse_config.check_idle(inst_info)
            if is_idle:
                inst_info.is_idle = True
                inst_info.idle_reason = idle_reason
                inst_info.issues.append({
                    "rule": "IdleResource",
                    "severity": "high",
                })
            # 检测低利用率
            elif mse_config.check_low_utilization(metrics):
                inst_info.is_low_util = True
                inst_info.issues.append({
                    "rule": "LowUtilization",
                    "severity": "medium",
                })
            
            # 检测计费优化
            needs_billing, hold_days = mse_config.check_billing_optimization(
                inst_info.charge_type, inst_info.create_time
            )
            if needs_billing:
                inst_info.billing_issue = True
                inst_info.issues.append({
                    "rule": "BillingOptimization",
                    "severity": "medium",
                    "hold_days": hold_days,
                })
            
            analyzed_instances.append(inst_info)
        
        # 3. 生成报告
        lines = mse_config.generate_report_lines(analyzed_instances, region_id, days)
        return "\n".join(lines)
    
    except Exception as e:
        logger.error("MSE 成本优化分析失败: %s", e)
        return json.dumps({
            "success": False, "error": str(e),
        }, ensure_ascii=False)


# =============================================================================
# Elasticsearch 检索分析成本优化
# =============================================================================


async def opt_elasticsearch_cost_optimization(
    region_id: str = "cn-hangzhou",
    days: int = 30,
    **kwargs,
) -> str:
    """Elasticsearch 成本优化分析。

    检测规则：
    - 低利用率: 30天 CPU峰值<30% 且 HeapMemory使用率峰值<30%
    - 计费优化: 按量付费超过 30 天

    Args:
        region_id: 区域 ID
        days: 检测周期（默认 30 天）
        **kwargs: 框架注入的参数

    Returns:
        Elasticsearch 成本优化报告 (Markdown)
    """
    credential = kwargs.get("credential") or get_credential()
    cms_client = _build_client(credential, "cms", region_id)
    
    try:
        # 动态导入 Elasticsearch SDK
        try:
            from alibabacloud_elasticsearch20170613.client import Client as EsClient
            from alibabacloud_elasticsearch20170613 import models as es_models
        except ImportError:
            return json.dumps({
                "success": False,
                "error": "alibabacloud_elasticsearch20170613 SDK 未安装，请执行: pip install alibabacloud_elasticsearch20170613",
            }, ensure_ascii=False)
        
        # 构建 Elasticsearch Client
        ak, sk = _get_ak_sk(credential)
        es_config = Config(
            access_key_id=ak,
            access_key_secret=sk,
            endpoint=f"elasticsearch.{region_id}.aliyuncs.com",
            region_id=region_id,
        )
        es_client = EsClient(es_config)
        
        # 1. 获取所有实例
        all_instances = []
        page = 1
        while True:
            req = es_models.ListInstanceRequest(
                page=page,
                size=50,
            )
            resp = await asyncio.to_thread(es_client.list_instance, req)
            if resp.body.result:
                all_instances.extend(resp.body.result)
            total = resp.body.headers.x_total_count if resp.body.headers else 0
            if len(all_instances) >= total:
                break
            page += 1
        
        # 2. 分析每个实例
        analyzed_instances = []
        
        from products import elasticsearch as es_config_module
        
        for inst in all_instances:
            inst_id = inst.instance_id or ""
            inst_name = inst.description or ""
            status = inst.status or ""
            
            if status not in ("active", "ACTIVE"):
                continue
            
            # 查询 CPU 和 HeapMemory 监控数据
            cpu_data = await _get_cms_metric_datapoints(
                cms_client, "acs_elasticsearch", "CpuPercent",
                [{"instanceId": inst_id}], days=days,
            )
            heap_data = await _get_cms_metric_datapoints(
                cms_client, "acs_elasticsearch", "HeapMemoryUsage",
                [{"instanceId": inst_id}], days=days,
            )
            
            def calc_stats(data):
                if not data:
                    return 0.0, 0.0
                values = [_safe_float(p.get("Average", p.get("average", 0))) for p in data]
                return max(values) if values else 0.0, sum(values) / len(values) if values else 0.0
            
            cpu_max, cpu_avg = calc_stats(cpu_data)
            heap_max, heap_avg = calc_stats(heap_data)
            
            metrics = es_config_module.EsMetrics(
                cpu_max=cpu_max,
                cpu_avg=cpu_avg,
                heap_memory_max=heap_max,
                heap_memory_avg=heap_avg,
            )
            
            # 获取节点数
            node_amount = 0
            if hasattr(inst, 'node_amount'):
                node_amount = inst.node_amount or 0
            elif hasattr(inst, 'node_spec') and inst.node_spec:
                node_amount = inst.node_spec.spec_info.amount if hasattr(inst.node_spec, 'spec_info') else 0
            
            inst_info = es_config_module.EsInstanceInfo(
                instance_id=inst_id,
                instance_name=inst_name,
                instance_type=inst.instance_type or "elasticsearch",
                version=inst.es_version or "",
                spec=inst.node_spec.spec if hasattr(inst, 'node_spec') and inst.node_spec else "",
                node_amount=node_amount,
                charge_type=inst.payment_type or "",
                create_time=inst.created_at or "",
                status=status,
                region_id=region_id,
                metrics=metrics,
            )
            
            # 检测低利用率
            if es_config_module.check_low_utilization(metrics):
                inst_info.is_low_util = True
                inst_info.issues.append({
                    "rule": "LowUtilization",
                    "severity": "medium",
                })
            
            # 检测计费优化
            needs_billing, hold_days = es_config_module.check_billing_optimization(
                inst_info.charge_type, inst_info.create_time
            )
            if needs_billing:
                inst_info.billing_issue = True
                inst_info.issues.append({
                    "rule": "BillingOptimization",
                    "severity": "medium",
                    "hold_days": hold_days,
                })
            
            analyzed_instances.append(inst_info)
        
        # 3. 生成报告
        lines = es_config_module.generate_report_lines(analyzed_instances, region_id, days)
        return "\n".join(lines)
    
    except Exception as e:
        logger.error("Elasticsearch 成本优化分析失败: %s", e)
        return json.dumps({
            "success": False, "error": str(e),
        }, ensure_ascii=False)


# =============================================================================
# RocketMQ 云消息队列成本优化
# =============================================================================


async def opt_rocketmq_cost_optimization(
    region_id: str = "cn-hangzhou",
    days: int = 7,
    **kwargs,
) -> str:
    """RocketMQ 成本优化分析。

    检测规则：
    - Serverless 实例中，过去 7 天无监控数据的 Topic，建议删除

    Args:
        region_id: 区域 ID
        days: 检测周期（默认 7 天）
        **kwargs: 框架注入的参数

    Returns:
        RocketMQ 成本优化报告 (Markdown)
    """
    credential = kwargs.get("credential") or get_credential()
    cms_client = _build_client(credential, "cms", region_id)
    
    try:
        # 动态导入 RocketMQ SDK
        try:
            from alibabacloud_rocketmq20220801.client import Client as RocketMQClient
            from alibabacloud_rocketmq20220801 import models as rocketmq_models
        except ImportError:
            return json.dumps({
                "success": False,
                "error": "alibabacloud_rocketmq20220801 SDK 未安装，请执行: pip install alibabacloud_rocketmq20220801",
            }, ensure_ascii=False)
        
        # 构建 RocketMQ Client
        ak, sk = _get_ak_sk(credential)
        rocketmq_config = Config(
            access_key_id=ak,
            access_key_secret=sk,
            endpoint=f"rocketmq.{region_id}.aliyuncs.com",
            region_id=region_id,
        )
        rocketmq_client = RocketMQClient(rocketmq_config)
        
        # 1. 获取所有实例
        all_instances = []
        page_token = None
        while True:
            req = rocketmq_models.ListInstancesRequest(
                page_size=50,
                page_number=1,
            )
            resp = await asyncio.to_thread(rocketmq_client.list_instances, req)
            if resp.body.data and resp.body.data.list:
                all_instances.extend(resp.body.data.list)
            # RocketMQ 5.x API 不一定支持分页，一次获取全部
            break
        
        # 2. 分析每个实例
        analyzed_instances = []
        
        from products import rocketmq as rocketmq_config_module
        
        for inst in all_instances:
            inst_id = inst.instance_id or ""
            inst_name = inst.instance_name or ""
            status = inst.status or ""
            
            # 只检测 Serverless 实例
            product_info = inst.product_info
            is_serverless = False
            if product_info and hasattr(product_info, 'support_auto_scaling'):
                is_serverless = product_info.support_auto_scaling
            
            if not is_serverless:
                continue
            
            if status not in ("RUNNING", "Running"):
                continue
            
            inst_info = rocketmq_config_module.RocketMQInstanceInfo(
                instance_id=inst_id,
                instance_name=inst_name,
                instance_type="serverless" if is_serverless else "standard",
                series_code=inst.series_code or "",
                status=status,
                region_id=region_id,
                create_time=inst.create_time or "",
            )
            
            # 获取该实例的所有 Topic
            try:
                topics_req = rocketmq_models.ListTopicsRequest(
                    instance_id=inst_id,
                )
                topics_resp = await asyncio.to_thread(rocketmq_client.list_topics, inst_id, topics_req)
                
                if topics_resp.body.data and topics_resp.body.data.list:
                    inst_info.total_topics = len(topics_resp.body.data.list)
                    
                    for topic in topics_resp.body.data.list:
                        topic_name = topic.topic_name or ""
                        
                        # 查询 Topic 流量监控
                        traffic_data = await _get_cms_metric_datapoints(
                            cms_client, "acs_ons", "TopicMessageNum",
                            [{"instanceId": inst_id, "topic": topic_name}], days=days,
                        )
                        
                        has_traffic = len(traffic_data) > 0 and any(
                            _safe_float(p.get("Average", p.get("average", 0))) > 0
                            for p in traffic_data
                        )
                        
                        if not has_traffic:
                            idle_topic = rocketmq_config_module.TopicInfo(
                                topic_name=topic_name,
                                instance_id=inst_id,
                                message_type=topic.message_type or "",
                                status=topic.status or "",
                                create_time=topic.create_time or "",
                                has_traffic=False,
                            )
                            inst_info.idle_topics.append(idle_topic)
            
            except Exception as topic_err:
                logger.warning("获取 RocketMQ Topic 失败 %s: %s", inst_id, topic_err)
            
            analyzed_instances.append(inst_info)
        
        # 3. 生成报告
        lines = rocketmq_config_module.generate_report_lines(analyzed_instances, region_id, days)
        return "\n".join(lines)
    
    except Exception as e:
        logger.error("RocketMQ 成本优化分析失败: %s", e)
        return json.dumps({
            "success": False, "error": str(e),
        }, ensure_ascii=False)


# =============================================================================
# P2: ARMS 应用实时监控资源包推荐
# =============================================================================


async def opt_arms_cost_optimization(
    region_id: str = "cn-hangzhou",
    days: int = 30,
    **kwargs,
) -> str:
    """ARMS 成本优化分析。

    通过账单查询 ARMS 的按量消费，分析调用量和 Span 存储的用量，
    推荐合适的资源包规格。

    Args:
        region_id: 区域 ID
        days: 查询天数（默认 30 天）
        **kwargs: 框架注入的参数

    Returns:
        ARMS 资源包推荐报告 (Markdown)
    """
    credential = kwargs.get("credential") or get_credential()
    
    try:
        from products import arms as arms_module
        
        # 使用 BSS 账单查询 ARMS 消费
        bss_client = _build_client(credential, "bss", region_id)
        
        now = datetime.now(timezone.utc)
        start_date = (now - timedelta(days=days)).strftime("%Y-%m")
        end_date = now.strftime("%Y-%m")
        
        # 查询 ARMS 账单
        total_amount = 0.0
        request_amount = 0.0
        span_amount = 0.0
        
        try:
            req = bss_models.QueryInstanceBillRequest(
                billing_cycle=start_date,
                product_code="arms",
            )
            resp = await asyncio.to_thread(bss_client.query_instance_bill, req)
            if resp.body.data and resp.body.data.items:
                for item in resp.body.data.items.item:
                    amount = _safe_float(item.pretax_amount)
                    total_amount += amount
                    
                    # 根据计费项分类
                    billing_item = (item.billing_item or "").lower()
                    if "request" in billing_item or "调用" in billing_item:
                        request_amount += amount
                    elif "span" in billing_item or "storage" in billing_item or "存储" in billing_item:
                        span_amount += amount
        except Exception as bill_err:
            logger.warning("查询 ARMS 账单失败: %s", bill_err)
        
        # 构建用量指标
        metrics = arms_module.ArmsUsageMetrics(
            request_count=int(request_amount / 0.015 * 10000) if request_amount > 0 else 0,  # 估算调用次数
            request_amount=request_amount,
            span_storage_gb=span_amount / 0.8 if span_amount > 0 else 0,  # 估算存储量
            span_storage_amount=span_amount,
            total_amount=total_amount,
            start_date=start_date,
            end_date=end_date,
        )
        
        # 分析并生成推荐
        result = arms_module.analyze_arms_usage(metrics)
        result.region_id = region_id
        
        # 生成报告
        lines = []
        lines.append("# ARMS 资源包推荐报告")
        lines.append("")
        lines.append(f"> 生成时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
        lines.append(f"> 分析区域: {region_id}")
        lines.append("")
        lines.extend(arms_module.generate_report_lines(result))
        
        return "\n".join(lines)
    
    except Exception as e:
        logger.error("ARMS 成本优化分析失败: %s", e)
        return json.dumps({
            "success": False, "error": str(e),
        }, ensure_ascii=False)


# =============================================================================
# P2: MaxCompute CU资源包推荐
# =============================================================================


async def opt_maxcompute_cost_optimization(
    region_id: str = "cn-hangzhou",
    days: int = 30,
    **kwargs,
) -> str:
    """MaxCompute 成本优化分析。

    通过账单查询 MaxCompute 的按量消费，分析 CU 和存储的用量，
    推荐合适的资源包规格。

    Args:
        region_id: 区域 ID
        days: 查询天数（默认 30 天）
        **kwargs: 框架注入的参数

    Returns:
        MaxCompute CU资源包推荐报告 (Markdown)
    """
    credential = kwargs.get("credential") or get_credential()
    
    try:
        from products import maxcompute as mc_module
        
        bss_client = _build_client(credential, "bss", region_id)
        
        now = datetime.now(timezone.utc)
        start_date = (now - timedelta(days=days)).strftime("%Y-%m")
        end_date = now.strftime("%Y-%m")
        
        # 查询 MaxCompute 账单
        total_amount = 0.0
        cu_amount = 0.0
        storage_amount = 0.0
        download_amount = 0.0
        
        try:
            req = bss_models.QueryInstanceBillRequest(
                billing_cycle=start_date,
                product_code="odps",  # MaxCompute 产品代码
            )
            resp = await asyncio.to_thread(bss_client.query_instance_bill, req)
            if resp.body.data and resp.body.data.items:
                for item in resp.body.data.items.item:
                    amount = _safe_float(item.pretax_amount)
                    total_amount += amount
                    
                    billing_item = (item.billing_item or "").lower()
                    if "cu" in billing_item or "计算" in billing_item:
                        cu_amount += amount
                    elif "storage" in billing_item or "存储" in billing_item:
                        storage_amount += amount
                    elif "download" in billing_item or "下载" in billing_item:
                        download_amount += amount
        except Exception as bill_err:
            logger.warning("查询 MaxCompute 账单失败: %s", bill_err)
        
        # 构建用量指标
        metrics = mc_module.MaxComputeUsageMetrics(
            cu_hours=cu_amount / 0.35 if cu_amount > 0 else 0,  # 估算 CU*小时
            cu_amount=cu_amount,
            storage_gb=storage_amount / (0.0192 * 30) if storage_amount > 0 else 0,  # 估算存储量
            storage_amount=storage_amount,
            download_gb=download_amount / 0.8 if download_amount > 0 else 0,
            download_amount=download_amount,
            total_amount=total_amount,
            start_date=start_date,
            end_date=end_date,
        )
        
        result = mc_module.analyze_maxcompute_usage(metrics)
        result.region_id = region_id
        
        lines = []
        lines.append("# MaxCompute CU资源包推荐报告")
        lines.append("")
        lines.append(f"> 生成时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
        lines.append(f"> 分析区域: {region_id}")
        lines.append("")
        lines.extend(mc_module.generate_report_lines(result))
        
        return "\n".join(lines)
    
    except Exception as e:
        logger.error("MaxCompute 成本优化分析失败: %s", e)
        return json.dumps({
            "success": False, "error": str(e),
        }, ensure_ascii=False)


# =============================================================================
# P2: WAF SeCU资源包推荐
# =============================================================================


async def opt_waf_cost_optimization(
    region_id: str = "cn-hangzhou",
    days: int = 30,
    **kwargs,
) -> str:
    """WAF 成本优化分析。

    通过账单查询 WAF 的按量消费，分析 SeCU 用量，
    推荐合适的 SeCU 资源包规格。

    Args:
        region_id: 区域 ID
        days: 查询天数（默认 30 天）
        **kwargs: 框架注入的参数

    Returns:
        WAF SeCU资源包推荐报告 (Markdown)
    """
    credential = kwargs.get("credential") or get_credential()
    
    try:
        from products import waf as waf_module
        
        bss_client = _build_client(credential, "bss", region_id)
        
        now = datetime.now(timezone.utc)
        start_date = (now - timedelta(days=days)).strftime("%Y-%m")
        end_date = now.strftime("%Y-%m")
        
        # 查询 WAF 账单
        total_amount = 0.0
        secu_amount = 0.0
        
        try:
            req = bss_models.QueryInstanceBillRequest(
                billing_cycle=start_date,
                product_code="waf",
            )
            resp = await asyncio.to_thread(bss_client.query_instance_bill, req)
            if resp.body.data and resp.body.data.items:
                for item in resp.body.data.items.item:
                    amount = _safe_float(item.pretax_amount)
                    total_amount += amount
                    
                    billing_item = (item.billing_item or "").lower()
                    if "secu" in billing_item or "安全计算" in billing_item:
                        secu_amount += amount
                    else:
                        # WAF 主要消费都是 SeCU
                        secu_amount += amount
        except Exception as bill_err:
            logger.warning("查询 WAF 账单失败: %s", bill_err)
        
        # 构建用量指标
        metrics = waf_module.WafUsageMetrics(
            secu_count=secu_amount / 0.6 if secu_amount > 0 else 0,  # 估算 SeCU 数量
            secu_amount=secu_amount,
            total_amount=total_amount,
            start_date=start_date,
            end_date=end_date,
        )
        
        result = waf_module.analyze_waf_usage(metrics)
        result.region_id = region_id
        
        lines = []
        lines.append("# WAF SeCU资源包推荐报告")
        lines.append("")
        lines.append(f"> 生成时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
        lines.append(f"> 分析区域: {region_id}")
        lines.append("")
        lines.extend(waf_module.generate_report_lines(result))
        
        return "\n".join(lines)
    
    except Exception as e:
        logger.error("WAF 成本优化分析失败: %s", e)
        return json.dumps({
            "success": False, "error": str(e),
        }, ensure_ascii=False)


# =============================================================================
# P2: Redis 存储资源包推荐
# =============================================================================


async def opt_redis_package_recommendation(
    region_id: str = "cn-hangzhou",
    days: int = 30,
    **kwargs,
) -> str:
    """Redis 资源包推荐分析。

    通过账单查询 Redis 的按量消费，分析存储用量，
    推荐合适的存储资源包规格。

    Args:
        region_id: 区域 ID
        days: 查询天数（默认 30 天）
        **kwargs: 框架注入的参数

    Returns:
        Redis 资源包推荐报告 (Markdown)
    """
    credential = kwargs.get("credential") or get_credential()
    
    try:
        from products import redis as redis_module
        
        bss_client = _build_client(credential, "bss", region_id)
        
        now = datetime.now(timezone.utc)
        start_date = (now - timedelta(days=days)).strftime("%Y-%m")
        end_date = now.strftime("%Y-%m")
        
        # 查询 Redis 账单
        total_amount = 0.0
        storage_amount = 0.0
        
        try:
            req = bss_models.QueryInstanceBillRequest(
                billing_cycle=start_date,
                product_code="redisa",  # Redis 产品代码
            )
            resp = await asyncio.to_thread(bss_client.query_instance_bill, req)
            if resp.body.data and resp.body.data.items:
                for item in resp.body.data.items.item:
                    amount = _safe_float(item.pretax_amount)
                    total_amount += amount
                    
                    billing_item = (item.billing_item or "").lower()
                    if "storage" in billing_item or "存储" in billing_item:
                        storage_amount += amount
                    else:
                        # 其他消费也计入存储
                        storage_amount += amount
        except Exception as bill_err:
            logger.warning("查询 Redis 账单失败: %s", bill_err)
        
        # 构建用量指标
        metrics = redis_module.RedisUsageMetrics(
            storage_gb_hours=storage_amount / 0.008 if storage_amount > 0 else 0,  # 估算 GB*小时
            storage_amount=storage_amount,
            total_amount=total_amount,
            start_date=start_date,
            end_date=end_date,
        )
        
        result = redis_module.analyze_redis_package_usage(metrics)
        result.region_id = region_id
        
        lines = []
        lines.append("# Redis 资源包推荐报告")
        lines.append("")
        lines.append(f"> 生成时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
        lines.append(f"> 分析区域: {region_id}")
        lines.append("")
        lines.extend(redis_module.generate_package_report_lines(result))
        
        return "\n".join(lines)
    
    except Exception as e:
        logger.error("Redis 资源包推荐分析失败: %s", e)
        return json.dumps({
            "success": False, "error": str(e),
        }, ensure_ascii=False)

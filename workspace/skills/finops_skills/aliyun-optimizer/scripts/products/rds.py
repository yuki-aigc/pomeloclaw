# -*- coding: utf-8 -*-
"""RDS 云数据库产品配置。

配置项：
- ProductCode: rds
- 规则链: IdleResourceCheck → LowUtilizationCheck → PostPaidLongTermCheck
- 闲置判定方式: 方式 A（基于监控）
- 监控指标: CpuUsage, MemoryUsage
- 询价 ModuleCode: DBInstanceClass

降配推荐逻辑：
- 自查可用规格列表排序选择（DescribeAvailableClasses + ListClasses）
- 按 CPU 升序、内存升序排列，取当前规格前一位作为降配目标
"""

from __future__ import annotations

import asyncio
import logging
import re
from typing import Optional

from alibabacloud_tea_openapi.models import Config
from alibabacloud_rds20140815.client import Client as RdsClient
from alibabacloud_rds20140815 import models as rds_models

from core.base import (
    ProductConfig,
    RuleConfig,
    MetricConfig,
    IdleCheckMethod,
    OptimizeStrategy,
    ResourceInstance,
    ChargeType,
)
from products import register_product

logger = logging.getLogger(__name__)


# ========== RDS 商品码映射 ==========
# 根据付费类型 + 实例角色确定商品码
_COMMODITY_CODE_MAP = {
    ("Prepaid", "Primary"): "rds",
    ("Postpaid", "Primary"): "bards",
    ("Postpaid", "Readonly"): "rords",
    ("Prepaid", "Readonly"): "rds_rordspre_public_cn",
}


async def list_rds_instances(
    ak: str,
    sk: str,
    region_id: str,
    status: str = "Running",
) -> list[ResourceInstance]:
    """列举 RDS 实例。
    
    获取实例列表及扩展属性，用于后续的降配推荐和询价。
    
    Args:
        ak: AccessKey ID
        sk: AccessKey Secret
        region_id: 地域 ID
        status: 实例状态筛选
    
    Returns:
        标准化的资源实例列表
    """
    config = Config(
        access_key_id=ak,
        access_key_secret=sk,
        endpoint=f"rds.{region_id}.aliyuncs.com",
        region_id=region_id,
    )
    client = RdsClient(config)
    
    instances: list[ResourceInstance] = []
    page = 1
    
    while True:
        req = rds_models.DescribeDBInstancesRequest(
            region_id=region_id,
            page_number=page,
            page_size=100,
        )
        resp = await asyncio.to_thread(client.describe_dbinstances, req)
        body = resp.body
        
        items = body.items
        db_instances = items.dbinstance if items and hasattr(items, "dbinstance") and items.dbinstance else []
        
        for inst in db_instances:
            inst_status = inst.dbinstance_status if hasattr(inst, "dbinstance_status") else ""
            
            # 状态筛选
            if status and inst_status != status:
                continue
            
            # 解析付费类型（RDS 用 Prepaid/Postpaid，首字母大写其余小写）
            pay_type = inst.pay_type if hasattr(inst, "pay_type") else "Postpaid"
            charge_type = ChargeType.from_str(pay_type)
            
            # 获取扩展属性
            engine = inst.engine if hasattr(inst, "engine") else ""
            engine_version = inst.engine_version if hasattr(inst, "engine_version") else ""
            db_instance_type = inst.dbinstance_type if hasattr(inst, "dbinstance_type") else "Primary"
            category = inst.category if hasattr(inst, "category") else ""
            storage_type = inst.dbinstance_storage_type if hasattr(inst, "dbinstance_storage_type") else "local_ssd"
            
            instances.append(ResourceInstance(
                resource_id=inst.dbinstance_id if hasattr(inst, "dbinstance_id") else "",
                resource_name=inst.dbinstance_description if hasattr(inst, "dbinstance_description") else "",
                region_id=region_id,
                zone_id=inst.zone_id if hasattr(inst, "zone_id") else "",
                instance_type=inst.dbinstance_class if hasattr(inst, "dbinstance_class") else "",
                charge_type=charge_type,
                creation_time=inst.create_time if hasattr(inst, "create_time") else "",
                status=inst_status,
                raw={
                    # 基础属性
                    "engine": engine,
                    "engine_version": engine_version,
                    "storage": inst.dbinstance_storage if hasattr(inst, "dbinstance_storage") else 0,
                    "connection_string": inst.connection_string if hasattr(inst, "connection_string") else "",
                    # 降配推荐所需的扩展属性
                    "db_instance_type": db_instance_type,  # Primary/Readonly/Guard/Temp
                    "category": category,  # Basic/HighAvailability/Finance
                    "db_instance_storage_type": storage_type,  # local_ssd/cloud_ssd/cloud_essd
                    "pay_type": pay_type,  # 保留原始付费类型标识
                },
            ))
        
        total = body.total_record_count or 0
        if len(instances) >= total:
            break
        page += 1
    
    return instances


def _get_commodity_code(pay_type: str, db_instance_type: str) -> str:
    """根据付费类型和实例角色确定商品码。
    
    | 付费类型 | 实例角色 | 商品码 |
    |---------|---------|--------|
    | Prepaid | Primary | rds |
    | Postpaid | Primary | bards |
    | Postpaid | Readonly | rords |
    | Prepaid | Readonly | rds_rordspre_public_cn |
    """
    key = (pay_type, db_instance_type)
    return _COMMODITY_CODE_MAP.get(key, "bards")  # 默认按量主实例


def _parse_memory_value(memory_str: str) -> float:
    """解析内存字段，去除单位后缀。
    
    示例："4GB（共享规格）" -> 4.0
    """
    if not memory_str:
        return 0.0
    # 提取数字部分
    match = re.search(r"([\d.]+)", str(memory_str))
    if match:
        return float(match.group(1))
    return 0.0


async def get_rds_recommend_spec(
    instance_id: str,
    current_type: str,
    region_id: str,
    **kwargs,
) -> str:
    """获取 RDS 降配推荐规格。
    
    RDS 降配推荐逻辑：
    1. 确定商品码（根据付费类型 + 实例角色）
    2. 调用 DescribeAvailableClasses 获取可变更规格列表
    3. 调用 ListClasses 获取全部规格详情（CPU/内存/IOPS/连接数）
    4. 取交集、排序、推荐前一位规格
    
    Args:
        instance_id: 实例 ID
        current_type: 当前规格
        region_id: 地域 ID
        **kwargs: 额外参数，包含 ak, sk 和实例扩展属性
    
    Returns:
        推荐规格，无推荐返回空字符串
    """
    ak = kwargs.get("ak", "")
    sk = kwargs.get("sk", "")
    
    if not ak or not sk:
        logger.warning("RDS 降配推荐缺少 AK/SK")
        return _fallback_recommend(current_type)
    
    # 从 kwargs 获取实例扩展属性（由框架传入）
    raw = kwargs.get("raw", {})
    zone_id = kwargs.get("zone_id", "")
    pay_type = raw.get("pay_type", "Postpaid")
    engine = raw.get("engine", "MySQL")
    engine_version = raw.get("engine_version", "8.0")
    db_instance_type = raw.get("db_instance_type", "Primary")
    category = raw.get("category", "HighAvailability")
    storage_type = raw.get("db_instance_storage_type", "local_ssd")
    
    # 构建 RDS 客户端
    config = Config(
        access_key_id=ak,
        access_key_secret=sk,
        endpoint=f"rds.{region_id}.aliyuncs.com",
        region_id=region_id,
    )
    client = RdsClient(config)
    
    try:
        # 步骤 1：确定商品码
        commodity_code = _get_commodity_code(pay_type, db_instance_type)
        
        # 步骤 2：查询可变更规格
        available_classes = await _query_available_classes(
            client, region_id, zone_id, pay_type, engine, engine_version,
            instance_id, storage_type, category
        )
        
        # 步骤 3：查询全部规格详情
        order_type = "BUY" if available_classes else "UPGRADE"
        all_classes = await _query_all_classes(
            client, commodity_code, order_type, instance_id, region_id
        )
        
        if not all_classes:
            logger.warning("RDS ListClasses 返回空，回退到简单推荐")
            return _fallback_recommend(current_type)
        
        # 步骤 4：取交集、排序、推荐
        if available_classes:
            # 取交集
            available_set = set(available_classes)
            filtered = [c for c in all_classes if c["class_code"] in available_set]
        else:
            filtered = all_classes
        
        if not filtered:
            logger.warning("RDS 可用规格交集为空")
            return _fallback_recommend(current_type)
        
        # 按 CPU 升序、内存升序排序
        sorted_classes = sorted(filtered, key=lambda x: (x["cpu"], x["memory"]))
        
        # 找到当前规格的位置
        current_idx = -1
        for i, c in enumerate(sorted_classes):
            if c["class_code"] == current_type:
                current_idx = i
                break
        
        # 推荐前一位规格
        if current_idx > 0:
            recommended = sorted_classes[current_idx - 1]["class_code"]
            logger.info("RDS 降配推荐: %s -> %s", current_type, recommended)
            return recommended
        elif current_idx == 0:
            logger.info("RDS %s 已是最低规格，无法降配", current_type)
            return ""
        else:
            # 当前规格不在列表中，回退到简单推荐
            logger.warning("RDS 当前规格 %s 不在可用列表中", current_type)
            return _fallback_recommend(current_type)
    
    except Exception as e:
        logger.warning("RDS 降配推荐失败: %s", e)
        return _fallback_recommend(current_type)


async def _query_available_classes(
    client: RdsClient,
    region_id: str,
    zone_id: str,
    pay_type: str,
    engine: str,
    engine_version: str,
    instance_id: str,
    storage_type: str,
    category: str,
) -> list[str]:
    """查询实例可变更的目标规格列表。
    
    调用 DescribeAvailableClasses API。
    """
    try:
        # 转换付费类型格式
        charge_type = "Prepaid" if pay_type == "Prepaid" else "Postpaid"
        
        req = rds_models.DescribeAvailableClassesRequest(
            region_id=region_id,
            zone_id=zone_id,
            instance_charge_type=charge_type,
            engine=engine,
            engine_version=engine_version,
            dbinstance_id=instance_id,
            dbinstance_storage_type=storage_type,
            category=category,
        )
        resp = await asyncio.to_thread(client.describe_available_classes, req)
        body = resp.body
        
        if not body.dbinstance_classes:
            return []
        
        # 提取所有可用的 DBInstanceClass
        classes = []
        for item in body.dbinstance_classes:
            if hasattr(item, "dbinstance_class") and item.dbinstance_class:
                classes.append(item.dbinstance_class)
        
        return classes
    
    except Exception as e:
        logger.warning("DescribeAvailableClasses 失败: %s", e)
        return []


async def _query_all_classes(
    client: RdsClient,
    commodity_code: str,
    order_type: str,
    instance_id: str,
    region_id: str,
) -> list[dict]:
    """查询全部规格详情。
    
    调用 ListClasses API，返回 CPU/内存/IOPS/连接数等信息。
    自动过滤停售规格。
    """
    try:
        req = rds_models.ListClassesRequest(
            commodity_code=commodity_code,
            order_type=order_type,
            dbinstance_id=instance_id,
            region_id=region_id,
        )
        resp = await asyncio.to_thread(client.list_classes, req)
        body = resp.body
        
        if not body.items:
            return []
        
        result = []
        for item in body.items:
            # 过滤停售规格
            class_code = item.class_code if hasattr(item, "class_code") else ""
            if "停售" in class_code:
                continue
            
            cpu = item.cpu if hasattr(item, "cpu") else "0"
            memory = item.memory_class if hasattr(item, "memory_class") else "0"
            
            result.append({
                "class_code": class_code,
                "cpu": int(cpu) if cpu else 0,
                "memory": _parse_memory_value(memory),
                "max_connections": item.max_connections if hasattr(item, "max_connections") else 0,
                "max_iops": item.max_iops if hasattr(item, "max_iops") else 0,
            })
        
        return result
    
    except Exception as e:
        logger.warning("ListClasses 失败: %s", e)
        return []


def _fallback_recommend(current_type: str) -> str:
    """回退的简单降配推荐逻辑。
    
    当 API 查询失败时，使用规格名称规则推荐。
    RDS 规格命名示例：mysql.n2.medium.1 → mysql.n2.small.1
    """
    parts = current_type.split(".")
    if len(parts) < 3:
        return ""
    
    size_map = {
        "2xlarge": "xlarge",
        "xlarge": "large",
        "large": "medium",
        "medium": "small",
    }
    
    for i, part in enumerate(parts):
        part_lower = part.lower()
        for size, lower_size in size_map.items():
            if size in part_lower:
                parts[i] = part_lower.replace(size, lower_size)
                return ".".join(parts)
    
    return ""


# ========== 产品配置 ==========

RDS_CONFIG = ProductConfig(
    product_code="rds",
    product_name="云数据库 RDS",
    rule_chain=[
        RuleConfig(
            rule_id="IdleResourceCheck",
            enabled=True,
            strategy=OptimizeStrategy.RELEASE,
        ),
        RuleConfig(
            rule_id="LowUtilizationCheck",
            enabled=True,
            strategy=OptimizeStrategy.DOWN_SCALING,
            params={
                # RDS 低利用率检测：最大值在 1%~5% 之间
                "threshold": 5.0,  # 上限
                "lower_threshold": 1.0,  # 下限（与闲置检测互斥）
            },
        ),
        RuleConfig(
            rule_id="PostPaidLongTermCheck",
            enabled=True,
            strategy=OptimizeStrategy.CONVERT_TO_PREPAID,
            params={"hold_days": 30},
        ),
    ],
    idle_check_method=IdleCheckMethod.METRIC,
    idle_metrics=[
        MetricConfig(
            metric_name="CpuUsage",
            namespace="acs_rds_dashboard",
            days=14,
            threshold=1.0,  # CPU 最大值 < 1% 判定为闲置
        ),
        MetricConfig(
            metric_name="MemoryUsage",
            namespace="acs_rds_dashboard",
            days=14,
            threshold=1.0,  # 内存最大值 < 1% 判定为闲置
        ),
    ],
    idle_days=14,
    pricing_module_code="DBInstanceClass",
    pricing_config_template="DBInstanceClass:{spec},Region:{region}",
    list_instances_fn=list_rds_instances,
    get_recommend_spec_fn=get_rds_recommend_spec,
)

# 注册产品配置
register_product(RDS_CONFIG)

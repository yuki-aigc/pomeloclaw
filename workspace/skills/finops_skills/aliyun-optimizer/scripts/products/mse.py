# -*- coding: utf-8 -*-
"""MSE 微服务引擎注册中心产品配置。

配置项：
- ProductCode: mse
- 规则链: 闲置检测 / 低利用率检测 / 计费方式检测
- 数据源: MSE API + 云监控

核心 API：
- ListClusters: 列举注册中心实例
- 云监控指标: cpu_user (CPU利用率)

检测规则：
- 闲置: Eureka/Nacos 健康实例数为0，Zookeeper TPS为0（超过7天）
- 低利用率: 30天 CPU峰值<30%
- 计费优化: 按量付费超过 30 天
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Optional

from alibabacloud_tea_openapi.models import Config
from alibabacloud_mse20190531.client import Client as MseClient
from alibabacloud_mse20190531 import models as mse_models

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


# =============================================================================
# 阈值配置
# =============================================================================

# 低利用率检测阈值
LOW_UTIL_THRESHOLDS = {
    "cpu_max": 30,      # CPU 峰值 < 30%
}

# 闲置检测阈值
IDLE_DURATION_DAYS = 7

# 计费优化阈值
BILLING_HOLD_DAYS = 30


@dataclass
class MseMetrics:
    """MSE 监控指标数据。"""
    cpu_max: float = 0.0
    cpu_avg: float = 0.0
    # Eureka/Nacos 健康实例数
    healthy_instance_count: int = -1  # -1 表示未查询
    # Zookeeper TPS
    tps: float = -1  # -1 表示未查询


@dataclass
class MseInstanceInfo:
    """MSE 注册中心实例信息。"""
    instance_id: str
    instance_name: str
    cluster_type: str  # Eureka / Nacos / ZooKeeper
    mse_version: str
    spec_type: str  # 规格
    charge_type: str  # PREPAY / POSTPAY
    create_time: str
    status: str
    region_id: str
    # 监控数据
    metrics: MseMetrics = field(default_factory=MseMetrics)
    # 检测结果
    is_idle: bool = False
    is_low_util: bool = False
    billing_issue: bool = False
    idle_reason: str = ""
    issues: list[dict] = field(default_factory=list)


def check_idle(instance: MseInstanceInfo) -> tuple[bool, str]:
    """检测是否闲置。
    
    闲置条件（超过7天）：
    - Eureka/Nacos: 健康实例（Provider）数为0
    - Zookeeper: TPS为0
    
    Returns:
        (是否闲置, 闲置原因)
    """
    metrics = instance.metrics
    
    if instance.cluster_type in ("Eureka", "Nacos", "nacos", "eureka"):
        if metrics.healthy_instance_count == 0:
            return True, "健康实例数为0"
    elif instance.cluster_type in ("ZooKeeper", "zookeeper", "Zookeeper"):
        if metrics.tps == 0:
            return True, "TPS为0"
    
    return False, ""


def check_low_utilization(metrics: MseMetrics) -> bool:
    """检测是否低利用率。
    
    低利用率条件：30天 CPU峰值 < 30%
    """
    return metrics.cpu_max < LOW_UTIL_THRESHOLDS["cpu_max"]


def check_billing_optimization(charge_type: str, create_time: str) -> tuple[bool, int]:
    """检测是否需要计费优化。"""
    if charge_type not in ("POSTPAY", "PostPay", "Postpaid"):
        return False, 0
    
    try:
        create_dt = datetime.fromisoformat(create_time.replace("Z", "+00:00"))
        hold_days = (datetime.now(timezone.utc) - create_dt).days
        return hold_days > BILLING_HOLD_DAYS, hold_days
    except Exception:
        return False, 0


def generate_report_lines(
    analyzed_instances: list[MseInstanceInfo],
    region_id: str,
    days: int,
) -> list[str]:
    """生成 Markdown 报告行。"""
    lines = []
    lines.append("# MSE 注册中心成本优化报告")
    lines.append("")
    lines.append(f"> 生成时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    lines.append(f"> 分析区域: {region_id}")
    lines.append(f"> 检测周期: {days} 天")
    lines.append("")
    
    # 统计
    idle_instances = [i for i in analyzed_instances if i.is_idle]
    low_util_instances = [i for i in analyzed_instances if i.is_low_util and not i.is_idle]
    billing_instances = [i for i in analyzed_instances if i.billing_issue]
    
    # 概览
    lines.append("## 概览")
    lines.append("")
    lines.append("| 检测项 | 问题数 | 状态 |")
    lines.append("|--------|-------:|------|")
    lines.append(f"| 实例总数 | {len(analyzed_instances)} | - |")
    lines.append(f"| 闲置资源 | {len(idle_instances)} | {'🔴 需关注' if idle_instances else '✅ 正常'} |")
    lines.append(f"| 低利用率 | {len(low_util_instances)} | {'🟡 可优化' if low_util_instances else '✅ 正常'} |")
    lines.append(f"| 计费优化 | {len(billing_instances)} | {'🟡 可优化' if billing_instances else '✅ 正常'} |")
    lines.append("")
    
    # 优化建议
    has_issues = idle_instances or low_util_instances or billing_instances
    if has_issues:
        lines.append("## 优化建议")
        lines.append("")
        
        if idle_instances:
            lines.append("### 🔴 闲置资源（建议释放）")
            lines.append("")
            lines.append("| 实例 ID | 实例名 | 类型 | 规格 | 闲置原因 |")
            lines.append("|----------|--------|------|------|----------|")
            for inst in idle_instances:
                lines.append(
                    f"| `{inst.instance_id}` | {inst.instance_name[:10] or '-'} | "
                    f"{inst.cluster_type} | {inst.spec_type} | {inst.idle_reason} |"
                )
            lines.append("")
            lines.append("> 操作参考: https://help.aliyun.com/zh/mse/user-guide/manage-an-mse-zookeeper-instance")
            lines.append("")
        
        if low_util_instances:
            lines.append("### 🟡 低利用率（建议降配）")
            lines.append("")
            lines.append("| 实例 ID | 实例名 | 类型 | 规格 | CPU峰值 |")
            lines.append("|----------|--------|------|------|---------|")
            for inst in low_util_instances:
                lines.append(
                    f"| `{inst.instance_id}` | {inst.instance_name[:10] or '-'} | "
                    f"{inst.cluster_type} | {inst.spec_type} | {inst.metrics.cpu_max:.0f}% |"
                )
            lines.append("")
            lines.append("> 操作参考: https://help.aliyun.com/zh/mse/product-overview/change-instance-specifications")
            lines.append("")
        
        if billing_instances:
            lines.append("### 🟡 计费优化（建议转包月）")
            lines.append("")
            lines.append("| 实例 ID | 实例名 | 类型 | 规格 | 持有天数 |")
            lines.append("|----------|--------|------|------|----------|")
            for inst in billing_instances:
                hold_days = next(
                    (i["hold_days"] for i in inst.issues if i.get("rule") == "BillingOptimization"),
                    0
                )
                lines.append(
                    f"| `{inst.instance_id}` | {inst.instance_name[:10] or '-'} | "
                    f"{inst.cluster_type} | {inst.spec_type} | {hold_days} 天 |"
                )
            lines.append("")
            lines.append("> 操作参考: https://help.aliyun.com/zh/mse/product-overview/change-the-billing-method-of-an-mse-instance-from-pay-as-you-go-to-subscription")
            lines.append("")
    else:
        lines.append("## 分析结论")
        lines.append("")
        lines.append("> 所有 MSE 注册中心实例均处于健康状态，无需优化操作。")
        lines.append("")
    
    # 检测规则说明
    lines.append("---")
    lines.append("")
    lines.append("检测规则说明：")
    lines.append("- **闲置(Eureka/Nacos)**: 超过7天健康实例数为0")
    lines.append("- **闲置(Zookeeper)**: 超过7天TPS为0")
    lines.append("- **低利用率**: 30天CPU峰值<30%")
    lines.append("- **计费优化**: 按量付费超过30天")
    
    return lines


# =============================================================================
# 框架集成：列举实例函数
# =============================================================================

async def list_mse_instances(
    ak: str,
    sk: str,
    region_id: str,
) -> list[ResourceInstance]:
    """列举 MSE 注册中心实例。
    
    Args:
        ak: AccessKey ID
        sk: AccessKey Secret
        region_id: 地域 ID
    
    Returns:
        标准化的资源实例列表
    """
    config = Config(
        access_key_id=ak,
        access_key_secret=sk,
        endpoint=f"mse.{region_id}.aliyuncs.com",
        region_id=region_id,
    )
    client = MseClient(config)
    
    instances: list[ResourceInstance] = []
    page = 1
    
    while True:
        req = mse_models.ListClustersRequest(
            region_id=region_id,
            page_num=page,
            page_size=20,
        )
        try:
            resp = await asyncio.to_thread(client.list_clusters, req)
            body = resp.body
            
            if body.data:
                for inst in body.data:
                    # 解析付费类型
                    charge_type_str = inst.charge_type or "POSTPAY"
                    charge_type = ChargeType.PRE_PAID if charge_type_str == "PREPAY" else ChargeType.POST_PAID
                    
                    instances.append(ResourceInstance(
                        resource_id=inst.instance_id or "",
                        resource_name=inst.cluster_name or "",
                        region_id=region_id,
                        zone_id="",
                        instance_type=inst.version_code or "",  # 使用 version_code 代替不存在的 instance_models
                        charge_type=charge_type,
                        creation_time=inst.create_time or "",
                        status=inst.init_status or "",
                        raw={
                            "cluster_type": inst.cluster_type,
                            "mse_version": inst.mse_version,
                        },
                    ))
            
            total = body.total_count or 0
            if len(instances) >= total:
                break
            page += 1
        except Exception as e:
            logger.warning("MSE ListClusters failed: %s", e)
            break
    
    return instances


# =============================================================================
# 产品配置注册
# =============================================================================

MSE_CONFIG = ProductConfig(
    product_code="mse",
    product_name="微服务引擎 MSE",
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
            params={"threshold": 30.0},
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
            metric_name="cpu_user",
            namespace="acs_mse",
            days=14,
            threshold=1.0,
        ),
    ],
    idle_days=14,
    pricing_module_code="mse",
    pricing_config_template="Spec:{spec},Region:{region}",
    list_instances_fn=list_mse_instances,
)

# 注册产品配置
register_product(MSE_CONFIG)

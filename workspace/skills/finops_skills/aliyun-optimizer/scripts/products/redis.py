# -*- coding: utf-8 -*-
"""Redis 云数据库产品配置。

配置项：
- ProductCode: redis (r-kvstore)
- 规则链: 闲置检测 / 低利用率检测 / 计费方式检测
- 数据源: Redis API + 云监控 (acs_kvstore)

核心 API：
- DescribeInstances: 列举 Redis 实例
- 云监控指标: CpuUsage / MemoryUsage / ConnectionUsage / UsedQPS

检测规则：
- 闲置: CPU/内存/连接数 峰值≤10% 且 均值≤5%, QPS 峰值≤50 且 均值≤25
- 低利用率: 所有指标 峰值≤30% 且 均值≤15%
- 计费优化: 按量付费超过 30 天建议转包月
"""

from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from alibabacloud_tea_openapi.models import Config
from alibabacloud_r_kvstore20150101.client import Client as RedisClient
from alibabacloud_r_kvstore20150101 import models as redis_models

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

# 闲置检测阈值
IDLE_THRESHOLDS = {
    "cpu_max": 10,      # CPU 峰值 <= 10%
    "cpu_avg": 5,       # CPU 均值 <= 5%
    "mem_max": 10,      # 内存峰值 <= 10%
    "mem_avg": 5,       # 内存均值 <= 5%
    "conn_max": 10,     # 连接数峰值 <= 10%
    "conn_avg": 5,      # 连接数均值 <= 5%
    "qps_max": 50,      # QPS 峰值 <= 50
    "qps_avg": 25,      # QPS 均值 <= 25
}

# 低利用率检测阈值
LOW_UTIL_THRESHOLDS = {
    "cpu_max": 30,      # CPU 峰值 <= 30%
    "cpu_avg": 15,      # CPU 均值 <= 15%
    "mem_max": 30,      # 内存峰值 <= 30%
    "mem_avg": 15,      # 内存均值 <= 15%
    "conn_max": 30,     # 连接数峰值 <= 30%
    "conn_avg": 15,     # 连接数均值 <= 15%
    "qps_max": 30,      # QPS 百分比峰值 <= 30%
    "qps_avg": 15,      # QPS 百分比均值 <= 15%
}

# 计费优化阈值
BILLING_HOLD_DAYS = 30  # 按量付费超过 30 天建议转包月


# =============================================================================
# 资源包配置（存储型资源包）
# =============================================================================

# Redis 存储资源包规格（GB*小时）
STORAGE_PACKAGES = [
    {"spec": "100GB*小时", "quota": 100, "price_per_month": 30},
    {"spec": "500GB*小时", "quota": 500, "price_per_month": 120},
    {"spec": "1000GB*小时", "quota": 1000, "price_per_month": 200},
    {"spec": "5000GB*小时", "quota": 5000, "price_per_month": 800},
    {"spec": "10000GB*小时", "quota": 10000, "price_per_month": 1400},
]

# 按量单价（参考）
PAY_AS_YOU_GO_PRICES = {
    "storage_per_gb_hour": 0.008,  # 每GB*小时
}


@dataclass
class RedisMetrics:
    """Redis 监控指标数据。"""
    cpu_max: float = 0.0
    cpu_avg: float = 0.0
    mem_max: float = 0.0
    mem_avg: float = 0.0
    conn_max: float = 0.0
    conn_avg: float = 0.0
    qps_max: float = 0.0
    qps_avg: float = 0.0


@dataclass
class RedisInstanceInfo:
    """Redis 实例信息。"""
    instance_id: str
    instance_name: str
    instance_class: str
    engine_version: str
    charge_type: str  # PrePaid / PostPaid
    create_time: str
    network_type: str
    capacity: int  # MB
    region_id: str
    status: str
    # 监控数据
    metrics: RedisMetrics = field(default_factory=RedisMetrics)
    # 检测结果
    is_idle: bool = False
    is_low_util: bool = False
    billing_issue: bool = False
    issues: list[dict] = field(default_factory=list)


def check_idle(metrics: RedisMetrics) -> bool:
    """检测是否闲置。
    
    闲置条件：所有指标同时满足阈值
    - CPU/内存/连接数: 峰值 <= 10% 且 均值 <= 5%
    - QPS: 峰值 <= 50 且 均值 <= 25
    """
    return (
        metrics.cpu_max <= IDLE_THRESHOLDS["cpu_max"] and
        metrics.cpu_avg <= IDLE_THRESHOLDS["cpu_avg"] and
        metrics.mem_max <= IDLE_THRESHOLDS["mem_max"] and
        metrics.mem_avg <= IDLE_THRESHOLDS["mem_avg"] and
        metrics.conn_max <= IDLE_THRESHOLDS["conn_max"] and
        metrics.conn_avg <= IDLE_THRESHOLDS["conn_avg"] and
        metrics.qps_max <= IDLE_THRESHOLDS["qps_max"] and
        metrics.qps_avg <= IDLE_THRESHOLDS["qps_avg"]
    )


def check_low_utilization(metrics: RedisMetrics) -> bool:
    """检测是否低利用率。
    
    低利用率条件：所有指标同时满足阈值
    - 所有指标: 峰值 <= 30% 且 均值 <= 15%
    """
    return (
        metrics.cpu_max <= LOW_UTIL_THRESHOLDS["cpu_max"] and
        metrics.cpu_avg <= LOW_UTIL_THRESHOLDS["cpu_avg"] and
        metrics.mem_max <= LOW_UTIL_THRESHOLDS["mem_max"] and
        metrics.mem_avg <= LOW_UTIL_THRESHOLDS["mem_avg"] and
        metrics.conn_max <= LOW_UTIL_THRESHOLDS["conn_max"] and
        metrics.conn_avg <= LOW_UTIL_THRESHOLDS["conn_avg"] and
        metrics.qps_max <= LOW_UTIL_THRESHOLDS["qps_max"] and
        metrics.qps_avg <= LOW_UTIL_THRESHOLDS["qps_avg"]
    )


def check_billing_optimization(charge_type: str, create_time: str) -> tuple[bool, int]:
    """检测是否需要计费优化。
    
    Args:
        charge_type: 计费方式
        create_time: 创建时间
    
    Returns:
        (是否需要优化, 持有天数)
    """
    if charge_type != "PostPaid":
        return False, 0
    
    try:
        # 解析创建时间
        create_dt = datetime.fromisoformat(create_time.replace("Z", "+00:00"))
        hold_days = (datetime.now(timezone.utc) - create_dt).days
        return hold_days > BILLING_HOLD_DAYS, hold_days
    except Exception:
        return False, 0


def generate_report_lines(
    analyzed_instances: list[RedisInstanceInfo],
    region_id: str,
    days: int,
) -> list[str]:
    """生成 Markdown 报告行。"""
    lines = []
    lines.append("# Redis 成本优化报告")
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
            lines.append("| 实例 ID | 实例名 | 规格 | CPU峰/均 | 内存峰/均 | 连接峰/均 | QPS峰/均 |")
            lines.append("|----------|--------|------|----------|----------|----------|---------|")
            for inst in idle_instances:
                m = inst.metrics
                lines.append(
                    f"| `{inst.instance_id}` | {inst.instance_name[:10] or '-'} | "
                    f"{inst.instance_class} | {m.cpu_max:.0f}/{m.cpu_avg:.0f}% | "
                    f"{m.mem_max:.0f}/{m.mem_avg:.0f}% | {m.conn_max:.0f}/{m.conn_avg:.0f}% | "
                    f"{m.qps_max:.0f}/{m.qps_avg:.0f} |"
                )
            lines.append("")
        
        if low_util_instances:
            lines.append("### 🟡 低利用率（建议降配）")
            lines.append("")
            lines.append("| 实例 ID | 实例名 | 规格 | CPU峰/均 | 内存峰/均 | 连接峰/均 | QPS峰/均 |")
            lines.append("|----------|--------|------|----------|----------|----------|---------|")
            for inst in low_util_instances:
                m = inst.metrics
                lines.append(
                    f"| `{inst.instance_id}` | {inst.instance_name[:10] or '-'} | "
                    f"{inst.instance_class} | {m.cpu_max:.0f}/{m.cpu_avg:.0f}% | "
                    f"{m.mem_max:.0f}/{m.mem_avg:.0f}% | {m.conn_max:.0f}/{m.conn_avg:.0f}% | "
                    f"{m.qps_max:.0f}/{m.qps_avg:.0f} |"
                )
            lines.append("")
        
        if billing_instances:
            lines.append("### 🟡 计费优化（建议转包月）")
            lines.append("")
            lines.append("| 实例 ID | 实例名 | 规格 | 持有天数 | 建议 |")
            lines.append("|----------|--------|------|----------|------|")
            for inst in billing_instances:
                hold_days = next(
                    (i["hold_days"] for i in inst.issues if i.get("rule") == "BillingOptimization"),
                    0
                )
                lines.append(
                    f"| `{inst.instance_id}` | {inst.instance_name[:10] or '-'} | "
                    f"{inst.instance_class} | {hold_days} 天 | 转包月 |"
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
    
    return lines


# =============================================================================
# 框架集成：列举实例函数
# =============================================================================

async def list_redis_instances(
    ak: str,
    sk: str,
    region_id: str,
) -> list[ResourceInstance]:
    """列举 Redis 实例。
    
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
        endpoint=f"r-kvstore.{region_id}.aliyuncs.com",
        region_id=region_id,
    )
    client = RedisClient(config)
    
    instances: list[ResourceInstance] = []
    page = 1
    
    while True:
        req = redis_models.DescribeInstancesRequest(
            region_id=region_id,
            page_number=page,
            page_size=50,
        )
        resp = await asyncio.to_thread(client.describe_instances, req)
        body = resp.body
        
        if body.instances and body.instances.kvstore_instance:
            for inst in body.instances.kvstore_instance:
                # 过滤非正常状态
                if inst.instance_status != "Normal":
                    continue
                
                # 解析付费类型
                charge_type_str = inst.charge_type or "PostPaid"
                charge_type = ChargeType.from_str(charge_type_str)
                
                instances.append(ResourceInstance(
                    resource_id=inst.instance_id or "",
                    resource_name=inst.instance_name or "",
                    region_id=region_id,
                    zone_id=inst.zone_id or "",
                    instance_type=inst.instance_class or "",
                    charge_type=charge_type,
                    creation_time=inst.create_time or "",
                    status=inst.instance_status or "",
                    raw={
                        "engine_version": inst.engine_version,
                        "capacity": inst.capacity,
                        "network_type": inst.network_type,
                    },
                ))
        
        total = body.total_count or 0
        if len(instances) >= total:
            break
        page += 1
    
    return instances


# =============================================================================
# 产品配置注册
# =============================================================================

REDIS_CONFIG = ProductConfig(
    product_code="redis",
    product_name="云数据库 Redis",
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
            params={"threshold": 20.0},
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
            namespace="acs_kvstore",
            days=14,
            threshold=1.0,
        ),
        MetricConfig(
            metric_name="MemoryUsage",
            namespace="acs_kvstore",
            days=14,
            threshold=1.0,
        ),
    ],
    idle_days=14,
    pricing_module_code="InstanceClass",
    pricing_config_template="InstanceClass:{spec},Region:{region}",
    list_instances_fn=list_redis_instances,
)

# 注册产品配置
register_product(REDIS_CONFIG)


# =============================================================================
# 资源包推荐功能
# =============================================================================

@dataclass
class ResourcePackageRecommendation:
    """资源包推荐。"""
    package_type: str  # storage
    package_spec: str
    package_price: float
    current_usage: str
    current_amount: float
    estimated_saving: float
    saving_percent: float
    recommendation: str


@dataclass
class RedisUsageMetrics:
    """Redis 用量指标（用于资源包推荐）。"""
    # 存储消耗
    storage_gb_hours: float = 0.0
    storage_amount: float = 0.0  # 存储按量消费金额
    
    # 总消费
    total_amount: float = 0.0
    
    # 查询时段
    start_date: str = ""
    end_date: str = ""


@dataclass
class RedisPackageResult:
    """Redis 资源包分析结果。"""
    region_id: str = ""
    metrics: RedisUsageMetrics = field(default_factory=RedisUsageMetrics)
    recommendations: list[ResourcePackageRecommendation] = field(default_factory=list)
    total_potential_saving: float = 0.0
    issues: list[dict] = field(default_factory=list)


def recommend_storage_package(
    monthly_gb_hours: float,
    monthly_amount: float,
) -> Optional[ResourcePackageRecommendation]:
    """根据月存储消耗推荐资源包。
    
    Args:
        monthly_gb_hours: 月GB*小时消耗
        monthly_amount: 月按量消费金额
    
    Returns:
        资源包推荐
    """
    if monthly_gb_hours <= 0 or monthly_amount <= 0:
        return None
    
    suitable_pkg = None
    for pkg in STORAGE_PACKAGES:
        if pkg["quota"] >= monthly_gb_hours:
            suitable_pkg = pkg
            break
    
    if not suitable_pkg:
        suitable_pkg = STORAGE_PACKAGES[-1]
    
    pkg_price = suitable_pkg["price_per_month"]
    saving = monthly_amount - pkg_price
    saving_percent = (saving / monthly_amount * 100) if monthly_amount > 0 else 0
    
    if saving_percent < 10:
        return None
    
    return ResourcePackageRecommendation(
        package_type="storage",
        package_spec=suitable_pkg["spec"],
        package_price=pkg_price,
        current_usage=f"{monthly_gb_hours:.2f} GB*小时/月",
        current_amount=monthly_amount,
        estimated_saving=saving,
        saving_percent=saving_percent,
        recommendation=f"推荐购买 {suitable_pkg['spec']} 存储资源包，月省 ¥{saving:.2f}",
    )


def analyze_redis_package_usage(metrics: RedisUsageMetrics) -> RedisPackageResult:
    """分析 Redis 用量并给出资源包推荐。
    
    Args:
        metrics: 用量指标
    
    Returns:
        资源包分析结果
    """
    result = RedisPackageResult(metrics=metrics)
    recommendations = []
    total_saving = 0.0
    
    # 存储资源包推荐
    storage_rec = recommend_storage_package(
        metrics.storage_gb_hours,
        metrics.storage_amount,
    )
    if storage_rec:
        recommendations.append(storage_rec)
        total_saving += storage_rec.estimated_saving
    
    result.recommendations = recommendations
    result.total_potential_saving = total_saving
    
    if recommendations:
        result.issues.append({
            "rule": "StorageResourcePackage",
            "severity": "medium",
            "issue": f"Redis 按量消费 ¥{metrics.total_amount:.2f}/月，可通过存储资源包优化",
            "recommendation": f"购买推荐资源包可节省约 ¥{total_saving:.2f}/月",
            "potential_saving": f"¥{total_saving:.2f}/月",
        })
    
    return result


def generate_package_report_lines(result: RedisPackageResult) -> list[str]:
    """生成 Redis 资源包优化报告内容。"""
    lines = []
    
    if not result.recommendations:
        lines.append("Redis 当前配置已优化，无需购买资源包。")
        return lines
    
    metrics = result.metrics
    lines.append(f"**查询时段**: {metrics.start_date} ~ {metrics.end_date}")
    lines.append("")
    lines.append("**用量统计**:")
    lines.append(f"- 存储消耗: {metrics.storage_gb_hours:.2f} GB*小时，消费 ¥{metrics.storage_amount:.2f}")
    lines.append(f"- 总消费: ¥{metrics.total_amount:.2f}")
    lines.append("")
    lines.append("**存储资源包推荐**:")
    lines.append("")
    lines.append("| 推荐规格 | 资源包月价 | 当前月消费 | 预计节省 |")
    lines.append("|----------|------------|------------|----------|")
    
    for rec in result.recommendations:
        lines.append(
            f"| {rec.package_spec} | ¥{rec.package_price:.2f} | "
            f"¥{rec.current_amount:.2f} | ¥{rec.estimated_saving:.2f} ({rec.saving_percent:.1f}%) |"
        )
    
    lines.append("")
    lines.append(f"**总潜在节省**: ¥{result.total_potential_saving:.2f}/月")
    
    return lines

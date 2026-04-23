# -*- coding: utf-8 -*-
"""ARMS 应用实时监控服务产品配置。

配置项：
- ProductCode: arms
- 规则链: 资源包推荐（按量消费转资源包）
- 检测项: 调用量资源包 / Span存储资源包
- 数据源: BSS 账单查询 API

检测逻辑：
1. 查询近30天 ARMS 按量计费账单
2. 提取调用量（RequestCount）和 Span 存储（SpanStorage）用量
3. 根据用量推荐合适的资源包规格
4. 计算资源包价格 vs 按量价格的节省金额

资源包规格（示例，实际价格需查询）：
- 调用量资源包: 1000万次/月 起
- Span存储资源包: 100GB 起
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Optional

logger = logging.getLogger(__name__)


# 调用量资源包规格（万次/月）
REQUEST_PACKAGES = [
    {"spec": "1000万次", "monthly_quota": 10_000_000, "price_per_month": 100},
    {"spec": "5000万次", "monthly_quota": 50_000_000, "price_per_month": 400},
    {"spec": "1亿次", "monthly_quota": 100_000_000, "price_per_month": 700},
    {"spec": "5亿次", "monthly_quota": 500_000_000, "price_per_month": 3000},
    {"spec": "10亿次", "monthly_quota": 1_000_000_000, "price_per_month": 5000},
]

# Span存储资源包规格（GB）
SPAN_STORAGE_PACKAGES = [
    {"spec": "100GB", "quota_gb": 100, "price_per_month": 50},
    {"spec": "500GB", "quota_gb": 500, "price_per_month": 200},
    {"spec": "1TB", "quota_gb": 1024, "price_per_month": 350},
    {"spec": "5TB", "quota_gb": 5120, "price_per_month": 1500},
    {"spec": "10TB", "quota_gb": 10240, "price_per_month": 2800},
]

# 按量单价（参考）
PAY_AS_YOU_GO_PRICES = {
    "request_per_10k": 0.015,      # 每万次调用
    "span_storage_per_gb": 0.8,   # 每GB存储
}


@dataclass
class ArmsUsageMetrics:
    """ARMS 用量指标。"""
    # 调用量（次）
    request_count: int = 0
    request_amount: float = 0.0  # 调用量按量消费金额
    
    # Span存储（GB）
    span_storage_gb: float = 0.0
    span_storage_amount: float = 0.0  # 存储按量消费金额
    
    # 总消费
    total_amount: float = 0.0
    
    # 查询时段
    start_date: str = ""
    end_date: str = ""


@dataclass
class ResourcePackageRecommendation:
    """资源包推荐。"""
    package_type: str  # request / span_storage
    package_spec: str  # 资源包规格
    package_price: float  # 资源包月价
    current_usage: str  # 当前用量描述
    current_amount: float  # 当前按量消费
    estimated_saving: float  # 预计月节省
    saving_percent: float  # 节省百分比
    recommendation: str  # 推荐说明


@dataclass
class ArmsOptimizationResult:
    """ARMS 优化分析结果。"""
    region_id: str = ""
    metrics: ArmsUsageMetrics = field(default_factory=ArmsUsageMetrics)
    recommendations: list[ResourcePackageRecommendation] = field(default_factory=list)
    total_potential_saving: float = 0.0
    issues: list[dict] = field(default_factory=list)


def recommend_request_package(
    monthly_request_count: int,
    monthly_amount: float,
) -> Optional[ResourcePackageRecommendation]:
    """根据月调用量推荐资源包。
    
    Args:
        monthly_request_count: 月调用次数
        monthly_amount: 月按量消费金额
    
    Returns:
        资源包推荐，如无合适则返回 None
    """
    if monthly_request_count <= 0 or monthly_amount <= 0:
        return None
    
    # 找到能覆盖用量的最小资源包
    suitable_pkg = None
    for pkg in REQUEST_PACKAGES:
        if pkg["monthly_quota"] >= monthly_request_count:
            suitable_pkg = pkg
            break
    
    if not suitable_pkg:
        # 用量超过最大资源包，选择最大的
        suitable_pkg = REQUEST_PACKAGES[-1]
    
    # 计算节省
    pkg_price = suitable_pkg["price_per_month"]
    saving = monthly_amount - pkg_price
    saving_percent = (saving / monthly_amount * 100) if monthly_amount > 0 else 0
    
    # 只有节省 > 10% 才推荐
    if saving_percent < 10:
        return None
    
    return ResourcePackageRecommendation(
        package_type="request",
        package_spec=suitable_pkg["spec"],
        package_price=pkg_price,
        current_usage=f"{monthly_request_count:,} 次/月",
        current_amount=monthly_amount,
        estimated_saving=saving,
        saving_percent=saving_percent,
        recommendation=f"推荐购买 {suitable_pkg['spec']} 调用量资源包，月省 ¥{saving:.2f}",
    )


def recommend_span_storage_package(
    monthly_storage_gb: float,
    monthly_amount: float,
) -> Optional[ResourcePackageRecommendation]:
    """根据月Span存储量推荐资源包。
    
    Args:
        monthly_storage_gb: 月Span存储量(GB)
        monthly_amount: 月按量消费金额
    
    Returns:
        资源包推荐，如无合适则返回 None
    """
    if monthly_storage_gb <= 0 or monthly_amount <= 0:
        return None
    
    # 找到能覆盖用量的最小资源包
    suitable_pkg = None
    for pkg in SPAN_STORAGE_PACKAGES:
        if pkg["quota_gb"] >= monthly_storage_gb:
            suitable_pkg = pkg
            break
    
    if not suitable_pkg:
        suitable_pkg = SPAN_STORAGE_PACKAGES[-1]
    
    # 计算节省
    pkg_price = suitable_pkg["price_per_month"]
    saving = monthly_amount - pkg_price
    saving_percent = (saving / monthly_amount * 100) if monthly_amount > 0 else 0
    
    if saving_percent < 10:
        return None
    
    return ResourcePackageRecommendation(
        package_type="span_storage",
        package_spec=suitable_pkg["spec"],
        package_price=pkg_price,
        current_usage=f"{monthly_storage_gb:.2f} GB/月",
        current_amount=monthly_amount,
        estimated_saving=saving,
        saving_percent=saving_percent,
        recommendation=f"推荐购买 {suitable_pkg['spec']} Span存储资源包，月省 ¥{saving:.2f}",
    )


def analyze_arms_usage(metrics: ArmsUsageMetrics) -> ArmsOptimizationResult:
    """分析 ARMS 用量并给出资源包推荐。
    
    Args:
        metrics: 用量指标
    
    Returns:
        优化分析结果
    """
    result = ArmsOptimizationResult(metrics=metrics)
    recommendations = []
    total_saving = 0.0
    
    # 调用量资源包推荐
    req_rec = recommend_request_package(
        metrics.request_count,
        metrics.request_amount,
    )
    if req_rec:
        recommendations.append(req_rec)
        total_saving += req_rec.estimated_saving
    
    # Span存储资源包推荐
    span_rec = recommend_span_storage_package(
        metrics.span_storage_gb,
        metrics.span_storage_amount,
    )
    if span_rec:
        recommendations.append(span_rec)
        total_saving += span_rec.estimated_saving
    
    result.recommendations = recommendations
    result.total_potential_saving = total_saving
    
    # 生成问题列表
    if recommendations:
        result.issues.append({
            "rule": "ResourcePackageOptimization",
            "severity": "medium",
            "issue": f"ARMS 按量消费 ¥{metrics.total_amount:.2f}/月，可通过资源包优化",
            "recommendation": f"购买推荐资源包可节省约 ¥{total_saving:.2f}/月 ({total_saving/metrics.total_amount*100:.1f}%)" if metrics.total_amount > 0 else "",
            "potential_saving": f"¥{total_saving:.2f}/月",
        })
    
    return result


def generate_report_lines(result: ArmsOptimizationResult) -> list[str]:
    """生成 ARMS 优化报告内容。"""
    lines = []
    
    if not result.recommendations:
        lines.append("ARMS 当前配置已优化，无需调整。")
        return lines
    
    metrics = result.metrics
    lines.append(f"**查询时段**: {metrics.start_date} ~ {metrics.end_date}")
    lines.append("")
    lines.append("**用量统计**:")
    lines.append(f"- 调用量: {metrics.request_count:,} 次，消费 ¥{metrics.request_amount:.2f}")
    lines.append(f"- Span存储: {metrics.span_storage_gb:.2f} GB，消费 ¥{metrics.span_storage_amount:.2f}")
    lines.append(f"- 总消费: ¥{metrics.total_amount:.2f}")
    lines.append("")
    lines.append("**资源包推荐**:")
    lines.append("")
    
    for rec in result.recommendations:
        lines.append(f"| 类型 | 推荐规格 | 资源包价 | 当前消费 | 预计节省 |")
        lines.append(f"|------|----------|----------|----------|----------|")
        lines.append(
            f"| {rec.package_type} | {rec.package_spec} | "
            f"¥{rec.package_price:.2f} | ¥{rec.current_amount:.2f} | "
            f"¥{rec.estimated_saving:.2f} ({rec.saving_percent:.1f}%) |"
        )
        lines.append("")
    
    lines.append(f"**总潜在节省**: ¥{result.total_potential_saving:.2f}/月")
    
    return lines

# -*- coding: utf-8 -*-
"""MaxCompute 大数据计算服务产品配置。

配置项：
- ProductCode: odps (MaxCompute)
- 规则链: CU资源包推荐
- 检测项: 按量CU消费转CU资源包
- 数据源: BSS 账单查询 API

检测逻辑：
1. 查询近30天 MaxCompute 按量计费账单
2. 提取 CU 消耗时长（CU*小时）
3. 根据用量推荐合适的 CU 资源包
4. 计算资源包价格 vs 按量价格的节省金额

MaxCompute 计费项：
- 计算费用（按 CU*小时计费）
- 存储费用（按存储量计费）
- 下载费用（公网下载）
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Optional

logger = logging.getLogger(__name__)


# CU 资源包规格（CU*小时/月）
CU_PACKAGES = [
    {"spec": "100 CU*小时", "quota": 100, "price_per_month": 30},
    {"spec": "500 CU*小时", "quota": 500, "price_per_month": 120},
    {"spec": "1000 CU*小时", "quota": 1000, "price_per_month": 200},
    {"spec": "5000 CU*小时", "quota": 5000, "price_per_month": 800},
    {"spec": "10000 CU*小时", "quota": 10000, "price_per_month": 1400},
    {"spec": "50000 CU*小时", "quota": 50000, "price_per_month": 6000},
]

# 存储资源包规格（GB/月）
STORAGE_PACKAGES = [
    {"spec": "100GB", "quota_gb": 100, "price_per_month": 20},
    {"spec": "500GB", "quota_gb": 500, "price_per_month": 80},
    {"spec": "1TB", "quota_gb": 1024, "price_per_month": 150},
    {"spec": "5TB", "quota_gb": 5120, "price_per_month": 600},
    {"spec": "10TB", "quota_gb": 10240, "price_per_month": 1000},
]

# 按量单价（参考）
PAY_AS_YOU_GO_PRICES = {
    "cu_hour": 0.35,          # 每 CU*小时
    "storage_per_gb": 0.0192,  # 每GB存储/天
}


@dataclass
class MaxComputeUsageMetrics:
    """MaxCompute 用量指标。"""
    # CU 消耗
    cu_hours: float = 0.0
    cu_amount: float = 0.0  # CU 按量消费金额
    
    # 存储用量
    storage_gb: float = 0.0
    storage_amount: float = 0.0  # 存储按量消费金额
    
    # 下载用量
    download_gb: float = 0.0
    download_amount: float = 0.0
    
    # 总消费
    total_amount: float = 0.0
    
    # 查询时段
    start_date: str = ""
    end_date: str = ""


@dataclass
class ResourcePackageRecommendation:
    """资源包推荐。"""
    package_type: str  # cu / storage
    package_spec: str
    package_price: float
    current_usage: str
    current_amount: float
    estimated_saving: float
    saving_percent: float
    recommendation: str


@dataclass
class MaxComputeOptimizationResult:
    """MaxCompute 优化分析结果。"""
    region_id: str = ""
    project_name: str = ""
    metrics: MaxComputeUsageMetrics = field(default_factory=MaxComputeUsageMetrics)
    recommendations: list[ResourcePackageRecommendation] = field(default_factory=list)
    total_potential_saving: float = 0.0
    issues: list[dict] = field(default_factory=list)


def recommend_cu_package(
    monthly_cu_hours: float,
    monthly_amount: float,
) -> Optional[ResourcePackageRecommendation]:
    """根据月CU消耗推荐资源包。
    
    Args:
        monthly_cu_hours: 月CU*小时消耗
        monthly_amount: 月按量消费金额
    
    Returns:
        资源包推荐
    """
    if monthly_cu_hours <= 0 or monthly_amount <= 0:
        return None
    
    suitable_pkg = None
    for pkg in CU_PACKAGES:
        if pkg["quota"] >= monthly_cu_hours:
            suitable_pkg = pkg
            break
    
    if not suitable_pkg:
        suitable_pkg = CU_PACKAGES[-1]
    
    pkg_price = suitable_pkg["price_per_month"]
    saving = monthly_amount - pkg_price
    saving_percent = (saving / monthly_amount * 100) if monthly_amount > 0 else 0
    
    if saving_percent < 10:
        return None
    
    return ResourcePackageRecommendation(
        package_type="cu",
        package_spec=suitable_pkg["spec"],
        package_price=pkg_price,
        current_usage=f"{monthly_cu_hours:.2f} CU*小时/月",
        current_amount=monthly_amount,
        estimated_saving=saving,
        saving_percent=saving_percent,
        recommendation=f"推荐购买 {suitable_pkg['spec']} CU资源包，月省 ¥{saving:.2f}",
    )


def recommend_storage_package(
    avg_storage_gb: float,
    monthly_amount: float,
) -> Optional[ResourcePackageRecommendation]:
    """根据存储用量推荐资源包。
    
    Args:
        avg_storage_gb: 平均存储量(GB)
        monthly_amount: 月存储消费金额
    
    Returns:
        资源包推荐
    """
    if avg_storage_gb <= 0 or monthly_amount <= 0:
        return None
    
    suitable_pkg = None
    for pkg in STORAGE_PACKAGES:
        if pkg["quota_gb"] >= avg_storage_gb:
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
        current_usage=f"{avg_storage_gb:.2f} GB",
        current_amount=monthly_amount,
        estimated_saving=saving,
        saving_percent=saving_percent,
        recommendation=f"推荐购买 {suitable_pkg['spec']} 存储资源包，月省 ¥{saving:.2f}",
    )


def analyze_maxcompute_usage(metrics: MaxComputeUsageMetrics) -> MaxComputeOptimizationResult:
    """分析 MaxCompute 用量并给出资源包推荐。
    
    Args:
        metrics: 用量指标
    
    Returns:
        优化分析结果
    """
    result = MaxComputeOptimizationResult(metrics=metrics)
    recommendations = []
    total_saving = 0.0
    
    # CU 资源包推荐
    cu_rec = recommend_cu_package(metrics.cu_hours, metrics.cu_amount)
    if cu_rec:
        recommendations.append(cu_rec)
        total_saving += cu_rec.estimated_saving
    
    # 存储资源包推荐
    storage_rec = recommend_storage_package(metrics.storage_gb, metrics.storage_amount)
    if storage_rec:
        recommendations.append(storage_rec)
        total_saving += storage_rec.estimated_saving
    
    result.recommendations = recommendations
    result.total_potential_saving = total_saving
    
    if recommendations:
        result.issues.append({
            "rule": "ResourcePackageOptimization",
            "severity": "medium",
            "issue": f"MaxCompute 按量消费 ¥{metrics.total_amount:.2f}/月，可通过资源包优化",
            "recommendation": f"购买推荐资源包可节省约 ¥{total_saving:.2f}/月",
            "potential_saving": f"¥{total_saving:.2f}/月",
        })
    
    return result


def generate_report_lines(result: MaxComputeOptimizationResult) -> list[str]:
    """生成 MaxCompute 优化报告内容。"""
    lines = []
    
    if not result.recommendations:
        lines.append("MaxCompute 当前配置已优化，无需调整。")
        return lines
    
    metrics = result.metrics
    lines.append(f"**查询时段**: {metrics.start_date} ~ {metrics.end_date}")
    lines.append("")
    lines.append("**用量统计**:")
    lines.append(f"- CU消耗: {metrics.cu_hours:.2f} CU*小时，消费 ¥{metrics.cu_amount:.2f}")
    lines.append(f"- 存储: {metrics.storage_gb:.2f} GB，消费 ¥{metrics.storage_amount:.2f}")
    if metrics.download_amount > 0:
        lines.append(f"- 下载: {metrics.download_gb:.2f} GB，消费 ¥{metrics.download_amount:.2f}")
    lines.append(f"- 总消费: ¥{metrics.total_amount:.2f}")
    lines.append("")
    lines.append("**资源包推荐**:")
    lines.append("")
    lines.append("| 类型 | 推荐规格 | 资源包价 | 当前消费 | 预计节省 |")
    lines.append("|------|----------|----------|----------|----------|")
    
    for rec in result.recommendations:
        lines.append(
            f"| {rec.package_type} | {rec.package_spec} | "
            f"¥{rec.package_price:.2f} | ¥{rec.current_amount:.2f} | "
            f"¥{rec.estimated_saving:.2f} ({rec.saving_percent:.1f}%) |"
        )
    
    lines.append("")
    lines.append(f"**总潜在节省**: ¥{result.total_potential_saving:.2f}/月")
    
    return lines

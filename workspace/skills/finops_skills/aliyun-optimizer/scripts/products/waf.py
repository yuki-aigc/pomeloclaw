# -*- coding: utf-8 -*-
"""WAF Web应用防火墙产品配置。

配置项：
- ProductCode: waf
- 规则链: SeCU资源包推荐
- 检测项: 按量SeCU消费转SeCU资源包
- 数据源: BSS 账单查询 API

检测逻辑：
1. 查询近30天 WAF 按量计费账单
2. 提取 SeCU 消耗量
3. 根据用量推荐合适的 SeCU 资源包
4. 计算资源包价格 vs 按量价格的节省金额

WAF 计费说明：
- SeCU (Security Compute Unit): 安全计算单元
- WAF 3.0 按量版使用 SeCU 计费
- 资源包可抵扣 SeCU 消耗
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Optional

logger = logging.getLogger(__name__)


# SeCU 资源包规格
SECU_PACKAGES = [
    {"spec": "100 SeCU", "quota": 100, "price_per_month": 50},
    {"spec": "500 SeCU", "quota": 500, "price_per_month": 200},
    {"spec": "1000 SeCU", "quota": 1000, "price_per_month": 350},
    {"spec": "5000 SeCU", "quota": 5000, "price_per_month": 1500},
    {"spec": "10000 SeCU", "quota": 10000, "price_per_month": 2800},
    {"spec": "50000 SeCU", "quota": 50000, "price_per_month": 12000},
]

# 按量单价（参考）
PAY_AS_YOU_GO_PRICES = {
    "secu": 0.6,  # 每 SeCU
}


@dataclass
class WafUsageMetrics:
    """WAF 用量指标。"""
    # SeCU 消耗
    secu_count: float = 0.0
    secu_amount: float = 0.0  # SeCU 按量消费金额
    
    # 请求数（参考）
    request_count: int = 0
    
    # 域名数
    domain_count: int = 0
    
    # 总消费
    total_amount: float = 0.0
    
    # 查询时段
    start_date: str = ""
    end_date: str = ""


@dataclass
class ResourcePackageRecommendation:
    """资源包推荐。"""
    package_type: str  # secu
    package_spec: str
    package_price: float
    current_usage: str
    current_amount: float
    estimated_saving: float
    saving_percent: float
    recommendation: str


@dataclass
class WafOptimizationResult:
    """WAF 优化分析结果。"""
    region_id: str = ""
    instance_id: str = ""
    metrics: WafUsageMetrics = field(default_factory=WafUsageMetrics)
    recommendations: list[ResourcePackageRecommendation] = field(default_factory=list)
    total_potential_saving: float = 0.0
    issues: list[dict] = field(default_factory=list)


def recommend_secu_package(
    monthly_secu: float,
    monthly_amount: float,
) -> Optional[ResourcePackageRecommendation]:
    """根据月SeCU消耗推荐资源包。
    
    Args:
        monthly_secu: 月SeCU消耗
        monthly_amount: 月按量消费金额
    
    Returns:
        资源包推荐
    """
    if monthly_secu <= 0 or monthly_amount <= 0:
        return None
    
    suitable_pkg = None
    for pkg in SECU_PACKAGES:
        if pkg["quota"] >= monthly_secu:
            suitable_pkg = pkg
            break
    
    if not suitable_pkg:
        suitable_pkg = SECU_PACKAGES[-1]
    
    pkg_price = suitable_pkg["price_per_month"]
    saving = monthly_amount - pkg_price
    saving_percent = (saving / monthly_amount * 100) if monthly_amount > 0 else 0
    
    # 只有节省 > 10% 才推荐
    if saving_percent < 10:
        return None
    
    return ResourcePackageRecommendation(
        package_type="secu",
        package_spec=suitable_pkg["spec"],
        package_price=pkg_price,
        current_usage=f"{monthly_secu:.2f} SeCU/月",
        current_amount=monthly_amount,
        estimated_saving=saving,
        saving_percent=saving_percent,
        recommendation=f"推荐购买 {suitable_pkg['spec']} SeCU资源包，月省 ¥{saving:.2f}",
    )


def analyze_waf_usage(metrics: WafUsageMetrics) -> WafOptimizationResult:
    """分析 WAF 用量并给出资源包推荐。
    
    Args:
        metrics: 用量指标
    
    Returns:
        优化分析结果
    """
    result = WafOptimizationResult(metrics=metrics)
    recommendations = []
    total_saving = 0.0
    
    # SeCU 资源包推荐
    secu_rec = recommend_secu_package(metrics.secu_count, metrics.secu_amount)
    if secu_rec:
        recommendations.append(secu_rec)
        total_saving += secu_rec.estimated_saving
    
    result.recommendations = recommendations
    result.total_potential_saving = total_saving
    
    if recommendations:
        result.issues.append({
            "rule": "SeCUResourcePackage",
            "severity": "medium",
            "issue": f"WAF 按量消费 ¥{metrics.total_amount:.2f}/月，可通过SeCU资源包优化",
            "recommendation": f"购买推荐资源包可节省约 ¥{total_saving:.2f}/月",
            "potential_saving": f"¥{total_saving:.2f}/月",
        })
    
    return result


def check_waf_config_optimization(
    instance_info: dict,
) -> list[dict]:
    """检查 WAF 配置优化项。
    
    检测项：
    1. 域名接入方式（CNAME vs 透明代理）
    2. 防护规则配置
    3. Bot管理配置
    
    Args:
        instance_info: WAF 实例信息
    
    Returns:
        优化建议列表
    """
    issues = []
    
    # 检查是否有未接入的域名配额
    domain_count = instance_info.get("domain_count", 0)
    domain_quota = instance_info.get("domain_quota", 0)
    
    if domain_quota > 0 and domain_count < domain_quota * 0.5:
        issues.append({
            "rule": "DomainQuotaUtilization",
            "severity": "low",
            "issue": f"域名配额利用率低: {domain_count}/{domain_quota} ({domain_count/domain_quota*100:.1f}%)",
            "recommendation": "考虑降低域名配额或接入更多域名",
            "potential_saving": "视情况而定",
        })
    
    return issues


def generate_report_lines(result: WafOptimizationResult) -> list[str]:
    """生成 WAF 优化报告内容。"""
    lines = []
    
    if not result.recommendations and not result.issues:
        lines.append("WAF 当前配置已优化，无需调整。")
        return lines
    
    metrics = result.metrics
    lines.append(f"**查询时段**: {metrics.start_date} ~ {metrics.end_date}")
    lines.append("")
    lines.append("**用量统计**:")
    lines.append(f"- SeCU消耗: {metrics.secu_count:.2f} SeCU，消费 ¥{metrics.secu_amount:.2f}")
    if metrics.domain_count > 0:
        lines.append(f"- 防护域名数: {metrics.domain_count}")
    lines.append(f"- 总消费: ¥{metrics.total_amount:.2f}")
    lines.append("")
    
    if result.recommendations:
        lines.append("**SeCU资源包推荐**:")
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

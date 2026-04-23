# -*- coding: utf-8 -*-
"""Elasticsearch 检索分析产品配置。

配置项：
- ProductCode: elasticsearch
- 规则链: 低利用率检测 / 计费方式检测
- 数据源: Elasticsearch API + 云监控

核心 API：
- ListInstance: 列举实例
- 云监控指标: CpuPercent / HeapMemoryUsage

检测规则：
- 低利用率: 30天 CPU峰值<30% 且 HeapMemory使用率峰值<30%
- 计费优化: 按量付费超过 30 天且费用高于包月

实例类型: ES实例 和 LS实例（Logstash）
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Optional

logger = logging.getLogger(__name__)


# =============================================================================
# 阈值配置
# =============================================================================

# 低利用率检测阈值
LOW_UTIL_THRESHOLDS = {
    "cpu_max": 30,          # CPU 峰值 < 30%
    "heap_memory_max": 30,  # HeapMemory 使用率峰值 < 30%
}

# 计费优化阈值
BILLING_HOLD_DAYS = 30


@dataclass
class EsNodeMetrics:
    """ES 节点监控指标。"""
    node_type: str  # data / kibana / master
    cpu_max: float = 0.0
    cpu_avg: float = 0.0
    heap_memory_max: float = 0.0
    heap_memory_avg: float = 0.0


@dataclass
class EsMetrics:
    """Elasticsearch 监控指标数据。"""
    cpu_max: float = 0.0
    cpu_avg: float = 0.0
    heap_memory_max: float = 0.0
    heap_memory_avg: float = 0.0
    # 各节点指标
    node_metrics: list[EsNodeMetrics] = field(default_factory=list)


@dataclass
class EsInstanceInfo:
    """Elasticsearch 实例信息。"""
    instance_id: str
    instance_name: str
    instance_type: str  # elasticsearch / logstash
    version: str
    spec: str  # 规格
    node_amount: int  # 节点数
    charge_type: str  # prepaid / postpaid
    create_time: str
    status: str
    region_id: str
    # 监控数据
    metrics: EsMetrics = field(default_factory=EsMetrics)
    # 检测结果
    is_low_util: bool = False
    billing_issue: bool = False
    issues: list[dict] = field(default_factory=list)


def check_low_utilization(metrics: EsMetrics) -> bool:
    """检测是否低利用率。
    
    低利用率条件：
    - CPU 峰值 < 30%
    - HeapMemory 使用率峰值 < 30%
    """
    return (
        metrics.cpu_max < LOW_UTIL_THRESHOLDS["cpu_max"] and
        metrics.heap_memory_max < LOW_UTIL_THRESHOLDS["heap_memory_max"]
    )


def check_billing_optimization(charge_type: str, create_time: str) -> tuple[bool, int]:
    """检测是否需要计费优化。"""
    if charge_type not in ("postpaid", "PostPaid", "Postpaid", "POSTPAID"):
        return False, 0
    
    try:
        create_dt = datetime.fromisoformat(create_time.replace("Z", "+00:00"))
        hold_days = (datetime.now(timezone.utc) - create_dt).days
        return hold_days > BILLING_HOLD_DAYS, hold_days
    except Exception:
        return False, 0


def generate_report_lines(
    analyzed_instances: list[EsInstanceInfo],
    region_id: str,
    days: int,
) -> list[str]:
    """生成 Markdown 报告行。"""
    lines = []
    lines.append("# Elasticsearch 成本优化报告")
    lines.append("")
    lines.append(f"> 生成时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    lines.append(f"> 分析区域: {region_id}")
    lines.append(f"> 检测周期: {days} 天")
    lines.append("")
    
    # 统计
    low_util_instances = [i for i in analyzed_instances if i.is_low_util]
    billing_instances = [i for i in analyzed_instances if i.billing_issue]
    
    # 概览
    lines.append("## 概览")
    lines.append("")
    lines.append("| 检测项 | 问题数 | 状态 |")
    lines.append("|--------|-------:|------|")
    lines.append(f"| 实例总数 | {len(analyzed_instances)} | - |")
    lines.append(f"| 低利用率 | {len(low_util_instances)} | {'🟡 可优化' if low_util_instances else '✅ 正常'} |")
    lines.append(f"| 计费优化 | {len(billing_instances)} | {'🟡 可优化' if billing_instances else '✅ 正常'} |")
    lines.append("")
    
    # 优化建议
    has_issues = low_util_instances or billing_instances
    if has_issues:
        lines.append("## 优化建议")
        lines.append("")
        
        if low_util_instances:
            lines.append("### 🟡 低利用率（建议降配）")
            lines.append("")
            lines.append("| 实例 ID | 实例名 | 类型 | 规格 | 节点数 | CPU峰值 | Heap峰值 |")
            lines.append("|----------|--------|------|------|--------|---------|----------|")
            for inst in low_util_instances:
                m = inst.metrics
                lines.append(
                    f"| `{inst.instance_id}` | {inst.instance_name[:10] or '-'} | "
                    f"{inst.instance_type} | {inst.spec} | {inst.node_amount} | "
                    f"{m.cpu_max:.0f}% | {m.heap_memory_max:.0f}% |"
                )
            lines.append("")
            lines.append("> 变配参考: https://help.aliyun.com/zh/es/user-guide/downgrade-the-configuration-of-a-cluster")
            lines.append("")
            lines.append("> 其他优化方式：")
            lines.append("> 1. 降节点数量（注意分片重新分配）")
            lines.append("> 2. 转AMD CPU（需评估环境兼容性）")
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
                    f"{inst.instance_type} | {inst.spec} | {hold_days} 天 |"
                )
            lines.append("")
            lines.append("> 操作参考: https://help.aliyun.com/zh/es/product-overview/switch-the-billing-method-of-a-cluster-from-pay-as-you-go-to-subscription")
            lines.append("")
    else:
        lines.append("## 分析结论")
        lines.append("")
        lines.append("> 所有 Elasticsearch 实例均处于健康状态，无需优化操作。")
        lines.append("")
    
    # 检测规则说明
    lines.append("---")
    lines.append("")
    lines.append("检测规则说明：")
    lines.append("- **低利用率**: 30天 CPU峰值<30% 且 HeapMemory使用率峰值<30%")
    lines.append("- **计费优化**: 按量付费超过30天，建议转包月")
    
    return lines

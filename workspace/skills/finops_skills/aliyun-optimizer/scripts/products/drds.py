# -*- coding: utf-8 -*-
"""DRDS (PolarDB-X 分布式版) 产品配置。

配置项：
- ProductCode: drds / polardbx
- 规则链: 闲置检测 / 低利用率检测 / 计费方式检测
- 数据源: PolarDB-X API + 云监控 (acs_drds)

核心 API：
- DescribeDBInstances: 列举实例
- 云监控指标: CpuUsage / MemoryUsage / ConnectionUsage / QPS

检测规则：
- 闲置: CPU峰值≤1%且均值≤1%, 内存峰值≤30%且均值≤15%, 连接数峰值≤50且均值≤25, QPS峰值≤50且均值≤25
- 低利用率: CPU/内存 峰值≤30%且均值≤15%
- 计费优化: 按量付费超过 30 天且费用高于包月
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

# 闲置检测阈值
IDLE_THRESHOLDS = {
    "cpu_max": 1,       # CPU 峰值 <= 1%
    "cpu_avg": 1,       # CPU 均值 <= 1%
    "mem_max": 30,      # 内存峰值 <= 30%
    "mem_avg": 15,      # 内存均值 <= 15%
    "conn_max": 50,     # 连接数峰值 <= 50
    "conn_avg": 25,     # 连接数均值 <= 25
    "qps_max": 50,      # QPS 峰值 <= 50
    "qps_avg": 25,      # QPS 均值 <= 25
}

# 低利用率检测阈值
LOW_UTIL_THRESHOLDS = {
    "cpu_max": 30,      # CPU 峰值 <= 30%
    "cpu_avg": 15,      # CPU 均值 <= 15%
    "mem_max": 30,      # 内存峰值 <= 30%
    "mem_avg": 15,      # 内存均值 <= 15%
}

# 计费优化阈值
BILLING_HOLD_DAYS = 30


@dataclass
class DrdsMetrics:
    """DRDS 监控指标数据。"""
    cpu_max: float = 0.0
    cpu_avg: float = 0.0
    mem_max: float = 0.0
    mem_avg: float = 0.0
    conn_max: float = 0.0
    conn_avg: float = 0.0
    qps_max: float = 0.0
    qps_avg: float = 0.0


@dataclass
class DrdsInstanceInfo:
    """DRDS 实例信息。"""
    instance_id: str
    instance_name: str
    instance_class: str  # 规格
    engine: str  # polarx
    engine_version: str
    charge_type: str  # Prepaid / Postpaid
    create_time: str
    status: str
    region_id: str
    node_count: int = 0
    # 监控数据
    metrics: DrdsMetrics = field(default_factory=DrdsMetrics)
    # 检测结果
    is_idle: bool = False
    is_low_util: bool = False
    billing_issue: bool = False
    issues: list[dict] = field(default_factory=list)


def check_idle(metrics: DrdsMetrics) -> bool:
    """检测是否闲置。
    
    闲置条件：所有指标同时满足阈值
    - CPU: 峰值 <= 1% 且 均值 <= 1%
    - 内存: 峰值 <= 30% 且 均值 <= 15%
    - 连接数: 峰值 <= 50 且 均值 <= 25
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


def check_low_utilization(metrics: DrdsMetrics) -> bool:
    """检测是否低利用率。
    
    低利用率条件：
    - CPU: 峰值 <= 30% 且 均值 <= 15%
    - 内存: 峰值 <= 30% 且 均值 <= 15%
    """
    return (
        metrics.cpu_max <= LOW_UTIL_THRESHOLDS["cpu_max"] and
        metrics.cpu_avg <= LOW_UTIL_THRESHOLDS["cpu_avg"] and
        metrics.mem_max <= LOW_UTIL_THRESHOLDS["mem_max"] and
        metrics.mem_avg <= LOW_UTIL_THRESHOLDS["mem_avg"]
    )


def check_billing_optimization(charge_type: str, create_time: str) -> tuple[bool, int]:
    """检测是否需要计费优化。"""
    if charge_type not in ("Postpaid", "PostPaid", "POSTPAID"):
        return False, 0
    
    try:
        create_dt = datetime.fromisoformat(create_time.replace("Z", "+00:00"))
        hold_days = (datetime.now(timezone.utc) - create_dt).days
        return hold_days > BILLING_HOLD_DAYS, hold_days
    except Exception:
        return False, 0


def generate_report_lines(
    analyzed_instances: list[DrdsInstanceInfo],
    region_id: str,
    days: int,
) -> list[str]:
    """生成 Markdown 报告行。"""
    lines = []
    lines.append("# PolarDB-X 分布式版成本优化报告")
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
                    f"{m.mem_max:.0f}/{m.mem_avg:.0f}% | {m.conn_max:.0f}/{m.conn_avg:.0f} | "
                    f"{m.qps_max:.0f}/{m.qps_avg:.0f} |"
                )
            lines.append("")
        
        if low_util_instances:
            lines.append("### 🟡 低利用率（建议降配）")
            lines.append("")
            lines.append("| 实例 ID | 实例名 | 规格 | CPU峰/均 | 内存峰/均 |")
            lines.append("|----------|--------|------|----------|----------|")
            for inst in low_util_instances:
                m = inst.metrics
                lines.append(
                    f"| `{inst.instance_id}` | {inst.instance_name[:10] or '-'} | "
                    f"{inst.instance_class} | {m.cpu_max:.0f}/{m.cpu_avg:.0f}% | "
                    f"{m.mem_max:.0f}/{m.mem_avg:.0f}% |"
                )
            lines.append("")
            lines.append("> 变配操作参考: https://help.aliyun.com/zh/polardb/polardb-for-xscale/change-instance-specifications")
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
        lines.append("> 所有 PolarDB-X 实例均处于健康状态，无需优化操作。")
        lines.append("")
    
    # 检测规则说明
    lines.append("---")
    lines.append("")
    lines.append("检测规则说明：")
    lines.append("- **闲置**: CPU峰值≤1%且均值≤1%, 内存峰值≤30%且均值≤15%, 连接数峰值≤50且均值≤25, QPS峰值≤50且均值≤25")
    lines.append("- **低利用率**: CPU/内存 峰值≤30%且均值≤15%")
    lines.append("- **计费优化**: 按量付费超过30天，建议转包月")
    
    return lines

# -*- coding: utf-8 -*-
"""SLS 日志服务产品配置。

配置项：
- ProductCode: sls
- 规则链: 智能存储分层检测
- 数据源: SLS API (alibabacloud_sls20201230)

核心 API：
- ListProject: 列举 Project
- ListLogStores: 列举 Logstore
- GetLogStore: 获取 Logstore 详情

检测规则：
- 保留期 > 7 天的 Logstore 应开启智能存储分层
- 智能分层后，冷数据自动转储到低成本存储，降低 70% 存储成本
- 分层条件: hot_ttl > 0 且 hot_ttl < ttl
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Optional

from core.base import (
    ProductConfig,
    RuleConfig,
    IdleCheckMethod,
    OptimizeStrategy,
    ResourceInstance,
    ChargeType,
)
from products import register_product

logger = logging.getLogger(__name__)


# 检测阈值：保留期超过此天数才检测分层
MIN_TTL_FOR_TIERING = 7


@dataclass
class LogstoreInfo:
    """Logstore 信息。"""
    project: str
    logstore: str
    ttl: int  # 总保留天数
    hot_ttl: int  # 热存储天数（0 表示未配置分层）
    shard_count: int = 0
    # 检测结果
    has_tiering: bool = False
    has_issue: bool = False


def check_tiering(ttl: int, hot_ttl: int) -> tuple[bool, bool]:
    """检测是否开启智能分层。
    
    Args:
        ttl: 总保留天数
        hot_ttl: 热存储天数
    
    Returns:
        (是否已开启分层, 是否存在问题)
    
    分层判定：
    - hot_ttl > 0 且 hot_ttl < ttl 表示开启了分层
    - ttl > 7 天但未开启分层，视为问题
    """
    has_tiering = hot_ttl > 0 and hot_ttl < ttl
    has_issue = not has_tiering and ttl > MIN_TTL_FOR_TIERING
    
    return has_tiering, has_issue


def generate_report_lines(
    analyzed_logstores: list[LogstoreInfo],
    all_projects: list[Any],
    region_id: str,
) -> list[str]:
    """生成 Markdown 报告行。"""
    lines = []
    lines.append("# SLS 成本优化报告")
    lines.append("")
    lines.append(f"> 生成时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    lines.append(f"> 分析区域: {region_id}")
    lines.append("")
    
    # 统计
    issue_logstores = [ls for ls in analyzed_logstores if ls.has_issue]
    
    # 概览
    lines.append("## 概览")
    lines.append("")
    lines.append("| 检测项 | 数量 | 状态 |")
    lines.append("|--------|-----:|------|")
    lines.append(f"| Project 总数 | {len(all_projects)} | - |")
    lines.append(f"| Logstore 总数 | {len(analyzed_logstores)} | - |")
    lines.append(f"| 未开启智能分层 | {len(issue_logstores)} | {'🟡 可优化' if issue_logstores else '✅ 正常'} |")
    lines.append("")
    
    # 优化建议
    if issue_logstores:
        lines.append("## 优化建议 - 开启智能存储分层")
        lines.append("")
        lines.append("| Project | Logstore | 保留天数 | 热存储天数 | 建议 |")
        lines.append("|---------|----------|----------|------------|------|")
        for ls in issue_logstores:
            hot_ttl_str = str(ls.hot_ttl) if ls.hot_ttl > 0 else "未配置"
            lines.append(
                f"| `{ls.project}` | `{ls.logstore}` | "
                f"{ls.ttl} | {hot_ttl_str} | 开启智能分层 |"
            )
        lines.append("")
        lines.append("> **建议**: 开启智能存储分层后，访问频率低的日志数据会自动转储到冷存储，")
        lines.append("> 冷存储成本比热存储低约 70%，可显著降低长期存储成本。")
    else:
        lines.append("## 分析结论")
        lines.append("")
        if not analyzed_logstores:
            lines.append("> 当前区域无 SLS Logstore。")
        else:
            lines.append("> 所有 Logstore 均已开启智能存储分层或保留期较短，配置良好。")
    
    lines.append("")
    lines.append("---")
    lines.append("")
    lines.append("检测规则说明：")
    lines.append("- **智能分层**: 保留时间 > 7 天的 Logstore 应开启智能存储分层")
    lines.append("- **冷存储**: 自动将不常访问的日志转储，降低 70% 存储成本")
    
    return lines


# =============================================================================
# 产品配置注册（SLS 是按 Project/Logstore 组织，不是实例模式）
# =============================================================================

async def list_sls_instances(
    ak: str,
    sk: str,
    region_id: str,
) -> list[ResourceInstance]:
    """列举 SLS 资源（返回空列表，SLS 使用独立优化工具）。"""
    # SLS 不适合统一框架的实例列举模式
    # 应该使用 opt_sls_cost_optimization 独立工具
    return []


SLS_CONFIG = ProductConfig(
    product_code="sls",
    product_name="日志服务 SLS",
    rule_chain=[
        RuleConfig(
            rule_id="IdleResourceCheck",
            enabled=False,
            strategy=OptimizeStrategy.RELEASE,
        ),
    ],
    idle_check_method=IdleCheckMethod.STATUS,
    idle_days=14,
    pricing_module_code="sls",
    pricing_config_template="",
    list_instances_fn=list_sls_instances,
)

# 注册产品配置
register_product(SLS_CONFIG)

# -*- coding: utf-8 -*-
"""RocketMQ 云消息队列产品配置。

配置项：
- ProductCode: rocketmq
- 规则链: 闲置检测 (Serverless Topic)
- 数据源: RocketMQ API + 云监控

核心 API：
- ListInstances: 列举实例
- ListTopics: 列举 Topic
- 云监控: 检测 Topic 活跃度

检测规则：
- Serverless 实例，过去 7 天内 Topic 无监控数据，建议删除不活跃 Topic

计费说明：
- Serverless 实例按 Topic 数量收费，Topic 被创建就收费
- 参考: https://help.aliyun.com/zh/apsaramq-for-rocketmq/cloud-message-queue-rocketmq-5-x-series/product-overview/serverless-instance-billing
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Optional

logger = logging.getLogger(__name__)


# 闲置检测天数
IDLE_DURATION_DAYS = 7


@dataclass
class TopicInfo:
    """Topic 信息。"""
    topic_name: str
    instance_id: str
    message_type: str
    status: str
    create_time: str
    # 监控数据
    has_traffic: bool = True  # 是否有流量
    last_active_time: str = ""


@dataclass
class RocketMQInstanceInfo:
    """RocketMQ 实例信息。"""
    instance_id: str
    instance_name: str
    instance_type: str  # standard / serverless
    series_code: str  # standard / professional / platinum
    status: str
    region_id: str
    create_time: str
    # Topic 信息
    total_topics: int = 0
    idle_topics: list[TopicInfo] = field(default_factory=list)


def check_topic_idle(topic: TopicInfo) -> bool:
    """检测 Topic 是否闲置。
    
    闲置条件：过去 7 天无监控数据
    """
    return not topic.has_traffic


def generate_report_lines(
    analyzed_instances: list[RocketMQInstanceInfo],
    region_id: str,
    days: int,
) -> list[str]:
    """生成 Markdown 报告行。"""
    lines = []
    lines.append("# RocketMQ 成本优化报告")
    lines.append("")
    lines.append(f"> 生成时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    lines.append(f"> 分析区域: {region_id}")
    lines.append(f"> 检测周期: {days} 天")
    lines.append("")
    
    # 统计
    serverless_instances = [i for i in analyzed_instances if i.instance_type == "serverless"]
    total_idle_topics = sum(len(i.idle_topics) for i in analyzed_instances)
    
    # 概览
    lines.append("## 概览")
    lines.append("")
    lines.append("| 检测项 | 数量 | 状态 |")
    lines.append("|--------|-----:|------|")
    lines.append(f"| 实例总数 | {len(analyzed_instances)} | - |")
    lines.append(f"| Serverless 实例 | {len(serverless_instances)} | - |")
    lines.append(f"| 闲置 Topic 数 | {total_idle_topics} | {'🟡 可优化' if total_idle_topics > 0 else '✅ 正常'} |")
    lines.append("")
    
    # 优化建议
    if total_idle_topics > 0:
        lines.append("## 优化建议 - 删除闲置 Topic")
        lines.append("")
        lines.append("| 实例 ID | 实例名 | Topic 名称 | 消息类型 | 建议 |")
        lines.append("|----------|--------|-----------|----------|------|")
        for inst in analyzed_instances:
            for topic in inst.idle_topics:
                lines.append(
                    f"| `{inst.instance_id}` | {inst.instance_name[:10] or '-'} | "
                    f"`{topic.topic_name}` | {topic.message_type} | 删除 |"
                )
        lines.append("")
        lines.append("> **建议**: Serverless 实例按 Topic 数量收费，建议删除不活跃的 Topic 以节约成本。")
        lines.append(">")
        lines.append("> 计费规则: https://help.aliyun.com/zh/apsaramq-for-rocketmq/cloud-message-queue-rocketmq-5-x-series/product-overview/serverless-instance-billing")
    else:
        lines.append("## 分析结论")
        lines.append("")
        lines.append("> 所有 RocketMQ Topic 均处于活跃状态，无需优化。")
    
    lines.append("")
    lines.append("---")
    lines.append("")
    lines.append("检测规则说明：")
    lines.append("- **闲置 Topic**: Serverless 实例中，过去 7 天无监控数据的 Topic")
    lines.append("- **计费影响**: Topic 被创建即收费，不管是否生产消息")
    
    return lines

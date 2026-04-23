# -*- coding: utf-8 -*-
"""NAT 网关产品配置。

配置项：
- ProductCode: nat
- 规则链: 闲置检测
- 数据源: VPC API

核心 API：
- DescribeNatGateways: 列举 NAT 网关
- DescribeSnatTableEntries: 查询 SNAT 条目
- DescribeForwardTableEntries: 查询 DNAT 条目

检测规则：
- 闲置判定: 无绑定 EIP，或者无 DNAT 条目且无 SNAT 条目
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Optional

from alibabacloud_tea_openapi.models import Config
from alibabacloud_vpc20160428.client import Client as VpcClient
from alibabacloud_vpc20160428 import models as vpc_models

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


@dataclass
class NatGatewayInfo:
    """NAT 网关信息。"""
    nat_id: str
    nat_name: str
    nat_type: str  # Normal / Enhanced
    spec: str  # Small / Middle / Large / XLarge.1
    status: str
    vpc_id: str
    region_id: str
    # 绑定信息
    eip_list: list[str] = field(default_factory=list)
    snat_count: int = 0
    dnat_count: int = 0
    # 检测结果
    is_idle: bool = False
    idle_reason: list[str] = field(default_factory=list)


def check_idle(nat_info: NatGatewayInfo) -> tuple[bool, list[str]]:
    """检测 NAT 网关是否闲置。
    
    闲置条件（满足任一）：
    1. 无绑定 EIP
    2. 无 DNAT 条目 且 无 SNAT 条目
    
    Args:
        nat_info: NAT 网关信息
    
    Returns:
        (是否闲置, 闲置原因列表)
    """
    reasons = []
    
    has_eip = len(nat_info.eip_list) > 0
    has_rules = nat_info.snat_count > 0 or nat_info.dnat_count > 0
    
    if not has_eip:
        reasons.append("无绑定EIP")
    
    if not has_rules:
        if nat_info.snat_count == 0:
            reasons.append("无SNAT条目")
        if nat_info.dnat_count == 0:
            reasons.append("无DNAT条目")
    
    # 闲置判定: 无EIP 或 无规则
    is_idle = not has_eip or not has_rules
    
    return is_idle, reasons


def generate_report_lines(
    analyzed_nats: list[NatGatewayInfo],
    region_id: str,
) -> list[str]:
    """生成 Markdown 报告行。"""
    lines = []
    lines.append("# NAT 网关闲置检测报告")
    lines.append("")
    lines.append(f"> 生成时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    lines.append(f"> 分析区域: {region_id}")
    lines.append("")
    
    # 统计
    idle_nats = [n for n in analyzed_nats if n.is_idle]
    
    # 概览
    lines.append("## 概览")
    lines.append("")
    lines.append("| 检测项 | 数量 | 状态 |")
    lines.append("|--------|-----:|------|")
    lines.append(f"| NAT 总数 | {len(analyzed_nats)} | - |")
    lines.append(f"| 闲置 NAT | {len(idle_nats)} | {'🔴 需关注' if idle_nats else '✅ 正常'} |")
    lines.append("")
    
    # 闲置详情
    if idle_nats:
        lines.append("## 闲置 NAT 详情")
        lines.append("")
        lines.append("| NAT ID | 名称 | 类型 | 规格 | EIP数 | SNAT | DNAT | 闲置原因 |")
        lines.append("|--------|------|------|------|------:|-----:|-----:|----------|")
        for nat in idle_nats:
            lines.append(
                f"| `{nat.nat_id}` | {nat.nat_name[:10] or '-'} | "
                f"{nat.nat_type} | {nat.spec} | {len(nat.eip_list)} | "
                f"{nat.snat_count} | {nat.dnat_count} | {', '.join(nat.idle_reason)} |"
            )
        lines.append("")
        lines.append("> **建议**: NAT闲置资源建议结合实际业务考虑对实例进行释放")
    else:
        lines.append("## 分析结论")
        lines.append("")
        lines.append("> 所有 NAT 网关均正常使用，无闲置资源。")
    
    lines.append("")
    lines.append("---")
    lines.append("")
    lines.append("检测规则说明：")
    lines.append("- **闲置判定**: 无绑定EIP，或者无DNAT条目且无SNAT条目")
    
    return lines


# =============================================================================
# 框架集成：列举实例函数
# =============================================================================

async def list_nat_instances(
    ak: str,
    sk: str,
    region_id: str,
) -> list[ResourceInstance]:
    """列举 NAT 网关实例。
    
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
        endpoint=f"vpc.{region_id}.aliyuncs.com",
        region_id=region_id,
    )
    client = VpcClient(config)
    
    instances: list[ResourceInstance] = []
    page = 1
    
    while True:
        req = vpc_models.DescribeNatGatewaysRequest(
            region_id=region_id,
            page_number=page,
            page_size=50,
        )
        resp = await asyncio.to_thread(client.describe_nat_gateways, req)
        body = resp.body
        
        if body.nat_gateways and body.nat_gateways.nat_gateway:
            for nat in body.nat_gateways.nat_gateway:
                # 过滤非可用状态
                if nat.status != "Available":
                    continue
                
                # NAT 默认按量付费
                charge_type = ChargeType.POST_PAID
                
                # 检查是否有绑定 EIP
                eip_count = 0
                if nat.ip_lists and nat.ip_lists.ip_list:
                    eip_count = len(nat.ip_lists.ip_list)
                
                instances.append(ResourceInstance(
                    resource_id=nat.nat_gateway_id or "",
                    resource_name=nat.name or "",
                    region_id=region_id,
                    zone_id="",
                    instance_type=nat.spec or "",
                    charge_type=charge_type,
                    creation_time=nat.creation_time or "",
                    status=nat.status or "",
                    raw={
                        "nat_type": nat.nat_type,
                        "vpc_id": nat.vpc_id,
                        "eip_count": eip_count,
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

NAT_CONFIG = ProductConfig(
    product_code="nat",
    product_name="NAT 网关",
    rule_chain=[
        RuleConfig(
            rule_id="IdleResourceCheck",
            enabled=True,
            strategy=OptimizeStrategy.RELEASE,
        ),
        RuleConfig(
            rule_id="PostPaidLongTermCheck",
            enabled=True,
            strategy=OptimizeStrategy.CONVERT_TO_PREPAID,
            params={"hold_days": 30},
        ),
    ],
    idle_check_method=IdleCheckMethod.STATUS,
    idle_status_field="eip_count",  # eip_count=0 视为闲置
    idle_status_value=0,
    idle_days=14,
    pricing_module_code="natgateway",
    pricing_config_template="Spec:{spec},Region:{region}",
    list_instances_fn=list_nat_instances,
)

# 注册产品配置
register_product(NAT_CONFIG)

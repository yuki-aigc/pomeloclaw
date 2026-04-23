# -*- coding: utf-8 -*-
"""EIP 弹性公网 IP 产品配置。

配置项：
- ProductCode: eip
- 规则链: 仅 IdleResourceCheck
- 闲置判定方式: 方式 B（基于状态：是否绑定）
- 不启用低利用率和按量长期持有检测
"""

from __future__ import annotations

import asyncio
import logging

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


async def list_eip_instances(
    ak: str,
    sk: str,
    region_id: str,
    status: str = "",
) -> list[ResourceInstance]:
    """列举 EIP 实例。
    
    Args:
        ak: AccessKey ID
        sk: AccessKey Secret
        region_id: 地域 ID
        status: 状态筛选（可选）
    
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
        req = vpc_models.DescribeEipAddressesRequest(
            region_id=region_id,
            page_number=page,
            page_size=100,
        )
        resp = await asyncio.to_thread(client.describe_eip_addresses, req)
        body = resp.body
        
        eips = body.eip_addresses.eip_address if body.eip_addresses and body.eip_addresses.eip_address else []
        
        for eip in eips:
            eip_status = eip.status or ""
            
            # 解析付费类型
            charge_type_str = eip.charge_type or "PostPaid"
            charge_type = ChargeType.from_str(charge_type_str)
            
            # 判断是否已绑定
            instance_id = eip.instance_id or ""
            is_bindded = bool(instance_id)
            
            # 带宽规格
            bandwidth = eip.bandwidth or ""
            spec_desc = f"{bandwidth}Mbps"
            
            instances.append(ResourceInstance(
                resource_id=eip.allocation_id or "",
                resource_name=eip.name or eip.ip_address or "",
                region_id=region_id,
                zone_id="",  # EIP 无可用区概念
                instance_type=spec_desc,
                charge_type=charge_type,
                creation_time=eip.allocation_time or "",
                status=eip_status,
                raw={
                    "ip_address": eip.ip_address or "",
                    "bandwidth": bandwidth,
                    "instance_id": instance_id,
                    "instance_type": eip.instance_type or "",  # 绑定的资源类型
                    "is_bindded": is_bindded,
                    "internet_charge_type": eip.internet_charge_type or "",
                },
            ))
        
        total = body.total_count or 0
        if len(instances) >= total:
            break
        page += 1
    
    return instances


# ========== 产品配置 ==========

EIP_CONFIG = ProductConfig(
    product_code="eip",
    product_name="弹性公网 IP",
    rule_chain=[
        # EIP 仅启用闲置检测
        RuleConfig(
            rule_id="IdleResourceCheck",
            enabled=True,
            strategy=OptimizeStrategy.RELEASE,
        ),
        # 不启用低利用率检测
        # 不启用按量长期持有检测
    ],
    idle_check_method=IdleCheckMethod.STATUS,
    idle_metrics=[],  # 方式 B 不使用监控指标
    idle_status_field="is_bindded",
    idle_status_value=False,  # 未绑定判定为闲置
    idle_days=14,
    pricing_module_code="",  # EIP 询价结构不同，暂不支持
    pricing_config_template="",
    list_instances_fn=list_eip_instances,
    get_recommend_spec_fn=None,
)

# 注册产品配置
register_product(EIP_CONFIG)

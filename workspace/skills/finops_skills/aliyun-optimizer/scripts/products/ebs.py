# -*- coding: utf-8 -*-
"""EBS 云盘产品配置。

配置项：
- ProductCode: disk
- 规则链: IdleResourceCheck → PostPaidLongTermCheck
- 闲置判定方式: 方式 B（基于状态：是否挂载）
- 不启用低利用率检测
"""

from __future__ import annotations

import asyncio
import logging
from typing import Optional

from alibabacloud_tea_openapi.models import Config
from alibabacloud_ecs20140526.client import Client as EcsClient
from alibabacloud_ecs20140526 import models as ecs_models

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


async def list_ebs_instances(
    ak: str,
    sk: str,
    region_id: str,
    status: str = "",
) -> list[ResourceInstance]:
    """列举云盘实例。
    
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
        endpoint=f"ecs.{region_id}.aliyuncs.com",
        region_id=region_id,
    )
    client = EcsClient(config)
    
    instances: list[ResourceInstance] = []
    page = 1
    
    while True:
        req = ecs_models.DescribeDisksRequest(
            region_id=region_id,
            page_number=page,
            page_size=100,
        )
        resp = await asyncio.to_thread(client.describe_disks, req)
        body = resp.body
        
        disks = body.disks.disk if body.disks and body.disks.disk else []
        
        for disk in disks:
            disk_status = disk.status or ""
            
            # 解析付费类型
            charge_type_str = disk.disk_charge_type or "PostPaid"
            charge_type = ChargeType.from_str(charge_type_str)
            
            # 判断是否已挂载
            instance_id = disk.instance_id or ""
            is_attached = bool(instance_id)
            
            # 构建规格描述
            disk_type = disk.type or ""  # system / data
            category = disk.category or ""  # cloud_ssd / cloud_essd 等
            size = disk.size or 0
            spec_desc = f"{category}:{size}GB"
            
            instances.append(ResourceInstance(
                resource_id=disk.disk_id or "",
                resource_name=disk.disk_name or "",
                region_id=region_id,
                zone_id=disk.zone_id or "",
                instance_type=spec_desc,
                charge_type=charge_type,
                creation_time=disk.creation_time or "",
                status=disk_status,
                raw={
                    "type": disk_type,
                    "category": category,
                    "size": size,
                    "instance_id": instance_id,
                    "is_attached": is_attached,
                    "portable": disk.portable,
                },
            ))
        
        total = body.total_count or 0
        if len(instances) >= total:
            break
        page += 1
    
    return instances


# ========== 产品配置 ==========

EBS_CONFIG = ProductConfig(
    product_code="disk",
    product_name="云盘 EBS",
    rule_chain=[
        RuleConfig(
            rule_id="IdleResourceCheck",
            enabled=True,
            strategy=OptimizeStrategy.RELEASE,
        ),
        # 云盘不启用低利用率检测
        RuleConfig(
            rule_id="PostPaidLongTermCheck",
            enabled=True,
            strategy=OptimizeStrategy.CONVERT_TO_PREPAID,
            params={"hold_days": 30},
        ),
    ],
    idle_check_method=IdleCheckMethod.STATUS,
    idle_metrics=[],  # 方式 B 不使用监控指标
    idle_status_field="is_attached",
    idle_status_value=False,  # 未挂载判定为闲置
    idle_days=14,
    pricing_module_code="DataDisk",
    pricing_config_template="DataDisk.Category:{spec},DataDisk.Size:100,Region:{region}",
    list_instances_fn=list_ebs_instances,
    get_recommend_spec_fn=None,  # 云盘不支持降配
)

# 注册产品配置
register_product(EBS_CONFIG)

# -*- coding: utf-8 -*-
"""SLB 负载均衡产品配置。

配置项：
- ProductCode: slb
- 规则链: IdleResourceCheck → LowUtilizationCheck
- 闲置判定方式: 方式 B（基于状态：后端服务器是否为空）
- 不启用按量长期持有检测
"""

from __future__ import annotations

import asyncio
import logging

from alibabacloud_tea_openapi.models import Config
from alibabacloud_slb20140515.client import Client as SlbClient
from alibabacloud_slb20140515 import models as slb_models

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


async def list_slb_instances(
    ak: str,
    sk: str,
    region_id: str,
    status: str = "",
) -> list[ResourceInstance]:
    """列举 SLB 实例。
    
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
        endpoint=f"slb.{region_id}.aliyuncs.com",
        region_id=region_id,
    )
    client = SlbClient(config)
    
    instances: list[ResourceInstance] = []
    page = 1
    
    while True:
        req = slb_models.DescribeLoadBalancersRequest(
            region_id=region_id,
            page_number=page,
            page_size=100,
        )
        resp = await asyncio.to_thread(client.describe_load_balancers, req)
        body = resp.body
        
        slbs = body.load_balancers.load_balancer if body.load_balancers and body.load_balancers.load_balancer else []
        
        for slb in slbs:
            slb_status = slb.load_balancer_status or ""
            
            # 状态筛选
            if status and slb_status != status:
                continue
            
            # 解析付费类型
            pay_type = slb.pay_type or "PayOnDemand"
            if pay_type == "PayOnDemand":
                charge_type = ChargeType.POST_PAID
            else:
                charge_type = ChargeType.PRE_PAID
            
            # 判断后端服务器是否为空（需要额外 API 调用）
            # 简化处理：这里假设 SLB 有后端，具体检测在规则执行时进行
            has_backend = True  # 占位
            
            # 规格
            spec = slb.load_balancer_spec or "slb.s1.small"
            
            instances.append(ResourceInstance(
                resource_id=slb.load_balancer_id or "",
                resource_name=slb.load_balancer_name or "",
                region_id=region_id,
                zone_id=slb.master_zone_id or "",
                instance_type=spec,
                charge_type=charge_type,
                creation_time=slb.create_time_stamp_utc or slb.create_time or "",
                status=slb_status,
                raw={
                    "address": slb.address or "",
                    "address_type": slb.address_type or "",
                    "network_type": slb.network_type or "",
                    "vpc_id": slb.vpc_id or "",
                    "has_backend": has_backend,  # 需要在规则检测时具体判断
                    "bandwidth": slb.bandwidth,
                },
            ))
        
        total = body.total_count or 0
        if len(instances) >= total:
            break
        page += 1
    
    return instances


async def check_slb_backend(
    ak: str,
    sk: str,
    region_id: str,
    load_balancer_id: str,
) -> bool:
    """检查 SLB 是否有有效后端服务器。
    
    Args:
        ak: AccessKey ID
        sk: AccessKey Secret
        region_id: 地域 ID
        load_balancer_id: SLB 实例 ID
    
    Returns:
        True 表示有后端，False 表示无后端（闲置）
    """
    config = Config(
        access_key_id=ak,
        access_key_secret=sk,
        endpoint=f"slb.{region_id}.aliyuncs.com",
        region_id=region_id,
    )
    client = SlbClient(config)
    
    try:
        req = slb_models.DescribeLoadBalancerAttributeRequest(
            region_id=region_id,
            load_balancer_id=load_balancer_id,
        )
        resp = await asyncio.to_thread(client.describe_load_balancer_attribute, req)
        body = resp.body
        
        # 检查后端服务器
        if body.backend_servers and body.backend_servers.backend_server:
            # 有后端服务器
            return len(body.backend_servers.backend_server) > 0
        
        return False
    
    except Exception as e:
        logger.warning("检查 SLB 后端失败: %s", e)
        return True  # 出错时保守处理，认为有后端


# ========== 产品配置 ==========

SLB_CONFIG = ProductConfig(
    product_code="slb",
    product_name="负载均衡 SLB",
    rule_chain=[
        RuleConfig(
            rule_id="IdleResourceCheck",
            enabled=True,
            strategy=OptimizeStrategy.RELEASE,
        ),
        RuleConfig(
            rule_id="LowUtilizationCheck",
            enabled=True,
            strategy=OptimizeStrategy.DOWN_SCALING,
            params={"threshold": 20.0},
        ),
        # SLB 不启用按量长期持有检测
    ],
    idle_check_method=IdleCheckMethod.STATUS,
    idle_metrics=[
        # SLB 也可以基于连接数/流量监控判断低利用率
        MetricConfig(
            metric_name="ActiveConnection",
            namespace="acs_slb_dashboard",
            days=7,
            threshold=10.0,  # 活跃连接数阈值
        ),
    ],
    idle_status_field="has_backend",
    idle_status_value=False,  # 无后端判定为闲置
    idle_days=14,
    pricing_module_code="LoadBalancerSpec",
    pricing_config_template="LoadBalancerSpec:{spec},Region:{region}",
    list_instances_fn=list_slb_instances,
    get_recommend_spec_fn=None,  # SLB 降配需要更复杂的逻辑
)

# 注册产品配置
register_product(SLB_CONFIG)

# -*- coding: utf-8 -*-
"""ECS 云服务器产品配置。

配置项：
- ProductCode: ecs
- 规则链: IdleResourceCheck → LowUtilizationCheck → PostPaidLongTermCheck
- 闲置判定方式: 方式 A（基于监控）
- 监控指标: CPUUtilization, memory_usedutilization
- 询价 ModuleCode: InstanceType

核心 API：
- DescribeResourceStatusDiagnosis: 批量获取低利用率可降配实例列表
- DescribeSceneResourceRecommend: 获取降配推荐规格 (SceneId=76)
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Optional

from alibabacloud_tea_openapi.models import Config
from alibabacloud_tea_openapi.client import Client as OpenApiClient
from alibabacloud_tea_openapi import models as open_api_models
from alibabacloud_tea_util import models as util_models
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


# ECS 规格升降映射
_SIZE_ORDER = ["large", "xlarge", "2xlarge", "4xlarge", "8xlarge", "16xlarge"]

# 缓存可降配实例列表（按 region_id 缓存）
_DOWNSCALING_CACHE: dict[str, dict[str, dict]] = {}


def _get_adjacent_type(inst_type: str, direction: str) -> Optional[str]:
    """获取相邻规格（升配/降配）。
    
    Args:
        inst_type: 当前规格（如 ecs.g6.large）
        direction: "up" 或 "down"
    
    Returns:
        相邻规格，无法匹配返回 None
    """
    parts = inst_type.split(".")
    if len(parts) < 3:
        return None
    
    family = ".".join(parts[:2])
    size = parts[2]
    
    if size in _SIZE_ORDER:
        idx = _SIZE_ORDER.index(size)
        if direction == "down" and idx > 0:
            return f"{family}.{_SIZE_ORDER[idx - 1]}"
        elif direction == "up" and idx < len(_SIZE_ORDER) - 1:
            return f"{family}.{_SIZE_ORDER[idx + 1]}"
    
    return None


async def list_ecs_instances(
    ak: str,
    sk: str,
    region_id: str,
    status: str = "Running",
) -> list[ResourceInstance]:
    """列举 ECS 实例。
    
    Args:
        ak: AccessKey ID
        sk: AccessKey Secret
        region_id: 地域 ID
        status: 实例状态筛选
    
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
        req = ecs_models.DescribeInstancesRequest(
            region_id=region_id,
            status=status,
            page_number=page,
            page_size=100,
        )
        resp = await asyncio.to_thread(client.describe_instances, req)
        body = resp.body
        
        if body.instances and body.instances.instance:
            for inst in body.instances.instance:
                # 解析付费类型
                charge_type_str = inst.instance_charge_type or "PostPaid"
                charge_type = ChargeType.from_str(charge_type_str)
                
                instances.append(ResourceInstance(
                    resource_id=inst.instance_id or "",
                    resource_name=inst.instance_name or "",
                    region_id=region_id,
                    zone_id=inst.zone_id or "",
                    instance_type=inst.instance_type or "",
                    charge_type=charge_type,
                    creation_time=inst.creation_time or "",
                    status=inst.status or "",
                    raw={
                        "cpu": inst.cpu,
                        "memory": inst.memory,
                        "os_name": inst.osname,
                        "tags": _extract_tags(inst),
                    },
                ))
        
        total = body.total_count or 0
        if len(instances) >= total:
            break
        page += 1
    
    return instances


def _extract_tags(inst) -> dict[str, str]:
    """从实例对象提取标签。"""
    tags = {}
    if hasattr(inst, "tags") and inst.tags and hasattr(inst.tags, "tag"):
        for t in inst.tags.tag or []:
            if t.tag_key:
                tags[t.tag_key] = t.tag_value or ""
    return tags


def _build_ecs_internal_client(ak: str, sk: str, region_id: str) -> OpenApiClient:
    """构建 ECS 内部 API 客户端 (v20160314 版本)。"""
    config = Config(
        access_key_id=ak,
        access_key_secret=sk,
        endpoint=f"ecs.{region_id}.aliyuncs.com",
        region_id=region_id,
    )
    return OpenApiClient(config)


async def get_downscaling_instances(
    ak: str,
    sk: str,
    region_id: str,
) -> dict[str, dict]:
    """批量获取可降配实例列表。
    
    调用 ECS 内部 API: DescribeResourceStatusDiagnosis
    - DiagnosisType: InstanceDownscaling
    - 返回所有符合降配条件的实例列表
    
    Args:
        ak: AccessKey ID
        sk: AccessKey Secret
        region_id: 地域 ID
    
    Returns:
        {instance_id: {cpu_percent, memory_percent, advice_reason, ...}}
    """
    # 检查缓存
    cache_key = f"{ak[:8]}_{region_id}"
    if cache_key in _DOWNSCALING_CACHE:
        return _DOWNSCALING_CACHE[cache_key]
    
    client = _build_ecs_internal_client(ak, sk, region_id)
    result: dict[str, dict] = {}
    page = 1
    
    try:
        while True:
            params = open_api_models.Params(
                action="DescribeResourceStatusDiagnosis",
                version="2016-03-14",
                protocol="HTTPS",
                method="POST",
                auth_type="AK",
                style="RPC",
                pathname="/",
                req_body_type="formData",
                body_type="json",
            )
            queries = {
                "RegionId": region_id,
                "DiagnosisType": "InstanceDownscaling",
                "PageSize": 50,
                "PageNumber": page,
            }
            runtime = util_models.RuntimeOptions(
                read_timeout=30000,
                connect_timeout=10000,
            )
            request = open_api_models.OpenApiRequest(query=queries)
            resp = await asyncio.to_thread(
                client.call_api, params, request, runtime
            )
            body = resp.get("body", {})
            
            # 解析返回数据
            resources = body.get("Resources", body.get("resources", []))
            for item in resources:
                instance_id = item.get("ResourceId", item.get("resourceId", ""))
                if instance_id:
                    # 标准化付费类型: AfterPay -> PostPaid
                    charge_type = item.get("InstanceChargeType", "")
                    if charge_type == "AfterPay":
                        charge_type = "PostPaid"
                    
                    result[instance_id] = {
                        "instance_id": instance_id,
                        "region_id": item.get("RegionId", region_id),
                        "instance_type": item.get("InstanceType", ""),
                        "charge_type": charge_type,
                        "cpu_percent": item.get("CpuUsedPercent", "0"),
                        "memory_percent": item.get("MemoryUsedPercent", "0"),
                        "advice_reason": item.get("AdviceReason", ""),
                        "zone_id": item.get("ZoneId", ""),
                    }
            
            # 分页处理
            total = body.get("TotalCount", body.get("totalCount", 0))
            if len(result) >= total or not resources:
                break
            page += 1
    
    except Exception as e:
        logger.warning("DescribeResourceStatusDiagnosis failed for %s: %s", region_id, e)
    
    # 写入缓存
    _DOWNSCALING_CACHE[cache_key] = result
    return result


async def get_ecs_recommend_spec(
    instance_id: str,
    current_type: str,
    region_id: str,
    ak: str = "",
    sk: str = "",
    **kwargs,
) -> str:
    """获取 ECS 降配推荐规格。
    
    调用 ECS 内部 API: DescribeSceneResourceRecommend
    - ProductId: 1 (ECS)
    - SceneId: 76 (降配场景)
    - 返回推荐规格列表，取 Priority 最小的
    
    Args:
        instance_id: 实例 ID
        current_type: 当前规格
        region_id: 地域 ID
        ak: AccessKey ID
        sk: AccessKey Secret
    
    Returns:
        推荐规格，无推荐返回空字符串
    """
    if not ak or not sk:
        # 无 AK/SK 时回退到简单的规格族内降一档逻辑
        return _get_adjacent_type(current_type, "down") or ""
    
    client = _build_ecs_internal_client(ak, sk, region_id)
    
    try:
        params = open_api_models.Params(
            action="DescribeSceneResourceRecommend",
            version="2016-03-14",
            protocol="HTTPS",
            method="POST",
            auth_type="AK",
            style="RPC",
            pathname="/",
            req_body_type="formData",
            body_type="json",
        )
        queries = {
            "RegionId": region_id,
            "ProductId": 1,  # ECS
            "SceneId": 76,   # 降配场景
            "ResourceId": instance_id,
        }
        runtime = util_models.RuntimeOptions(
            read_timeout=30000,
            connect_timeout=10000,
        )
        request = open_api_models.OpenApiRequest(query=queries)
        resp = await asyncio.to_thread(
            client.call_api, params, request, runtime
        )
        body = resp.get("body", {})
        
        # 解析推荐规格
        # RecommendProducts[0].RecommendInstanceSpecs[0].InstanceTypes
        products = body.get("RecommendProducts", [])
        if products:
            specs = products[0].get("RecommendInstanceSpecs", [])
            if specs:
                instance_types = specs[0].get("InstanceTypes", [])
                if instance_types:
                    # 取 Priority 最小的规格
                    sorted_types = sorted(
                        instance_types,
                        key=lambda x: x.get("Priority", 99)
                    )
                    if sorted_types:
                        return sorted_types[0].get("InstanceType", "")
    
    except Exception as e:
        logger.warning("DescribeSceneResourceRecommend failed for %s: %s", instance_id, e)
    
    # 回退到规格族内降一档
    return _get_adjacent_type(current_type, "down") or ""


# ========== 产品配置 ==========

ECS_CONFIG = ProductConfig(
    product_code="ecs",
    product_name="云服务器 ECS",
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
        RuleConfig(
            rule_id="PostPaidLongTermCheck",
            enabled=True,
            strategy=OptimizeStrategy.CONVERT_TO_PREPAID,
            params={"hold_days": 30},
        ),
    ],
    idle_check_method=IdleCheckMethod.METRIC,
    idle_metrics=[
        MetricConfig(
            metric_name="CPUUtilization",
            namespace="acs_ecs_dashboard",
            days=14,
            threshold=1.0,
        ),
        MetricConfig(
            metric_name="memory_usedutilization",
            namespace="acs_ecs_dashboard",
            days=14,
            threshold=1.0,
        ),
    ],
    idle_days=14,
    pricing_module_code="InstanceType",
    pricing_config_template="InstanceType:{spec},Region:{region}",
    list_instances_fn=list_ecs_instances,
    get_recommend_spec_fn=get_ecs_recommend_spec,
)

# 注册产品配置
register_product(ECS_CONFIG)

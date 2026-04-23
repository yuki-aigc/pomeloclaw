# -*- coding: utf-8 -*-
"""阿里云资源运维管理工具 — 提供多产品资源的生命周期管理。

支持的产品：
- ECS 云服务器：创建、删除、启动、停止、重启、降配
- RDS 数据库：启动、停止、重启、释放
- SLB 负载均衡（规划中）

所有工具函数都使用 @ops_tool 装饰器声明元数据，
由 OpsClaw 框架自动处理权限、审批、审计等横切关注点。

联动机制：
- 支持从 optimizer 导入优化建议到 Action Store
- 支持查询/执行/跳过待执行的优化动作
"""

import asyncio
import json
import logging
from typing import Optional

from alibabacloud_tea_openapi.models import Config
from alibabacloud_ecs20140526.client import Client as EcsClient
from alibabacloud_ecs20140526 import models as ecs_models
from alibabacloud_rds20140815.client import Client as RdsClient
from alibabacloud_rds20140815 import models as rds_models

import sys
from pathlib import Path
# 添加 _common 目录到 Python 路径
_common_path = Path(__file__).parent.parent.parent / "_common"
if str(_common_path) not in sys.path:
    sys.path.insert(0, str(_common_path))
# 添加 scripts 目录到 Python 路径（解决相对导入问题）
_scripts_path = Path(__file__).parent
if str(_scripts_path) not in sys.path:
    sys.path.insert(0, str(_scripts_path))
from credential import get_credential, get_ak_sk

logger = logging.getLogger(__name__)


# =============================================================================
# 工具函数
# =============================================================================


def _get_ak_sk(credential) -> tuple[str, str]:
    """从凭证中提取 AK/SK。"""
    if hasattr(credential, "access_key_id"):
        return credential.access_key_id, credential.access_key_secret
    return credential.get("access_key_id", ""), credential.get("access_key_secret", "")


def _build_ecs_client(credential, region_id: str) -> EcsClient:
    """构建 ECS 客户端。"""
    ak, sk = _get_ak_sk(credential)
    config = Config(
        access_key_id=ak,
        access_key_secret=sk,
        region_id=region_id,
        endpoint=f"ecs.{region_id}.aliyuncs.com",
    )
    return EcsClient(config)


def _build_rds_client(credential, region_id: str) -> RdsClient:
    """构建 RDS 客户端。"""
    ak, sk = _get_ak_sk(credential)
    config = Config(
        access_key_id=ak,
        access_key_secret=sk,
        region_id=region_id,
        endpoint="rds.aliyuncs.com",  # RDS 使用全局 endpoint
    )
    return RdsClient(config)


# =============================================================================
# ECS 查询类操作 (READ)
# =============================================================================


async def ops_ecs_list_instances(
    region_id: str = "cn-hangzhou",
    instance_name: Optional[str] = None,
    instance_status: Optional[str] = None,
    page_number: int = 1,
    page_size: int = 20,
    **kwargs,
) -> str:
    """查询 ECS 实例列表。

    支持按名称和状态过滤，返回实例的基本信息。

    Args:
        region_id: 区域 ID，默认 cn-hangzhou
        instance_name: 实例名称（模糊匹配，可选）
        instance_status: 实例状态（Running/Stopped，可选）
        page_number: 页码，默认 1
        page_size: 每页数量，默认 20
        **kwargs: 框架注入的参数（credential 等）

    Returns:
        实例列表的 JSON 字符串
    """
    credential = kwargs.get("credential") or get_credential()
    client = _build_ecs_client(credential, region_id)

    try:
        req = ecs_models.DescribeInstancesRequest(
            region_id=region_id,
            page_number=page_number,
            page_size=page_size,
        )
        if instance_name:
            req.instance_name = instance_name
        if instance_status:
            req.status = instance_status

        resp = await asyncio.to_thread(client.describe_instances, req)
        body = resp.body

        instances = body.instances.instance if body.instances and body.instances.instance else []
        total_count = body.total_count or 0

        simplified = []
        for inst in instances:
            # 获取公网 IP
            public_ips = []
            if inst.public_ip_address and inst.public_ip_address.ip_address:
                public_ips = inst.public_ip_address.ip_address
            
            # 获取私网 IP
            private_ips = []
            if inst.vpc_attributes and inst.vpc_attributes.private_ip_address:
                if inst.vpc_attributes.private_ip_address.ip_address:
                    private_ips = inst.vpc_attributes.private_ip_address.ip_address

            simplified.append({
                "instance_id": inst.instance_id,
                "instance_name": inst.instance_name,
                "status": inst.status,
                "instance_type": inst.instance_type,
                "cpu": inst.cpu,
                "memory": inst.memory,
                "public_ip": public_ips,
                "private_ip": private_ips,
                "creation_time": inst.creation_time,
                "expired_time": inst.expired_time,
            })

        return json.dumps({
            "total": total_count,
            "page": page_number,
            "page_size": page_size,
            "instances": simplified,
        }, ensure_ascii=False, indent=2)

    except Exception as e:
        return json.dumps({
            "success": False,
            "error": str(e),
        }, ensure_ascii=False)


async def ops_ecs_describe_instance(
    instance_id: str,
    region_id: str = "cn-hangzhou",
    **kwargs,
) -> str:
    """查询 ECS 实例详细信息。

    Args:
        instance_id: 实例 ID
        region_id: 区域 ID，默认 cn-hangzhou
        **kwargs: 框架注入的参数

    Returns:
        实例详细信息的 JSON 字符串
    """
    credential = kwargs.get("credential") or get_credential()
    client = _build_ecs_client(credential, region_id)

    try:
        req = ecs_models.DescribeInstanceAttributeRequest(instance_id=instance_id)
        resp = await asyncio.to_thread(client.describe_instance_attribute, req)
        result = resp.body

        # 获取公网 IP
        public_ips = []
        if result.public_ip_address and result.public_ip_address.ip_address:
            public_ips = result.public_ip_address.ip_address
        
        # 获取私网 IP
        private_ips = []
        if result.vpc_attributes and result.vpc_attributes.private_ip_address:
            if result.vpc_attributes.private_ip_address.ip_address:
                private_ips = result.vpc_attributes.private_ip_address.ip_address

        # 获取安全组
        security_groups = []
        if result.security_group_ids and result.security_group_ids.security_group_id:
            security_groups = result.security_group_ids.security_group_id

        simplified = {
            "instance_id": result.instance_id,
            "instance_name": result.instance_name,
            "status": result.status,
            "instance_type": result.instance_type,
            "cpu": result.cpu,
            "memory": result.memory,
            "os_name": getattr(result, "osname", None),
            "image_id": result.image_id,
            "zone_id": result.zone_id,
            "vpc_id": result.vpc_attributes.vpc_id if result.vpc_attributes else None,
            "vswitch_id": result.vpc_attributes.v_switch_id if result.vpc_attributes else None,
            "security_group_ids": security_groups,
            "public_ip": public_ips,
            "private_ip": private_ips,
            "creation_time": result.creation_time,
            "expired_time": result.expired_time,
            "instance_charge_type": result.instance_charge_type,
            "internet_charge_type": result.internet_charge_type,
        }

        return json.dumps({
            "success": True,
            "instance": simplified,
        }, ensure_ascii=False, indent=2)

    except Exception as e:
        return json.dumps({
            "success": False,
            "error": str(e),
        }, ensure_ascii=False)


# =============================================================================
# ECS 控制类操作 (WRITE)
# =============================================================================


async def ops_ecs_start_instance(
    instance_id: str,
    region_id: str = "cn-hangzhou",
    **kwargs,
) -> str:
    """启动 ECS 实例。

    仅对已停止的实例有效。

    Args:
        instance_id: 实例 ID
        region_id: 区域 ID，默认 cn-hangzhou
        **kwargs: 框架注入的参数

    Returns:
        操作结果的 JSON 字符串
    """
    credential = kwargs.get("credential") or get_credential()
    client = _build_ecs_client(credential, region_id)

    try:
        req = ecs_models.StartInstanceRequest(instance_id=instance_id)
        await asyncio.to_thread(client.start_instance, req)
        
        return json.dumps({
            "success": True,
            "instance_id": instance_id,
            "action": "start",
            "message": f"实例 {instance_id} 启动命令已发送",
        }, ensure_ascii=False)

    except Exception as e:
        return json.dumps({
            "success": False,
            "instance_id": instance_id,
            "action": "start",
            "error": str(e),
        }, ensure_ascii=False)


async def ops_ecs_stop_instance(
    instance_id: str,
    region_id: str = "cn-hangzhou",
    force_stop: bool = False,
    **kwargs,
) -> str:
    """停止 ECS 实例。

    Args:
        instance_id: 实例 ID
        region_id: 区域 ID，默认 cn-hangzhou
        force_stop: 是否强制停止（类似断电），默认 False
        **kwargs: 框架注入的参数

    Returns:
        操作结果的 JSON 字符串
    """
    credential = kwargs.get("credential") or get_credential()
    client = _build_ecs_client(credential, region_id)

    try:
        req = ecs_models.StopInstanceRequest(
            instance_id=instance_id,
            force_stop=force_stop,
        )
        await asyncio.to_thread(client.stop_instance, req)
        
        return json.dumps({
            "success": True,
            "instance_id": instance_id,
            "action": "stop",
            "force_stop": force_stop,
            "message": f"实例 {instance_id} 停止命令已发送",
        }, ensure_ascii=False)

    except Exception as e:
        return json.dumps({
            "success": False,
            "instance_id": instance_id,
            "action": "stop",
            "error": str(e),
        }, ensure_ascii=False)


async def ops_ecs_restart_instance(
    instance_id: str,
    region_id: str = "cn-hangzhou",
    force_stop: bool = False,
    **kwargs,
) -> str:
    """重启 ECS 实例。

    Args:
        instance_id: 实例 ID
        region_id: 区域 ID，默认 cn-hangzhou
        force_stop: 是否强制停止后重启，默认 False
        **kwargs: 框架注入的参数

    Returns:
        操作结果的 JSON 字符串
    """
    credential = kwargs.get("credential") or get_credential()
    client = _build_ecs_client(credential, region_id)

    try:
        req = ecs_models.RebootInstanceRequest(
            instance_id=instance_id,
            force_stop=force_stop,
        )
        await asyncio.to_thread(client.reboot_instance, req)
        
        return json.dumps({
            "success": True,
            "instance_id": instance_id,
            "action": "restart",
            "force_stop": force_stop,
            "message": f"实例 {instance_id} 重启命令已发送",
        }, ensure_ascii=False)

    except Exception as e:
        return json.dumps({
            "success": False,
            "instance_id": instance_id,
            "action": "restart",
            "error": str(e),
        }, ensure_ascii=False)


# =============================================================================
# ECS 创建类操作 (CREATE) - 高风险
# =============================================================================


async def ops_ecs_create_instance(
    region_id: str = "cn-hangzhou",
    zone_id: Optional[str] = None,
    image_id: str = "aliyun_3_x64_20G_alibase_20250117.vhd",
    instance_type: str = "ecs.t5-lc1m2.small",
    instance_name: Optional[str] = None,
    description: Optional[str] = None,
    security_group_id: Optional[str] = None,
    vswitch_id: Optional[str] = None,
    instance_charge_type: str = "PostPaid",
    spot_strategy: str = "NoSpot",
    internet_charge_type: str = "PayByTraffic",
    internet_max_bandwidth_out: int = 0,
    system_disk_category: str = "cloud_efficiency",
    system_disk_size: int = 20,
    key_pair_name: Optional[str] = None,
    password: Optional[str] = None,
    amount: int = 1,
    dry_run: bool = False,
    **kwargs,
) -> str:
    """创建 ECS 实例。

    此操作会产生费用，需要审批。支持按量付费和抢占式实例。

    Args:
        region_id: 区域 ID，默认 cn-hangzhou
        zone_id: 可用区 ID，可选
        image_id: 镜像 ID，默认 Alibaba Cloud Linux 3
        instance_type: 实例规格，默认 ecs.t5-lc1m2.small (1核2G)
        instance_name: 实例名称，可选
        description: 实例描述，可选
        security_group_id: 安全组 ID，可选（建议指定）
        vswitch_id: 交换机 ID（VPC网络必需），可选
        instance_charge_type: 计费方式，PostPaid(按量付费)/PrePaid(包年包月)
        spot_strategy: 抢占策略，NoSpot/SpotWithPriceLimit/SpotAsPriceGo
        internet_charge_type: 公网计费方式，PayByTraffic/PayByBandwidth
        internet_max_bandwidth_out: 公网出带宽(Mbps)，默认 0
        system_disk_category: 系统盘类型，cloud_efficiency/ssd/cloud_essd
        system_disk_size: 系统盘大小(GB)，默认 20
        key_pair_name: 密钥对名称，可选
        password: 实例密码，可选
        amount: 创建数量，默认 1
        dry_run: 干运行模式，只验证参数不创建
        **kwargs: 框架注入的参数

    Returns:
        操作结果的 JSON 字符串
    """
    credential = kwargs.get("credential") or get_credential()
    client = _build_ecs_client(credential, region_id)

    try:
        # 构建系统盘配置
        system_disk = ecs_models.RunInstancesRequestSystemDisk(
            category=system_disk_category,
            size=system_disk_size,
        )

        req = ecs_models.RunInstancesRequest(
            region_id=region_id,
            image_id=image_id,
            instance_type=instance_type,
            instance_charge_type=instance_charge_type,
            spot_strategy=spot_strategy,
            internet_charge_type=internet_charge_type,
            internet_max_bandwidth_out=internet_max_bandwidth_out,
            system_disk=system_disk,
            amount=amount,
            dry_run=dry_run,
        )

        if zone_id:
            req.zone_id = zone_id
        if instance_name:
            req.instance_name = instance_name
        if description:
            req.description = description
        if security_group_id:
            req.security_group_id = security_group_id
        if vswitch_id:
            req.v_switch_id = vswitch_id
        if key_pair_name:
            req.key_pair_name = key_pair_name
        if password:
            req.password = password

        resp = await asyncio.to_thread(client.run_instances, req)
        result = resp.body

        if dry_run:
            return json.dumps({
                "success": True,
                "dry_run": True,
                "message": "参数验证通过",
                "region_id": region_id,
            }, ensure_ascii=False)

        instance_ids = result.instance_id_sets.instance_id_set if result.instance_id_sets else []
        return json.dumps({
            "success": True,
            "instance_ids": instance_ids,
            "count": len(instance_ids),
            "region_id": region_id,
            "message": f"成功创建 {len(instance_ids)} 个 ECS 实例",
            "warning": "请妥善保存实例信息",
        }, ensure_ascii=False, indent=2)

    except Exception as e:
        return json.dumps({
            "success": False,
            "error": str(e),
        }, ensure_ascii=False)


# =============================================================================
# ECS 删除类操作 (DELETE) - 高风险
# =============================================================================


async def ops_ecs_release_instance(
    instance_id: str,
    region_id: str = "cn-hangzhou",
    **kwargs,
) -> str:
    """释放 ECS 实例。

    仅限按量付费实例，包年包月实例无法通过此接口释放。
    此操作不可恢复，需要审批。

    Args:
        instance_id: 实例 ID
        region_id: 区域 ID，默认 cn-hangzhou
        **kwargs: 框架注入的参数

    Returns:
        操作结果的 JSON 字符串
    """
    credential = kwargs.get("credential") or get_credential()
    client = _build_ecs_client(credential, region_id)

    try:
        req = ecs_models.DeleteInstanceRequest(instance_id=instance_id)
        await asyncio.to_thread(client.delete_instance, req)
        
        return json.dumps({
            "success": True,
            "instance_id": instance_id,
            "action": "release",
            "message": f"实例 {instance_id} 已释放",
            "warning": "此操作不可恢复",
        }, ensure_ascii=False)

    except Exception as e:
        return json.dumps({
            "success": False,
            "instance_id": instance_id,
            "action": "release",
            "error": str(e),
        }, ensure_ascii=False)


# =============================================================================
# ECS 批量操作
# =============================================================================


async def ops_ecs_batch_start_instances(
    instance_ids: list[str],
    region_id: str = "cn-hangzhou",
    **kwargs,
) -> str:
    """批量启动 ECS 实例。

    Args:
        instance_ids: 实例 ID 列表
        region_id: 区域 ID，默认 cn-hangzhou
        **kwargs: 框架注入的参数

    Returns:
        操作结果的 JSON 字符串
    """
    credential = kwargs.get("credential") or get_credential()
    client = _build_ecs_client(credential, region_id)

    results = []
    for instance_id in instance_ids:
        try:
            req = ecs_models.StartInstanceRequest(instance_id=instance_id)
            await asyncio.to_thread(client.start_instance, req)
            results.append({
                "instance_id": instance_id,
                "success": True,
            })
        except Exception as e:
            results.append({
                "instance_id": instance_id,
                "success": False,
                "error": str(e),
            })

    success_count = sum(1 for r in results if r["success"])
    return json.dumps({
        "total": len(instance_ids),
        "success": success_count,
        "failed": len(instance_ids) - success_count,
        "results": results,
    }, ensure_ascii=False, indent=2)


# =============================================================================
# RDS 操作（P0: 基础生命周期管理）
# =============================================================================


async def ops_rds_list_instances(
    region_id: str = "cn-hangzhou",
    page_number: int = 1,
    page_size: int = 30,
    **kwargs,
) -> str:
    """查询 RDS 实例列表。

    Args:
        region_id: 区域 ID，默认 cn-hangzhou
        page_number: 页码，默认 1
        page_size: 每页数量，默认 30
        **kwargs: 框架注入的参数

    Returns:
        RDS 实例列表的 JSON 字符串
    """
    credential = kwargs.get("credential") or get_credential()
    client = _build_rds_client(credential, region_id)

    try:
        req = rds_models.DescribeDBInstancesRequest(
            region_id=region_id,
            page_number=page_number,
            page_size=page_size,
        )
        resp = await asyncio.to_thread(client.describe_dbinstances, req)
        body = resp.body
        
        items = body.items
        instances = items.dbinstance if items and hasattr(items, "dbinstance") and items.dbinstance else []
        
        simplified = []
        for inst in instances:
            simplified.append({
                "instance_id": inst.dbinstance_id,
                "instance_name": inst.dbinstance_description,
                "engine": inst.engine,
                "engine_version": inst.engine_version,
                "db_instance_class": inst.dbinstance_class,
                "db_instance_storage": inst.db_instance_storage,
                "status": inst.dbinstance_status,
                "charge_type": inst.pay_type,
                "creation_time": inst.creation_time,
                "expired_time": inst.expiredtime,
            })
        
        return json.dumps({
            "total": body.total_record_count or 0,
            "page": page_number,
            "page_size": page_size,
            "instances": simplified,
        }, ensure_ascii=False, indent=2)
    
    except Exception as e:
        return json.dumps({
            "success": False,
            "error": str(e),
        }, ensure_ascii=False)


async def ops_rds_start_instance(
    instance_id: str,
    region_id: str = "cn-hangzhou",
    **kwargs,
) -> str:
    """启动 RDS 实例。

    Args:
        instance_id: 实例 ID
        region_id: 区域 ID，默认 cn-hangzhou
        **kwargs: 框架注入的参数

    Returns:
        操作结果的 JSON 字符串
    """
    credential = kwargs.get("credential") or get_credential()
    client = _build_rds_client(credential, region_id)

    try:
        req = rds_models.StartDBInstanceRequest(dbinstance_id=instance_id)
        await asyncio.to_thread(client.start_dbinstance, req)
        
        return json.dumps({
            "success": True,
            "instance_id": instance_id,
            "action": "start",
            "message": f"RDS 实例 {instance_id} 启动命令已发送",
        }, ensure_ascii=False)
    
    except Exception as e:
        return json.dumps({
            "success": False,
            "instance_id": instance_id,
            "action": "start",
            "error": str(e),
        }, ensure_ascii=False)


async def ops_rds_stop_instance(
    instance_id: str,
    region_id: str = "cn-hangzhou",
    **kwargs,
) -> str:
    """停止 RDS 实例。

    Args:
        instance_id: 实例 ID
        region_id: 区域 ID，默认 cn-hangzhou
        **kwargs: 框架注入的参数

    Returns:
        操作结果的 JSON 字符串
    """
    credential = kwargs.get("credential") or get_credential()
    client = _build_rds_client(credential, region_id)

    try:
        req = rds_models.StopDBInstanceRequest(dbinstance_id=instance_id)
        await asyncio.to_thread(client.stop_dbinstance, req)
        
        return json.dumps({
            "success": True,
            "instance_id": instance_id,
            "action": "stop",
            "message": f"RDS 实例 {instance_id} 停止命令已发送",
        }, ensure_ascii=False)
    
    except Exception as e:
        return json.dumps({
            "success": False,
            "instance_id": instance_id,
            "action": "stop",
            "error": str(e),
        }, ensure_ascii=False)


async def ops_rds_restart_instance(
    instance_id: str,
    region_id: str = "cn-hangzhou",
    force_restart: bool = False,
    **kwargs,
) -> str:
    """重启 RDS 实例。

    Args:
        instance_id: 实例 ID
        region_id: 区域 ID，默认 cn-hangzhou
        force_restart: 是否强制重启，默认 False
        **kwargs: 框架注入的参数

    Returns:
        操作结果的 JSON 字符串
    """
    credential = kwargs.get("credential") or get_credential()
    client = _build_rds_client(credential, region_id)

    try:
        req = rds_models.RestartDBInstanceRequest(
            dbinstance_id=instance_id,
            force_restart=force_restart,
        )
        await asyncio.to_thread(client.restart_dbinstance, req)
        
        return json.dumps({
            "success": True,
            "instance_id": instance_id,
            "action": "restart",
            "message": f"RDS 实例 {instance_id} 重启命令已发送",
        }, ensure_ascii=False)
    
    except Exception as e:
        return json.dumps({
            "success": False,
            "instance_id": instance_id,
            "action": "restart",
            "error": str(e),
        }, ensure_ascii=False)


async def ops_rds_release_instance(
    instance_id: str,
    region_id: str = "cn-hangzhou",
    **kwargs,
) -> str:
    """释放 RDS 实例。

    仅限按量付费实例，包年包月实例无法通过此接口释放。
    此操作不可恢复，需要审批。

    Args:
        instance_id: 实例 ID
        region_id: 区域 ID，默认 cn-hangzhou
        **kwargs: 框架注入的参数

    Returns:
        操作结果的 JSON 字符串
    """
    credential = kwargs.get("credential") or get_credential()
    client = _build_rds_client(credential, region_id)

    try:
        # 先检查实例状态
        desc_req = rds_models.DescribeDBInstanceAttributeRequest(dbinstance_id=instance_id)
        desc_resp = await asyncio.to_thread(client.describe_dbinstance_attribute, desc_req)
        inst = desc_resp.body.items.dbinstance[0]
        
        if inst.pay_type == "Prepaid":
            return json.dumps({
                "success": False,
                "instance_id": instance_id,
                "error": "包年包月实例不支持直接释放，请先转为按量付费或等待到期",
            }, ensure_ascii=False)
        
        # 释放实例
        release_req = rds_models.DeleteDBInstanceRequest(dbinstance_id=instance_id)
        await asyncio.to_thread(client.delete_dbinstance, release_req)
        
        return json.dumps({
            "success": True,
            "instance_id": instance_id,
            "action": "release",
            "message": f"RDS 实例 {instance_id} 已释放",
            "warning": "此操作不可恢复",
        }, ensure_ascii=False)
    
    except Exception as e:
        return json.dumps({
            "success": False,
            "instance_id": instance_id,
            "action": "release",
            "error": str(e),
        }, ensure_ascii=False)


# =============================================================================
# optimizer 联动工具（P0: 核心联动）
# =============================================================================

from action_store import (
    get_action_store,
    extract_actions_from_results,
    ActionStatus,
    EXECUTABLE_STRATEGIES,
    SUPPORTED_PRODUCTS,
)


async def ops_import_optimizer_actions(
    optimizer_results_json: str,
    region_id: str = "cn-hangzhou",
    analysis_id: str = "",
    supported_products: Optional[list[str]] = None,
    replace_pending: bool = False,
    **kwargs,
) -> str:
    """从 optimizer 的分析结果中提取并导入可执行动作。

    调用场景：当 optimizer 完成分析后，调用此函数将建议保存到 Action Store，
    供后续通过 resource-ops 执行。

    Args:
        optimizer_results_json: optimizer 输出的优化结果 JSON 字符串（OptimizeResult.to_dict() 格式）
        region_id: 区域 ID
        analysis_id: 分析任务 ID（用于追踪来源）
        supported_products: 支持的产品列表，默认 ["ECS", "RDS"]
        replace_pending: 是否替换现有的 pending 动作（同一资源）
        **kwargs: 框架注入的参数

    Returns:
        导入结果统计
    """
    try:
        # 解析 optimizer 结果
        results = json.loads(optimizer_results_json)
        if isinstance(results, dict):
            # 可能是单个结果或包含 results 键的字典
            if "results" in results:
                results = results["results"]
            elif "recommendations" in results:
                results = results["recommendations"]
            else:
                results = [results]
        
        if not isinstance(results, list):
            return json.dumps({
                "success": False,
                "error": "optimizer_results_json 必须是 JSON 数组或包含 results/recommendations 键的对象",
            }, ensure_ascii=False)
        
        # 使用默认支持的产品
        if supported_products is None:
            supported_products = ["ECS", "RDS"]
        
        # 提取动作
        actions = extract_actions_from_results(
            results=results,
            region_id=region_id,
            analysis_id=analysis_id or f"import_{__import__('datetime').datetime.now().strftime('%Y%m%d%H%M%S')}",
            supported_products=set(supported_products),
        )
        
        if not actions:
            return json.dumps({
                "success": True,
                "added": 0,
                "message": "没有可执行的动作（可能都是不可执行的策略或不支持的产品）",
            }, ensure_ascii=False)
        
        # 保存到 Action Store
        store = get_action_store()
        stats = store.save_actions(actions, analysis_id=analysis_id, replace_pending=replace_pending)
        
        return json.dumps({
            "success": True,
            "added": stats["added"],
            "updated": stats["updated"],
            "skipped": stats["skipped"],
            "total_in_store": stats["total"],
            "message": f"成功导入 {stats['added']} 条优化动作到 Action Store",
            "note": "可通过 ops_list_pending_actions 查询待执行动作",
        }, ensure_ascii=False)
    
    except Exception as e:
        logger.error("导入 optimizer 动作失败：%s", e)
        return json.dumps({
            "success": False,
            "error": str(e),
        }, ensure_ascii=False)


async def ops_list_pending_actions(
    product: str = "",
    strategy: str = "",
    region_id: str = "",
    min_saving: float = 0,
    limit: int = 50,
    **kwargs,
) -> str:
    """列出待执行的优化动作。

    这些动作来自 optimizer 的分析建议，可以通过 ops_execute_action 执行。

    Args:
        product: 过滤产品类型（ECS / RDS）
        strategy: 过滤策略类型（Release / DownScaling）
        region_id: 过滤区域
        min_saving: 最小节省金额（元）
        limit: 返回数量限制
        **kwargs: 框架注入的参数

    Returns:
        待执行动作列表
    """
    try:
        store = get_action_store()
        actions = store.list_pending(
            product=product,
            strategy=strategy,
            region_id=region_id,
            min_saving=min_saving,
            limit=limit,
        )
        
        # 转换为字典列表
        actions_data = [action.to_dict() for action in actions]
        
        # 统计信息
        total_saving = sum(a.get("cost_saving", 0) for a in actions_data)
        
        return json.dumps({
            "success": True,
            "count": len(actions_data),
            "total_potential_monthly_saving": round(total_saving, 2),
            "filters": {
                "product": product or "全部",
                "strategy": strategy or "全部",
                "region_id": region_id or "全部",
                "min_saving": min_saving,
            },
            "actions": actions_data,
        }, ensure_ascii=False, indent=2)
    
    except Exception as e:
        return json.dumps({
            "success": False,
            "error": str(e),
        }, ensure_ascii=False)


async def ops_execute_action(
    action_id: str,
    confirm: bool = False,
    dry_run: bool = True,
    **kwargs,
) -> str:
    """执行指定的优化动作。

    根据动作的策略（Release/DownScaling）调用对应的 resource-ops 函数执行。

    Args:
        action_id: 动作 ID
        confirm: 是否确认执行（必需为 True）
        dry_run: 是否干运行（只验证不执行）
        **kwargs: 框架注入的参数

    Returns:
        执行结果
    """
    try:
        store = get_action_store()
        action = store.get_action(action_id)
        
        if not action:
            return json.dumps({
                "success": False,
                "error": f"动作不存在：{action_id}",
            }, ensure_ascii=False)
        
        if action.status != ActionStatus.PENDING.value:
            return json.dumps({
                "success": False,
                "error": f"动作状态不是 pending：{action.status}",
            }, ensure_ascii=False)
        
        if not confirm:
            return json.dumps({
                "success": False,
                "require_confirm": True,
                "action": action.to_dict(),
                "message": "请确认是否执行此优化动作（设置 confirm=True）",
            }, ensure_ascii=False)
        
        if dry_run:
            return json.dumps({
                "success": True,
                "dry_run": True,
                "action": action.to_dict(),
                "message": "干运行模式：参数验证通过，未实际执行",
            }, ensure_ascii=False)
        
        # 根据策略和产品类型执行对应的操作
        result = None
        credential = kwargs.get("credential") or get_credential()
        
        if action.strategy == "Release":
            # 释放资源
            if action.product == "ECS":
                release_result = await ops_ecs_release_instance(
                    instance_id=action.resource_id,
                    region_id=action.region_id,
                    credential=credential,
                )
                result = json.loads(release_result)
            elif action.product == "RDS":
                release_result = await ops_rds_release_instance(
                    instance_id=action.resource_id,
                    region_id=action.region_id,
                    credential=credential,
                )
                result = json.loads(release_result)
            else:
                return json.dumps({
                    "success": False,
                    "error": f"不支持的产品类型：{action.product}",
                }, ensure_ascii=False)
        
        elif action.strategy == "DownScaling":
            # 降配（目前仅支持 ECS）
            if action.product == "ECS":
                # ECS 降配需要调用 ModifyInstanceSpec API
                return json.dumps({
                    "success": False,
                    "error": "ECS 降配功能需要手动操作，请在阿里云控制台执行",
                    "action": action.to_dict(),
                    "manual_guide": f"实例 {action.resource_id} 建议从 {action.current_spec} 降配到 {action.target_spec}",
                }, ensure_ascii=False)
            else:
                return json.dumps({
                    "success": False,
                    "error": f"不支持的降配产品：{action.product}",
                }, ensure_ascii=False)
        
        else:
            return json.dumps({
                "success": False,
                "error": f"不支持的策略：{action.strategy}",
            }, ensure_ascii=False)
        
        # 标记为已执行
        store.mark_executed(action_id, result=result)
        
        return json.dumps({
            "success": True,
            "action_id": action_id,
            "executed": True,
            "result": result,
            "message": f"优化动作已执行：{action.strategy} {action.resource_id}",
        }, ensure_ascii=False)
    
    except Exception as e:
        logger.error("执行优化动作失败：%s", e)
        return json.dumps({
            "success": False,
            "error": str(e),
        }, ensure_ascii=False)


async def ops_skip_action(
    action_id: str,
    reason: str = "",
    **kwargs,
) -> str:
    """标记优化动作为已跳过（用户主动忽略）。

    Args:
        action_id: 动作 ID
        reason: 跳过原因（可选）
        **kwargs: 框架注入的参数

    Returns:
        操作结果
    """
    try:
        store = get_action_store()
        success = store.mark_skipped(action_id, reason=reason)
        
        if success:
            return json.dumps({
                "success": True,
                "action_id": action_id,
                "status": "skipped",
                "reason": reason,
                "message": f"动作已标记为跳过：{action_id}",
            }, ensure_ascii=False)
        else:
            return json.dumps({
                "success": False,
                "error": f"动作不存在：{action_id}",
            }, ensure_ascii=False)
    
    except Exception as e:
        return json.dumps({
            "success": False,
            "error": str(e),
        }, ensure_ascii=False)


async def ops_get_action_stats(
    **kwargs,
) -> str:
    """获取 Action Store 的统计信息。

    Returns:
        统计信息 JSON
    """
    try:
        store = get_action_store()
        stats = store.get_stats()
        
        return json.dumps({
            "success": True,
            "stats": stats,
        }, ensure_ascii=False, indent=2)
    
    except Exception as e:
        return json.dumps({
            "success": False,
            "error": str(e),
        }, ensure_ascii=False)

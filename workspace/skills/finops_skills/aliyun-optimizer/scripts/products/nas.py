# -*- coding: utf-8 -*-
"""NAS 文件存储产品配置。

配置项：
- ProductCode: nas
- 规则链: 生命周期管理检测
- 数据源: NAS API

核心 API：
- DescribeFileSystems: 列举文件系统
- DescribeLifecyclePolicies: 查询生命周期策略

检测规则：
- 通用型 NAS 需开启生命周期管理（自动转储冷数据到低频介质）
- 低频存储单价比通用存储低约 92%
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Optional

from alibabacloud_tea_openapi.models import Config
from alibabacloud_nas20170626.client import Client as NasClient
from alibabacloud_nas20170626 import models as nas_models

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
class LifecyclePolicy:
    """生命周期策略。"""
    name: str
    path: str
    rule: str


@dataclass
class NasFileSystemInfo:
    """NAS 文件系统信息。"""
    fs_id: str
    fs_type: str  # standard / extreme / cpfs
    protocol: str  # NFS / SMB
    storage_type: str  # Capacity / Performance
    status: str
    capacity_gb: int
    used_gb: float
    region_id: str
    # 检测结果
    is_general_purpose: bool = False
    lifecycle_enabled: bool = False
    lifecycle_policies: list[LifecyclePolicy] = field(default_factory=list)
    has_issue: bool = False


def check_lifecycle_management(fs_info: NasFileSystemInfo) -> bool:
    """检测是否需要开启生命周期管理。
    
    规则：通用型 NAS (standard) 未开启生命周期管理时，返回 True
    
    Args:
        fs_info: 文件系统信息
    
    Returns:
        是否存在问题（需要开启生命周期管理）
    """
    # 只检测通用型 NAS
    if not fs_info.is_general_purpose:
        return False
    
    return not fs_info.lifecycle_enabled


def generate_report_lines(
    analyzed_fs: list[NasFileSystemInfo],
    region_id: str,
) -> list[str]:
    """生成 Markdown 报告行。"""
    lines = []
    lines.append("# NAS 成本优化报告")
    lines.append("")
    lines.append(f"> 生成时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    lines.append(f"> 分析区域: {region_id}")
    lines.append("")
    
    # 统计
    general_fs = [f for f in analyzed_fs if f.is_general_purpose]
    issue_fs = [f for f in analyzed_fs if f.has_issue]
    
    # 概览
    lines.append("## 概览")
    lines.append("")
    lines.append("| 检测项 | 数量 | 状态 |")
    lines.append("|--------|-----:|------|")
    lines.append(f"| NAS 文件系统总数 | {len(analyzed_fs)} | - |")
    lines.append(f"| 通用型 NAS | {len(general_fs)} | - |")
    lines.append(f"| 未开启生命周期管理 | {len(issue_fs)} | {'🟡 可优化' if issue_fs else '✅ 正常'} |")
    lines.append("")
    
    # 优化建议
    if issue_fs:
        lines.append("## 优化建议 - 开启生命周期管理")
        lines.append("")
        lines.append("| 文件系统 ID | 类型 | 存储类型 | 已用容量 | 建议 |")
        lines.append("|-------------|------|----------|----------|------|")
        for fs in issue_fs:
            lines.append(
                f"| `{fs.fs_id}` | {fs.fs_type} | "
                f"{fs.storage_type} | {fs.used_gb} GB | 开启生命周期管理 |"
            )
        lines.append("")
        lines.append("> **建议**: 开启生命周期管理后，不常访问的数据会自动转储到低频存储介质，")
        lines.append("> 低频存储单价比通用存储低约 92%，可显著降低存储成本。")
    else:
        lines.append("## 分析结论")
        lines.append("")
        if not general_fs:
            lines.append("> 当前区域无通用型 NAS 文件系统，无需配置生命周期管理。")
        else:
            lines.append("> 所有通用型 NAS 均已开启生命周期管理，配置良好。")
    
    lines.append("")
    lines.append("---")
    lines.append("")
    lines.append("检测规则说明：")
    lines.append("- **生命周期管理**: 通用型 NAS 应开启生命周期管理功能")
    lines.append("- **低频存储**: 自动将不常访问的数据转储，降低 92% 存储成本")
    
    return lines


# =============================================================================
# 框架集成：列举实例函数
# =============================================================================

async def list_nas_instances(
    ak: str,
    sk: str,
    region_id: str,
) -> list[ResourceInstance]:
    """列举 NAS 文件系统实例。
    
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
        endpoint=f"nas.{region_id}.aliyuncs.com",
        region_id=region_id,
    )
    client = NasClient(config)
    
    instances: list[ResourceInstance] = []
    page = 1
    
    while True:
        req = nas_models.DescribeFileSystemsRequest(
            page_number=page,
            page_size=50,
        )
        try:
            resp = await asyncio.to_thread(client.describe_file_systems, req)
            body = resp.body
            
            if body.file_systems and body.file_systems.file_system:
                for fs in body.file_systems.file_system:
                    instances.append(ResourceInstance(
                        resource_id=fs.file_system_id or "",
                        resource_name=fs.description or "",
                        region_id=region_id,
                        zone_id=fs.zone_id or "",
                        instance_type=f"{fs.file_system_type}-{fs.storage_type}" if fs.file_system_type else "",
                        charge_type=ChargeType.POST_PAID,  # NAS 默认按量
                        creation_time=fs.create_time or "",
                        status=fs.status or "",
                        raw={
                            "fs_type": fs.file_system_type,
                            "storage_type": fs.storage_type,
                            "protocol": fs.protocol_type,
                            "capacity": fs.capacity,
                            "metered_size": fs.metered_size,
                        },
                    ))
            
            total = body.total_count or 0
            if len(instances) >= total:
                break
            page += 1
        except Exception as e:
            logger.warning("DescribeFileSystems failed: %s", e)
            break
    
    return instances


# =============================================================================
# 产品配置注册
# =============================================================================

NAS_CONFIG = ProductConfig(
    product_code="nas",
    product_name="文件存储 NAS",
    rule_chain=[
        RuleConfig(
            rule_id="IdleResourceCheck",
            enabled=False,  # NAS 不检测闲置
            strategy=OptimizeStrategy.RELEASE,
        ),
    ],
    idle_check_method=IdleCheckMethod.STATUS,
    idle_days=14,
    pricing_module_code="nas",
    pricing_config_template="StorageType:{spec},Region:{region}",
    list_instances_fn=list_nas_instances,
)

# 注册产品配置
register_product(NAS_CONFIG)

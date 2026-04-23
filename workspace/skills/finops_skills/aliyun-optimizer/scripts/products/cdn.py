# -*- coding: utf-8 -*-
"""CDN 内容分发网络产品配置。

配置项：
- ProductCode: cdn
- 规则链: 配置优化检测（非闲置/利用率模式）
- 检测项: 计费方式 / RANGE功能 / 智能压缩 / 缓存规则 / 共享缓存
- 数据源: CDN 20180510 API

核心 API：
- DescribeUserDomains: 列举用户 CDN 域名
- DescribeCdnDomainConfigs: 查询域名配置（range/gzip/cache）
- DescribeCdnDomainDetail: 查询域名详情（源站信息）
- DescribeDomainBpsData: 查询带宽数据（计算利用率）
- DescribeDomainSrcBpsData: 查询回源带宽数据
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from alibabacloud_tea_openapi.models import Config
from alibabacloud_cdn20180510.client import Client as CdnClient
from alibabacloud_cdn20180510 import models as cdn_models

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
class CdnDomainInfo:
    """CDN 域名信息。"""
    domain_name: str
    domain_status: str
    cname: str
    source_type: str  # oss / ipaddr / domain
    source_content: str  # 源站地址
    cdn_type: str  # web / download / video
    # 配置检测结果
    range_enabled: bool = False
    gzip_enabled: bool = False
    cache_configured: bool = False
    cache_rules: list[dict] = None
    # 带宽数据
    peak_bps: float = 0.0
    avg_bps: float = 0.0
    utilization_percent: float = 0.0
    # 优化建议
    issues: list[dict] = None
    
    def __post_init__(self):
        if self.cache_rules is None:
            self.cache_rules = []
        if self.issues is None:
            self.issues = []


def build_cdn_client(ak: str, sk: str) -> CdnClient:
    """构建 CDN 客户端。"""
    config = Config(
        access_key_id=ak,
        access_key_secret=sk,
        endpoint="cdn.aliyuncs.com",
    )
    return CdnClient(config)


async def list_cdn_domains(
    ak: str,
    sk: str,
    domain_status: str = "",
) -> list[CdnDomainInfo]:
    """列举 CDN 域名。
    
    Args:
        ak: AccessKey ID
        sk: AccessKey Secret
        domain_status: 状态筛选（online / offline / configuring）
    
    Returns:
        CDN 域名信息列表
    """
    client = build_cdn_client(ak, sk)
    domains: list[CdnDomainInfo] = []
    page = 1
    
    while True:
        req = cdn_models.DescribeUserDomainsRequest(
            page_size=100,
            page_number=page,
            domain_status=domain_status if domain_status else None,
        )
        try:
            resp = await asyncio.to_thread(client.describe_user_domains, req)
            page_data = resp.body.domains.page_data if resp.body.domains else []
            
            for d in page_data:
                # 解析源站信息
                source_type = ""
                source_content = ""
                if d.sources and d.sources.source:
                    src = d.sources.source[0]
                    source_type = src.type or ""
                    source_content = src.content or ""
                
                domains.append(CdnDomainInfo(
                    domain_name=d.domain_name or "",
                    domain_status=d.domain_status or "",
                    cname=d.cname or "",
                    source_type=source_type,
                    source_content=source_content,
                    cdn_type=d.cdn_type or "",
                ))
            
            total = resp.body.total_count or 0
            if len(domains) >= total:
                break
            page += 1
        except Exception as e:
            logger.warning("DescribeUserDomains failed: %s", e)
            break
    
    return domains


async def get_domain_configs(
    ak: str,
    sk: str,
    domain_name: str,
) -> dict[str, Any]:
    """查询域名配置（range/gzip/cache）。
    
    Args:
        ak: AccessKey ID
        sk: AccessKey Secret
        domain_name: 域名
    
    Returns:
        配置字典 {range_enabled, gzip_enabled, cache_rules}
    """
    client = build_cdn_client(ak, sk)
    
    # 查询这些功能配置
    function_names = [
        "range",                   # Range 回源
        "gzip",                    # 智能压缩 (Gzip/Brotli)
        "brotli",                  # Brotli 压缩
        "filetype_based_ttl_set",  # 文件类型缓存规则
        "path_based_ttl_set",      # 目录缓存规则
    ]
    
    req = cdn_models.DescribeCdnDomainConfigsRequest(
        domain_name=domain_name,
        function_names=",".join(function_names),
    )
    
    result = {
        "range_enabled": False,
        "gzip_enabled": False,
        "brotli_enabled": False,
        "cache_configured": False,
        "cache_rules": [],
    }
    
    try:
        resp = await asyncio.to_thread(client.describe_cdn_domain_configs, req)
        configs = resp.body.domain_configs.domain_config if resp.body.domain_configs else []
        
        for cfg in configs:
            fn = cfg.function_name or ""
            args = {}
            if cfg.function_args and cfg.function_args.function_arg:
                args = {a.arg_name: a.arg_value for a in cfg.function_args.function_arg}
            
            if fn == "range":
                result["range_enabled"] = args.get("enable") == "on"
            elif fn == "gzip":
                result["gzip_enabled"] = args.get("enable") == "on"
            elif fn == "brotli":
                result["brotli_enabled"] = args.get("enable") == "on"
            elif fn in ("filetype_based_ttl_set", "path_based_ttl_set"):
                result["cache_configured"] = True
                result["cache_rules"].append({
                    "type": fn,
                    "ttl": args.get("ttl", ""),
                    "weight": args.get("weight", ""),
                })
    
    except Exception as e:
        logger.warning("DescribeCdnDomainConfigs failed for %s: %s", domain_name, e)
    
    return result


async def get_domain_bandwidth_data(
    ak: str,
    sk: str,
    domain_name: str,
    days: int = 7,
) -> dict[str, float]:
    """查询域名带宽数据（用于计算带宽利用率）。
    
    带宽利用率 = 平均带宽 / 峰值带宽
    - 利用率 < 30%: 推荐按流量计费
    - 利用率 >= 30%: 推荐按带宽峰值计费
    
    Args:
        ak: AccessKey ID
        sk: AccessKey Secret
        domain_name: 域名
        days: 查询天数
    
    Returns:
        {peak_bps, avg_bps, utilization_percent}
    """
    client = build_cdn_client(ak, sk)
    
    now = datetime.now(timezone.utc)
    start_time = now - timedelta(days=days)
    
    req = cdn_models.DescribeDomainBpsDataRequest(
        domain_name=domain_name,
        start_time=start_time.strftime("%Y-%m-%dT%H:%M:%SZ"),
        end_time=now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        interval="3600",  # 1小时粒度
    )
    
    result = {
        "peak_bps": 0.0,
        "avg_bps": 0.0,
        "utilization_percent": 0.0,
        "data_points": 0,
    }
    
    try:
        resp = await asyncio.to_thread(client.describe_domain_bps_data, req)
        data_points = resp.body.bps_data_per_interval.data_module if resp.body.bps_data_per_interval else []
        
        if data_points:
            bps_values = []
            for dp in data_points:
                # value 是字符串，需要转换
                val = dp.value if hasattr(dp, "value") else dp.get("value", 0)
                try:
                    bps_values.append(float(val) if val else 0)
                except (ValueError, TypeError):
                    bps_values.append(0)
            
            if bps_values:
                result["peak_bps"] = max(bps_values)
                result["avg_bps"] = sum(bps_values) / len(bps_values)
                result["data_points"] = len(bps_values)
                
                if result["peak_bps"] > 0:
                    result["utilization_percent"] = (result["avg_bps"] / result["peak_bps"]) * 100
    
    except Exception as e:
        logger.warning("DescribeDomainBpsData failed for %s: %s", domain_name, e)
    
    return result


async def analyze_cdn_domain(
    ak: str,
    sk: str,
    domain_info: CdnDomainInfo,
) -> CdnDomainInfo:
    """分析单个 CDN 域名的配置和利用率。
    
    检测规则：
    1. 计费方式优化: 带宽利用率 < 30% 推荐流量计费
    2. RANGE功能: 大文件加速域名应开启 Range 回源
    3. 智能压缩: 文本类资源域名应开启 Gzip/Brotli
    4. 缓存规则: 必须配置缓存规则
    
    Args:
        ak: AccessKey ID
        sk: AccessKey Secret
        domain_info: 域名基本信息
    
    Returns:
        补充了配置检测结果和优化建议的域名信息
    """
    issues = []
    
    # 1. 查询配置
    configs = await get_domain_configs(ak, sk, domain_info.domain_name)
    domain_info.range_enabled = configs["range_enabled"]
    domain_info.gzip_enabled = configs["gzip_enabled"] or configs.get("brotli_enabled", False)
    domain_info.cache_configured = configs["cache_configured"]
    domain_info.cache_rules = configs["cache_rules"]
    
    # 2. 查询带宽数据
    bw_data = await get_domain_bandwidth_data(ak, sk, domain_info.domain_name)
    domain_info.peak_bps = bw_data["peak_bps"]
    domain_info.avg_bps = bw_data["avg_bps"]
    domain_info.utilization_percent = bw_data["utilization_percent"]
    
    # 3. 检测问题
    
    # 3.1 计费方式优化
    if domain_info.peak_bps > 0:  # 有流量才检测
        if domain_info.utilization_percent < 30:
            issues.append({
                "rule": "BillingOptimization",
                "severity": "medium",
                "issue": f"带宽利用率 {domain_info.utilization_percent:.1f}% < 30%",
                "recommendation": "推荐按流量计费，可降低成本",
                "potential_saving": "视实际用量而定",
            })
        else:
            # 利用率 >= 30%，记录为正常，可能需要确认是按带宽计费
            pass
    
    # 3.2 RANGE功能检测
    # 适用于大文件下载、视频点播等场景
    if domain_info.cdn_type in ("download", "video") or domain_info.source_type == "oss":
        if not domain_info.range_enabled:
            issues.append({
                "rule": "RangeEnable",
                "severity": "high",
                "issue": "Range 回源功能未开启",
                "recommendation": "开启 Range 回源可减少回源流量，降低源站带宽成本",
                "potential_saving": "可减少 30%-50% 回源流量",
            })
    
    # 3.3 智能压缩检测
    # 适用于网页、API 等文本类资源
    if domain_info.cdn_type == "web" or not domain_info.cdn_type:
        if not domain_info.gzip_enabled:
            issues.append({
                "rule": "CompressionEnable",
                "severity": "medium",
                "issue": "智能压缩（Gzip/Brotli）未开启",
                "recommendation": "开启智能压缩可减少传输流量，提升访问速度",
                "potential_saving": "可减少 50%-70% 文本资源流量",
            })
    
    # 3.4 缓存规则检测
    if not domain_info.cache_configured:
        issues.append({
            "rule": "CacheConfig",
            "severity": "high",
            "issue": "未配置缓存规则",
            "recommendation": "必须配置缓存规则，否则 CDN 缓存效果差，回源流量高",
            "potential_saving": "正确配置缓存可减少 80%+ 回源流量",
        })
    
    domain_info.issues = issues
    return domain_info


async def analyze_shared_cache_opportunity(
    domains: list[CdnDomainInfo],
) -> list[dict]:
    """分析共享缓存优化机会。
    
    检测同一源站的多个域名，建议使用共享缓存。
    
    Args:
        domains: 域名列表
    
    Returns:
        共享缓存优化建议列表
    """
    # 按源站分组
    source_groups: dict[str, list[CdnDomainInfo]] = {}
    for d in domains:
        if d.source_content:
            key = d.source_content
            if key not in source_groups:
                source_groups[key] = []
            source_groups[key].append(d)
    
    # 检测可共享缓存的域名组
    suggestions = []
    for source, group in source_groups.items():
        if len(group) >= 2:
            suggestions.append({
                "rule": "SharedCache",
                "severity": "medium",
                "source": source,
                "domain_count": len(group),
                "domains": [d.domain_name for d in group],
                "recommendation": f"源站 {source} 有 {len(group)} 个域名，建议开启共享缓存功能",
                "potential_saving": "可减少重复缓存存储，提升缓存命中率",
            })
    
    return suggestions


def format_bandwidth(bps: float) -> str:
    """格式化带宽显示。"""
    if bps >= 1e9:
        return f"{bps / 1e9:.2f} Gbps"
    elif bps >= 1e6:
        return f"{bps / 1e6:.2f} Mbps"
    elif bps >= 1e3:
        return f"{bps / 1e3:.2f} Kbps"
    else:
        return f"{bps:.0f} bps"


# =============================================================================
# 框架集成：列举实例函数
# =============================================================================

async def list_cdn_instances(
    ak: str,
    sk: str,
    region_id: str,
) -> list[ResourceInstance]:
    """列举 CDN 域名实例。
    
    Args:
        ak: AccessKey ID
        sk: AccessKey Secret
        region_id: 地域 ID（CDN 是全局服务，忽略）
    
    Returns:
        标准化的资源实例列表
    """
    domains = await list_cdn_domains(ak, sk, domain_status="online")
    
    instances: list[ResourceInstance] = []
    for d in domains:
        instances.append(ResourceInstance(
            resource_id=d.domain_name,
            resource_name=d.domain_name,
            region_id="global",
            zone_id="",
            instance_type=d.cdn_type or "web",
            charge_type=ChargeType.POST_PAID,  # CDN 默认按量
            creation_time="",
            status=d.domain_status,
            raw={
                "source_type": d.source_type,
                "source_content": d.source_content,
                "cname": d.cname,
            },
        ))
    
    return instances


# =============================================================================
# 产品配置注册
# =============================================================================

CDN_CONFIG = ProductConfig(
    product_code="cdn",
    product_name="内容分发 CDN",
    rule_chain=[
        RuleConfig(
            rule_id="IdleResourceCheck",
            enabled=False,  # CDN 不检测闲置
            strategy=OptimizeStrategy.RELEASE,
        ),
    ],
    idle_check_method=IdleCheckMethod.STATUS,
    idle_days=14,
    pricing_module_code="cdn",
    pricing_config_template="Region:{region}",
    list_instances_fn=list_cdn_instances,
)

# 注册产品配置
register_product(CDN_CONFIG)

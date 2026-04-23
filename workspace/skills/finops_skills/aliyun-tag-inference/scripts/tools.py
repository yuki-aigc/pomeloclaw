# -*- coding: utf-8 -*-
"""阿里云标签智能推断引擎。

基于启发式规则和拓扑分析推断标签归属：
- 名称模式推断：根据资源名称正则匹配推断 env 标签
- VPC 拓扑推断：根据 VPC 归属关系推断 team 标签
- 创建者推断：根据资源创建者推断 owner 标签
- 批量推断：对给定资源执行所有适用的推断方法
- 推断审核：人工审核推断结果后应用
"""

import asyncio
import json
import logging
import re
import uuid
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from typing import Optional

from pydantic import BaseModel

from alibabacloud_tea_openapi.models import Config
from alibabacloud_resourcecenter20221201.client import Client as ResourceCenterClient
from alibabacloud_resourcecenter20221201 import models as rc_models
from alibabacloud_tag20180828.client import Client as TagClient
from alibabacloud_tag20180828 import models as tag_models
from alibabacloud_vpc20160428.client import Client as VpcClient
from alibabacloud_vpc20160428 import models as vpc_models
import sys
from pathlib import Path
# 添加 _common 目录到 Python 路径
_common_path = Path(__file__).parent.parent.parent / "_common"
if str(_common_path) not in sys.path:
    sys.path.insert(0, str(_common_path))
from credential import get_credential, get_ak_sk



logger = logging.getLogger(__name__)


# =============================================================================
# 常量定义
# =============================================================================

_RC_ENDPOINT = "resourcecenter.aliyuncs.com"
_TAG_ENDPOINT_TPL = "tag.{region}.aliyuncs.com"
_VPC_ENDPOINT_TPL = "vpc.{region}.aliyuncs.com"
_RC_PAGE_SIZE = 500
_TAG_BATCH_SIZE = 50
_RC_SCAN_LIMIT = 20000

_DATA_DIR = Path.home() / ".copaw" / "data"
_INFERENCES_FILE = _DATA_DIR / "tag_inferences.json"

# 名称模式匹配规则
_ENV_PATTERNS = [
    (re.compile(r"(^|[^a-z])(prod|production|prd)([^a-z]|$)", re.IGNORECASE), "prod", 0.9),
    (re.compile(r"(^|[^a-z])(dev|develop|development)([^a-z]|$)", re.IGNORECASE), "dev", 0.85),
    (re.compile(r"(^|[^a-z])(test|testing|qa)([^a-z]|$)", re.IGNORECASE), "test", 0.85),
    (re.compile(r"(^|[^a-z])(staging|stg|pre)([^a-z]|$)", re.IGNORECASE), "staging", 0.8),
]


# =============================================================================
# 数据模型
# =============================================================================


class TagInference(BaseModel):
    """标签推断结果数据模型。"""
    inference_id: str
    resource_arn: str
    resource_name: str = ""
    inferred_tags: dict[str, str]  # {"env": "prod", "team": "sre"}
    confidence: float  # 0.0 - 1.0
    method: str  # 推断方法
    evidence: str  # 推断依据
    status: str = "pending"  # pending | approved | rejected
    created_at: str = ""


# =============================================================================
# 持久化辅助函数
# =============================================================================


def _load_inferences() -> list[dict]:
    """加载所有推断结果。"""
    if not _INFERENCES_FILE.exists():
        return []
    try:
        data = json.loads(_INFERENCES_FILE.read_text(encoding="utf-8"))
        return data.get("inferences", [])
    except Exception as e:
        logger.warning("加载推断文件失败: %s", e)
        return []


def _save_inferences(inferences: list[dict]) -> None:
    """保存推断结果。"""
    _DATA_DIR.mkdir(parents=True, exist_ok=True)
    # 只保留最近 5000 条
    inferences = inferences[-5000:]
    _INFERENCES_FILE.write_text(
        json.dumps({"inferences": inferences}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def _generate_inference_id() -> str:
    """生成推断 ID。"""
    return f"inf-{uuid.uuid4().hex[:12]}"


def _add_inference(inference: dict) -> None:
    """添加新的推断结果。"""
    inferences = _load_inferences()
    # 检查是否已存在相同资源的相同推断
    for existing in inferences:
        if (existing["resource_arn"] == inference["resource_arn"] and
            existing["inferred_tags"] == inference["inferred_tags"] and
            existing["status"] == "pending"):
            # 已存在，更新置信度
            existing["confidence"] = max(existing["confidence"], inference["confidence"])
            existing["evidence"] = inference["evidence"]
            _save_inferences(inferences)
            return
    inferences.append(inference)
    _save_inferences(inferences)


# =============================================================================
# 凭证与客户端辅助函数
# =============================================================================


def _get_ak_sk(credential=None) -> tuple[str, str]:
    """从 credential 或环境变量获取 AK/SK。
    
    优先使用传入的 credential，如果为空则从环境变量获取。
    """
    if credential is None:
        credential = get_credential()
    if hasattr(credential, "access_key_id"):
        return credential.access_key_id, credential.access_key_secret
    return credential["access_key_id"], credential["access_key_secret"]


def _build_rc_client(credential) -> ResourceCenterClient:
    """构建 Resource Center 客户端。"""
    ak, sk = _get_ak_sk(credential)
    config = Config(
        access_key_id=ak,
        access_key_secret=sk,
        endpoint=_RC_ENDPOINT,
        region_id="cn-hangzhou",
    )
    return ResourceCenterClient(config)


def _build_tag_client(credential, region_id: str = "cn-hangzhou") -> TagClient:
    """构建统一 Tag API 客户端。"""
    ak, sk = _get_ak_sk(credential)
    config = Config(
        access_key_id=ak,
        access_key_secret=sk,
        endpoint=_TAG_ENDPOINT_TPL.format(region=region_id),
        region_id=region_id,
    )
    return TagClient(config)


def _build_vpc_client(credential, region_id: str = "cn-hangzhou") -> VpcClient:
    """构建 VPC 客户端。"""
    ak, sk = _get_ak_sk(credential)
    config = Config(
        access_key_id=ak,
        access_key_secret=sk,
        endpoint=_VPC_ENDPOINT_TPL.format(region=region_id),
        region_id=region_id,
    )
    return VpcClient(config)


# =============================================================================
# 资源查询辅助函数
# =============================================================================


async def _search_resources_paged(
    rc_client: ResourceCenterClient,
    resource_type_filter: Optional[list[str]] = None,
    region_ids: Optional[list[str]] = None,
    max_total: int = 500,
) -> tuple[list[dict], bool]:
    """Resource Center 分页查询。

    Args:
        rc_client: ResourceCenter 客户端
        resource_type_filter: 资源类型过滤
        region_ids: 地域过滤
        max_total: 安全上限，默认 10000，防止超大账号无限循环

    Returns:
        tuple[list[dict], bool]: (资源列表, 是否因达到上限被截断)
    """
    all_resources = []
    next_token = None
    truncated = False
    page_count = 0

    while True:
        # 达到安全上限
        if len(all_resources) >= max_total:
            truncated = True
            logger.info(
                "资源扫描达到安全上限 %d，停止分页",
                max_total,
            )
            break

        filters = []
        if resource_type_filter:
            filters.append(rc_models.SearchResourcesRequestFilter(
                key="ResourceType",
                value=resource_type_filter,  # 合并所有类型到一个 value 数组（OR 语义）
                match_type="Equals",
            ))
        if region_ids:
            filters.append(rc_models.SearchResourcesRequestFilter(
                key="RegionId",
                value=region_ids,
                match_type="Equals",
            ))

        # 单次请求最大 100 条
        page_size = min(100, max_total - len(all_resources))
        req = rc_models.SearchResourcesRequest(
            max_results=page_size,
            next_token=next_token,
            filter=filters if filters else None,
        )

        try:
            resp = await asyncio.to_thread(rc_client.search_resources, req)
        except Exception as e:
            error_msg = str(e)
            if "ServiceUnavailable" in error_msg or "NotOpen" in error_msg:
                raise RuntimeError(
                    "资源中心服务未开通。请在阿里云控制台开通 Resource Center 服务后重试。"
                ) from e
            raise

        page_count += 1
        batch_count = 0
        if resp.body and resp.body.resources:
            for r in resp.body.resources:
                tags = {}
                if r.tags:
                    for t in r.tags:
                        if t.key:
                            tags[t.key] = t.value or ""

                all_resources.append({
                    "resource_id": r.resource_id,
                    "resource_type": r.resource_type,
                    "region_id": r.region_id,
                    "resource_name": r.resource_name or "",
                    "resource_arn": getattr(r, "resource_arn", "") or "",
                    "tags": tags,
                    "account_id": r.account_id or "",
                    "zone_id": r.zone_id or "",
                    "create_time": r.create_time or "",
                    "resource_group_id": r.resource_group_id or "",
                })
                batch_count += 1

        # 输出进度日志
        logger.info(
            "资源扫描进度: 第 %d 页，本页 %d 条，累计 %d 条",
            page_count, batch_count, len(all_resources),
        )

        next_token = resp.body.next_token if resp.body else None
        if not next_token:
            break

    return all_resources[:max_total], truncated


def _parse_arn_region(arn: str) -> str:
    """从 ARN 中提取 region。"""
    parts = arn.split(":")
    if len(parts) >= 4:
        return parts[3]
    return "cn-hangzhou"


# =============================================================================
# 推断逻辑
# =============================================================================


def _infer_env_from_name(resource_name: str) -> Optional[tuple[str, float, str]]:
    """根据名称推断 env 标签。返回 (env, confidence, evidence) 或 None。"""
    if not resource_name:
        return None

    for pattern, env, confidence in _ENV_PATTERNS:
        if pattern.search(resource_name):
            return (env, confidence, f"名称 '{resource_name}' 匹配模式: {pattern.pattern}")

    return None


async def _get_vpc_info(
    vpc_client: VpcClient,
    vpc_id: str,
    region_id: str,
) -> Optional[dict]:
    """获取 VPC 详情及标签。"""
    try:
        req = vpc_models.DescribeVpcsRequest(
            region_id=region_id,
            vpc_id=vpc_id,
        )
        resp = await asyncio.to_thread(vpc_client.describe_vpcs, req)
        if resp.body and resp.body.vpcs and resp.body.vpcs.vpc:
            vpc = resp.body.vpcs.vpc[0]
            tags = {}
            if vpc.tags and vpc.tags.tag:
                for t in vpc.tags.tag:
                    if t.key:
                        tags[t.key] = t.value or ""
            return {
                "vpc_id": vpc.vpc_id,
                "vpc_name": vpc.vpc_name or "",
                "tags": tags,
            }
    except Exception as e:
        logger.warning("获取 VPC 信息失败 (vpc_id=%s): %s", vpc_id, e)
    return None


# =============================================================================
# 工具函数 1: 从名称推断 env
# =============================================================================


async def tagi_infer_env_from_name(
    resource_types: list[str] = None,
    regions: list[str] = None,
    max_total: int = 500,
    **kwargs,
) -> str:
    """根据资源名称推断 env 标签。

    使用正则模式矩阵：
    - prod|production|prd → env=prod (0.9)
    - dev|develop|development → env=dev (0.85)
    - test|testing|qa → env=test (0.85)
    - staging|stg|pre → env=staging (0.8)

    Args:
        resource_types: 资源类型过滤
        regions: 地域过滤
        max_total: 安全上限，默认 10000
        **kwargs: 框架注入参数

    Returns:
        JSON 字符串：推断结果列表（含 truncated 标记）
    """
    credential = kwargs.get("credential") or get_credential()

    try:
        rc_client = _build_rc_client(credential)
        resources, scan_truncated = await _search_resources_paged(
            rc_client,
            resource_type_filter=resource_types,
            region_ids=regions,
            max_total=max_total,
        )

        inferences = []
        skipped = 0
        already_tagged = 0

        now = datetime.now().isoformat()
        for resource in resources:
            # 跳过已有 env 标签的资源
            if resource.get("tags", {}).get("env"):
                already_tagged += 1
                continue

            result = _infer_env_from_name(resource["resource_name"])
            if result:
                env, confidence, evidence = result
                inference = TagInference(
                    inference_id=_generate_inference_id(),
                    resource_arn=resource["resource_arn"],
                    resource_name=resource["resource_name"],
                    inferred_tags={"env": env},
                    confidence=confidence,
                    method="name_pattern_match",
                    evidence=evidence,
                    status="pending",
                    created_at=now,
                )
                inferences.append(inference.model_dump())
                _add_inference(inference.model_dump())
            else:
                skipped += 1

        return json.dumps({
            "success": True,
            "method": "name_pattern_match",
            "total_scanned": len(resources),
            "already_tagged": already_tagged,
            "inferred_count": len(inferences),
            "skipped_no_match": skipped,
            "truncated": scan_truncated,
            "max_total": max_total,
            "inferences": inferences[:100],  # 限制返回数量
            "inferences_truncated": len(inferences) > 100,
            "patterns_used": [
                {"pattern": "prod|production|prd", "env": "prod", "confidence": 0.9},
                {"pattern": "dev|develop|development", "env": "dev", "confidence": 0.85},
                {"pattern": "test|testing|qa", "env": "test", "confidence": 0.85},
                {"pattern": "staging|stg|pre", "env": "staging", "confidence": 0.8},
            ],
            "next_step": "使用 tagi_review_inferences 查看推断结果，确认后使用 tagi_apply_inferences 应用",
        }, ensure_ascii=False, indent=2)

    except RuntimeError as e:
        return json.dumps({
            "success": False,
            "error_code": "RESOURCE_CENTER_NOT_OPEN",
            "error_msg": str(e),
        }, ensure_ascii=False)
    except Exception as e:
        logger.exception("tagi_infer_env_from_name 失败")
        return json.dumps({
            "success": False,
            "error_code": "INFERENCE_ERROR",
            "error_msg": str(e),
        }, ensure_ascii=False)


# =============================================================================
# 工具函数 2: 从 VPC 推断 team
# =============================================================================


async def tagi_infer_team_from_vpc(
    vpc_ids: list[str] = None,
    region: str = "cn-hangzhou",
    max_total: int = 500,
    **kwargs,
) -> str:
    """根据 VPC 拓扑推断 team 标签。

    推断规则：
    - VPC 自身有 team 标签 → 子资源继承 (0.9)
    - VPC 下安全组关联 → (0.75)
    - 仅子网推断 → (0.5)

    Args:
        vpc_ids: VPC ID 列表，为空则扫描所有 VPC
        region: 地域 ID
        max_total: 安全上限，默认 10000
        **kwargs: 框架注入参数

    Returns:
        JSON 字符串：推断结果列表（含 truncated 标记）
    """
    credential = kwargs.get("credential") or get_credential()

    try:
        vpc_client = _build_vpc_client(credential, region)

        # 获取 VPC 列表及其标签
        vpc_info_map = {}
        if vpc_ids:
            for vpc_id in vpc_ids:
                info = await _get_vpc_info(vpc_client, vpc_id, region)
                if info:
                    vpc_info_map[vpc_id] = info
        else:
            # 查询所有 VPC
            req = vpc_models.DescribeVpcsRequest(region_id=region, page_size=50)
            resp = await asyncio.to_thread(vpc_client.describe_vpcs, req)
            if resp.body and resp.body.vpcs and resp.body.vpcs.vpc:
                for vpc in resp.body.vpcs.vpc:
                    tags = {}
                    if vpc.tags and vpc.tags.tag:
                        for t in vpc.tags.tag:
                            if t.key:
                                tags[t.key] = t.value or ""
                    vpc_info_map[vpc.vpc_id] = {
                        "vpc_id": vpc.vpc_id,
                        "vpc_name": vpc.vpc_name or "",
                        "tags": tags,
                    }

        # 找出有 team 标签的 VPC
        vpc_team_map = {}
        for vpc_id, info in vpc_info_map.items():
            team = info["tags"].get("team")
            if team:
                vpc_team_map[vpc_id] = team

        if not vpc_team_map:
            return json.dumps({
                "success": True,
                "message": "没有找到有 team 标签的 VPC，无法进行推断",
                "vpc_count": len(vpc_info_map),
                "inferences": [],
            }, ensure_ascii=False, indent=2)

        # 查询 VPC 下的资源
        rc_client = _build_rc_client(credential)
        resources, scan_truncated = await _search_resources_paged(
            rc_client,
            region_ids=[region],
            max_total=max_total,
        )

        inferences = []
        now = datetime.now().isoformat()

        for resource in resources:
            # 跳过已有 team 标签的资源
            if resource.get("tags", {}).get("team"):
                continue

            # 尝试从标签中找 VPC 关联
            resource_tags = resource.get("tags", {})
            matched_vpc = None
            confidence = 0.5

            # 检查常见的 VPC 关联标签
            for key, value in resource_tags.items():
                if "vpc" in key.lower():
                    for vpc_id in vpc_team_map:
                        if vpc_id in value:
                            matched_vpc = vpc_id
                            confidence = 0.75
                            break

            # 如果资源类型是 VPC 子资源（如 VSwich、SecurityGroup）
            resource_type = resource.get("resource_type", "")
            if "VSwitch" in resource_type or "SecurityGroup" in resource_type:
                # 尝试从资源 ID 前缀匹配
                for vpc_id in vpc_team_map:
                    if vpc_id in resource.get("resource_id", ""):
                        matched_vpc = vpc_id
                        confidence = 0.9
                        break

            if matched_vpc and matched_vpc in vpc_team_map:
                team = vpc_team_map[matched_vpc]
                inference = TagInference(
                    inference_id=_generate_inference_id(),
                    resource_arn=resource["resource_arn"],
                    resource_name=resource["resource_name"],
                    inferred_tags={"team": team},
                    confidence=confidence,
                    method="vpc_topology",
                    evidence=f"继承自 VPC {matched_vpc} 的 team 标签",
                    status="pending",
                    created_at=now,
                )
                inferences.append(inference.model_dump())
                _add_inference(inference.model_dump())

        return json.dumps({
            "success": True,
            "method": "vpc_topology",
            "region": region,
            "vpc_with_team_tag": vpc_team_map,
            "total_scanned": len(resources),
            "inferred_count": len(inferences),
            "truncated": scan_truncated,
            "max_total": max_total,
            "inferences": inferences[:100],
            "inferences_truncated": len(inferences) > 100,
            "next_step": "使用 tagi_review_inferences 查看推断结果",
        }, ensure_ascii=False, indent=2)

    except Exception as e:
        logger.exception("tagi_infer_team_from_vpc 失败")
        return json.dumps({
            "success": False,
            "error_code": "INFERENCE_ERROR",
            "error_msg": str(e),
        }, ensure_ascii=False)


# =============================================================================
# 工具函数 3: 从创建者推断 owner
# =============================================================================


async def tagi_infer_owner_from_creator(
    resource_types: list[str] = None,
    regions: list[str] = None,
    creator_mapping: dict[str, str] = None,
    max_total: int = 500,
    **kwargs,
) -> str:
    """根据资源创建者推断 owner 标签。

    注意：Resource Center 不直接返回创建者信息，
    此函数使用 account_id 作为创建者的代理标识。

    Args:
        resource_types: 资源类型过滤
        regions: 地域过滤
        creator_mapping: 创建者到 owner 的映射，如 {"alice": "alice@example.com"}
        max_total: 安全上限，默认 10000
        **kwargs: 框架注入参数

    Returns:
        JSON 字符串：推断结果列表（含 truncated 标记）
    """
    credential = kwargs.get("credential") or get_credential()

    if not creator_mapping:
        return json.dumps({
            "success": False,
            "error_code": "INVALID_PARAM",
            "error_msg": "creator_mapping 不能为空，请提供创建者到 owner 的映射",
            "example": {"alice": "alice@example.com", "bob": "bob@example.com"},
        }, ensure_ascii=False, indent=2)

    try:
        rc_client = _build_rc_client(credential)
        resources, scan_truncated = await _search_resources_paged(
            rc_client,
            resource_type_filter=resource_types,
            region_ids=regions,
            max_total=max_total,
        )

        inferences = []
        now = datetime.now().isoformat()
        confidence = 0.8  # 固定置信度

        for resource in resources:
            # 跳过已有 owner 标签的资源
            if resource.get("tags", {}).get("owner"):
                continue

            # 使用 account_id 作为创建者代理
            account_id = resource.get("account_id", "")
            matched_owner = None

            for creator, owner in creator_mapping.items():
                if creator in account_id or creator == account_id:
                    matched_owner = owner
                    break

            if matched_owner:
                inference = TagInference(
                    inference_id=_generate_inference_id(),
                    resource_arn=resource["resource_arn"],
                    resource_name=resource["resource_name"],
                    inferred_tags={"owner": matched_owner},
                    confidence=confidence,
                    method="creator_mapping",
                    evidence=f"账号 {account_id} 映射到 owner: {matched_owner}",
                    status="pending",
                    created_at=now,
                )
                inferences.append(inference.model_dump())
                _add_inference(inference.model_dump())

        return json.dumps({
            "success": True,
            "method": "creator_mapping",
            "total_scanned": len(resources),
            "inferred_count": len(inferences),
            "creator_mapping_used": creator_mapping,
            "confidence": confidence,
            "truncated": scan_truncated,
            "max_total": max_total,
            "inferences": inferences[:100],
            "inferences_truncated": len(inferences) > 100,
            "next_step": "使用 tagi_review_inferences 查看推断结果",
        }, ensure_ascii=False, indent=2)

    except RuntimeError as e:
        return json.dumps({
            "success": False,
            "error_code": "RESOURCE_CENTER_NOT_OPEN",
            "error_msg": str(e),
        }, ensure_ascii=False)
    except Exception as e:
        logger.exception("tagi_infer_owner_from_creator 失败")
        return json.dumps({
            "success": False,
            "error_code": "INFERENCE_ERROR",
            "error_msg": str(e),
        }, ensure_ascii=False)


# =============================================================================
# 工具函数 4: 批量推断
# =============================================================================


async def tagi_batch_infer(
    resource_arns: list[str],
    tag_keys: list[str] = None,
    max_total: int = 500,
    **kwargs,
) -> str:
    """对给定资源执行所有适用的推断方法。

    根据 tag_keys 决定执行哪些推断：
    - env: 执行名称模式推断
    - team: 执行 VPC 拓扑推断
    - owner: 执行创建者推断（需要额外配置）

    Args:
        resource_arns: 资源 ARN 列表
        tag_keys: 要推断的标签键列表，默认 ["env"]
        max_total: 安全上限，默认 10000
        **kwargs: 框架注入参数

    Returns:
        JSON 字符串：推断结果列表（含 truncated 标记）
    """
    credential = kwargs.get("credential") or get_credential()
    tag_keys = tag_keys or ["env"]

    if not resource_arns:
        return json.dumps({
            "success": False,
            "error_code": "INVALID_PARAM",
            "error_msg": "resource_arns 不能为空",
        }, ensure_ascii=False)

    try:
        rc_client = _build_rc_client(credential)

        # 查询资源详情
        # 需要查全量以筛选目标资源，使用 max(len(resource_arns) * 2, max_total)
        effective_max = max(len(resource_arns) * 2, max_total)
        resources, scan_truncated = await _search_resources_paged(
            rc_client,
            max_total=effective_max,
        )

        # 筛选目标资源
        target_resources = [
            r for r in resources if r["resource_arn"] in resource_arns
        ]

        if not target_resources:
            return json.dumps({
                "success": True,
                "message": "未找到指定的资源",
                "requested_arns": resource_arns,
                "inferences": [],
            }, ensure_ascii=False, indent=2)

        inferences = []
        now = datetime.now().isoformat()

        for resource in target_resources:
            existing_tags = resource.get("tags", {})
            resource_inferences = []

            # 推断 env
            if "env" in tag_keys and not existing_tags.get("env"):
                result = _infer_env_from_name(resource["resource_name"])
                if result:
                    env, confidence, evidence = result
                    resource_inferences.append({
                        "tag_key": "env",
                        "tag_value": env,
                        "confidence": confidence,
                        "method": "name_pattern_match",
                        "evidence": evidence,
                    })

            # 合并推断结果
            if resource_inferences:
                # 取最高置信度的推断
                best_inference = max(resource_inferences, key=lambda x: x["confidence"])
                all_tags = {inf["tag_key"]: inf["tag_value"] for inf in resource_inferences}

                inference = TagInference(
                    inference_id=_generate_inference_id(),
                    resource_arn=resource["resource_arn"],
                    resource_name=resource["resource_name"],
                    inferred_tags=all_tags,
                    confidence=best_inference["confidence"],
                    method="batch_infer",
                    evidence="; ".join([inf["evidence"] for inf in resource_inferences]),
                    status="pending",
                    created_at=now,
                )
                inferences.append(inference.model_dump())
                _add_inference(inference.model_dump())

        return json.dumps({
            "success": True,
            "method": "batch_infer",
            "tag_keys_requested": tag_keys,
            "total_requested": len(resource_arns),
            "total_found": len(target_resources),
            "inferred_count": len(inferences),
            "truncated": scan_truncated,
            "max_total": effective_max,
            "inferences": inferences,
            "next_step": "使用 tagi_review_inferences 查看推断结果",
        }, ensure_ascii=False, indent=2)

    except RuntimeError as e:
        return json.dumps({
            "success": False,
            "error_code": "RESOURCE_CENTER_NOT_OPEN",
            "error_msg": str(e),
        }, ensure_ascii=False)
    except Exception as e:
        logger.exception("tagi_batch_infer 失败")
        return json.dumps({
            "success": False,
            "error_code": "INFERENCE_ERROR",
            "error_msg": str(e),
        }, ensure_ascii=False)


# =============================================================================
# 工具函数 5: 查询待审核推断
# =============================================================================


async def tagi_review_inferences(
    min_confidence: float = 0.0,
    status: str = "pending",
    limit: int = 50,
    **kwargs,
) -> str:
    """查询待审核的标签推断列表。

    Args:
        min_confidence: 最小置信度过滤，默认 0（不过滤）
        status: 状态过滤 (pending | approved | rejected)，默认 pending
        limit: 返回数量限制，默认 50
        **kwargs: 框架注入参数

    Returns:
        JSON 字符串：推断列表
    """
    inferences = _load_inferences()

    # 过滤
    filtered = [
        inf for inf in inferences
        if inf.get("status") == status and inf.get("confidence", 0) >= min_confidence
    ]

    # 按置信度降序排序
    filtered.sort(key=lambda x: -x.get("confidence", 0))

    # 限制数量
    filtered = filtered[:limit]

    # 统计
    by_method = defaultdict(int)
    by_tag_key = defaultdict(int)
    for inf in filtered:
        by_method[inf.get("method", "unknown")] += 1
        for key in inf.get("inferred_tags", {}).keys():
            by_tag_key[key] += 1

    return json.dumps({
        "success": True,
        "filter": {
            "min_confidence": min_confidence,
            "status": status,
            "limit": limit,
        },
        "total_matching": len(filtered),
        "by_method": dict(by_method),
        "by_tag_key": dict(by_tag_key),
        "inferences": filtered,
        "inferences_file": str(_INFERENCES_FILE),
        "next_step": "使用 tagi_apply_inferences 确认或拒绝推断结果",
    }, ensure_ascii=False, indent=2)


# =============================================================================
# 工具函数 6: 应用推断
# =============================================================================


async def tagi_apply_inferences(
    inference_ids: list[str],
    action: str = "approve",
    **kwargs,
) -> str:
    """确认或拒绝标签推断结果。

    approve 时会调用统一 Tag API 应用标签。

    Args:
        inference_ids: 推断 ID 列表
        action: 操作类型 (approve | reject)
        **kwargs: 框架注入参数

    Returns:
        JSON 字符串：操作结果
    """
    credential = kwargs.get("credential") or get_credential()

    if not inference_ids:
        return json.dumps({
            "success": False,
            "error_code": "INVALID_PARAM",
            "error_msg": "inference_ids 不能为空",
        }, ensure_ascii=False)

    if action not in ["approve", "reject"]:
        return json.dumps({
            "success": False,
            "error_code": "INVALID_PARAM",
            "error_msg": f"无效的 action: {action}，支持: approve, reject",
        }, ensure_ascii=False)

    inferences = _load_inferences()

    # 找到目标推断
    target_inferences = []
    for inf in inferences:
        if inf.get("inference_id") in inference_ids:
            if inf.get("status") != "pending":
                continue
            target_inferences.append(inf)

    if not target_inferences:
        return json.dumps({
            "success": False,
            "error_code": "INFERENCES_NOT_FOUND",
            "error_msg": f"未找到待处理的推断: {inference_ids}",
        }, ensure_ascii=False)

    results = {
        "approved": [],
        "rejected": [],
        "tagged": [],
        "failed": [],
    }

    if action == "reject":
        # 直接标记为 rejected
        for inf in target_inferences:
            inf["status"] = "rejected"
            results["rejected"].append(inf["inference_id"])
        _save_inferences(inferences)

        return json.dumps({
            "success": True,
            "action": "reject",
            "results": results,
        }, ensure_ascii=False, indent=2)

    # approve: 需要应用标签
    by_region: dict[str, list[dict]] = defaultdict(list)
    for inf in target_inferences:
        region = _parse_arn_region(inf["resource_arn"])
        by_region[region].append(inf)

    for region, region_inferences in by_region.items():
        tag_client = _build_tag_client(credential, region)
        for inf in region_inferences:
            try:
                tag_list = [
                    tag_models.TagResourcesRequestTags(key=k, value=v)
                    for k, v in inf["inferred_tags"].items()
                ]
                req = tag_models.TagResourcesRequest(
                    region_id=region,
                    resource_arn=[inf["resource_arn"]],
                    tags=tag_list,
                )
                await asyncio.to_thread(tag_client.tag_resources, req)
                inf["status"] = "approved"
                results["approved"].append(inf["inference_id"])
                results["tagged"].append({
                    "inference_id": inf["inference_id"],
                    "resource_arn": inf["resource_arn"],
                    "tags_applied": inf["inferred_tags"],
                })
            except Exception as e:
                results["failed"].append({
                    "inference_id": inf["inference_id"],
                    "resource_arn": inf["resource_arn"],
                    "error": str(e),
                })

    _save_inferences(inferences)

    return json.dumps({
        "success": len(results["failed"]) == 0,
        "action": "approve",
        "results": results,
        "summary": {
            "total_requested": len(inference_ids),
            "approved_and_tagged": len(results["approved"]),
            "failed": len(results["failed"]),
        },
    }, ensure_ascii=False, indent=2)

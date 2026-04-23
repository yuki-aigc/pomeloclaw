# -*- coding: utf-8 -*-
"""阿里云标签治理数据基座。

基于资源中心（Resource Center）和统一标签 API，2 个全局 SDK 覆盖 200+ 资源类型：
- 标签规则管理：交互引导用户确认后持久化到本地配置
- 存量资源发现：跨产品跨地域盘点，支持聚合统计模式（9000+ 资源）
- 标签缺口分析：覆盖率报告、能力矩阵、差距分析
- 合规检查：综合检查覆盖率和值一致性
- 批量打标执行：统一 Tag API，支持 dry_run 预览
"""

import asyncio
import json
import logging
import math
import re
from collections import defaultdict
from pathlib import Path
from typing import Any, Optional

from alibabacloud_tea_openapi.models import Config
from alibabacloud_resourcecenter20221201.client import Client as ResourceCenterClient
from alibabacloud_resourcecenter20221201 import models as rc_models
from alibabacloud_tag20180828.client import Client as TagClient
from alibabacloud_tag20180828 import models as tag_models
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
_RC_PAGE_SIZE = 500
_TAG_BATCH_SIZE = 50
_LIST_TYPES_PAGE_SIZE = 100
_RC_SCAN_LIMIT = 20000
_DETAIL_OUTPUT_CAP = 200

_TAG_RETRY_MAX = 3
_TAG_RETRY_BASE_DELAY = 1.0
_TAG_BATCH_INTERVAL = 0.3

_RULES_DIR = Path.home() / ".copaw" / "data"
_RULES_FILE = _RULES_DIR / "tag_pipeline_rules.json"
_POLICY_FILE = _RULES_DIR / "finops_policy.json"

# Assets 配置目录
_SKILL_DIR = Path(__file__).parent
_ASSETS_DIR = _SKILL_DIR / "assets"
_BILLABLE_CONFIG_FILE = _ASSETS_DIR / "billable_resource_types.json"

_BUILTIN_DEFAULT_RULES = {
    "required_keys": ["env"],
    "key_whitelist": {
        "env": ["dev", "test", "staging", "production"],
    },
    "key_naming_pattern": "^[a-z][a-z0-9_-]*$",
    "description": "默认标签规则，建议通过 tagf_save_rules 按实际情况定制",
}

_POLICY_TAG_DEFAULTS = {
    "conservative": {
        "required_tag_keys": ["env"],
        "tag_report_top_n": 20,
    },
    "moderate": {
        "required_tag_keys": ["env", "team", "owner"],
        "tag_report_top_n": 50,
    },
    "aggressive": {
        "required_tag_keys": ["env", "team", "owner", "cost-center"],
        "tag_report_top_n": 0,
    },
}

_TAG_KEY_ALIASES = {
    "costcenter": "cost_center",
    "cost-center": "cost_center",
    "cost_center": "cost_center",
}

# 标签一致性检查的规范化映射
_KEY_NORMALIZATION = {
    "env": "env", "Env": "env", "ENV": "env", "environment": "env",
    "Environment": "env", "ENVIRONMENT": "env",
    "team": "team", "Team": "team", "TEAM": "team",
    "owner": "owner", "Owner": "owner", "OWNER": "owner",
    "app": "app", "App": "app", "APP": "app", "application": "app",
    "Application": "app", "cost-center": "cost-center",
    "CostCenter": "cost-center", "costcenter": "cost-center",
}

_VALUE_NORMALIZATION = {
    "prod": "production", "PROD": "production", "prd": "production",
    "Production": "production", "PRODUCTION": "production",
    "dev": "development", "DEV": "development", "Dev": "development",
    "Development": "development",
    "stg": "staging", "STG": "staging", "Staging": "staging",
    "test": "testing", "TEST": "testing", "Test": "testing",
    "Testing": "testing",
}

# 缓存可计费资源配置
_BILLABLE_CONFIG_CACHE: dict | None = None


def _load_billable_config() -> dict:
    """加载可计费资源类型配置（带缓存）。"""
    global _BILLABLE_CONFIG_CACHE
    if _BILLABLE_CONFIG_CACHE is not None:
        return _BILLABLE_CONFIG_CACHE

    try:
        if _BILLABLE_CONFIG_FILE.exists():
            _BILLABLE_CONFIG_CACHE = json.loads(
                _BILLABLE_CONFIG_FILE.read_text(encoding="utf-8")
            )
        else:
            _BILLABLE_CONFIG_CACHE = {}
    except Exception as e:
        logger.warning("加载可计费资源配置失败: %s", e)
        _BILLABLE_CONFIG_CACHE = {}

    return _BILLABLE_CONFIG_CACHE


def _get_billable_resource_types() -> list[str] | None:
    """获取可计费资源类型白名单（如未配置返回 None）。"""
    config = _load_billable_config()
    settings = config.get("settings", {})
    if not settings.get("only_billable_types", True):
        return None
    return config.get("billable_resource_types")


def _get_ack_managed_tag_prefixes() -> list[str]:
    """获取 ACK 托管资源的标签前缀。"""
    config = _load_billable_config()
    return config.get("ack_managed_tag_prefixes", [
        "ack.aliyun.com",
        "kubernetes.io",
        "k8s.io",
        "acs:autoscaling",
        "acs:ack:",
    ])


def _is_ack_managed_resource(resource: dict) -> bool:
    """判断资源是否为 ACK 托管资源（通过标签判断）。

    ACK 自动创建的资源应通过 ACK 集群统一计费，不应单独统计标签覆盖率。
    """
    config = _load_billable_config()
    settings = config.get("settings", {})
    if not settings.get("filter_ack_managed_resources", True):
        return False

    prefixes = _get_ack_managed_tag_prefixes()
    tags = resource.get("tags", {})

    for tag_key in tags:
        for prefix in prefixes:
            if tag_key.startswith(prefix):
                return True
    return False


# =============================================================================
# 标签规则管理辅助
# =============================================================================


def _canonicalize_tag_key(key: str) -> str:
    """规范化标签键，兼容 cost-center / cost_center 等别名。"""
    return _TAG_KEY_ALIASES.get(key, key)


def _normalize_required_keys(required_keys: list[str]) -> list[str]:
    """规范化并去重 required_keys，保持原始顺序。"""
    normalized = []
    seen = set()
    for key in required_keys:
        canonical = _canonicalize_tag_key(key)
        if canonical and canonical not in seen:
            normalized.append(canonical)
            seen.add(canonical)
    return normalized


def _normalize_key_whitelist(
    key_whitelist: Optional[dict[str, list[str]]],
) -> dict[str, list[str]]:
    """规范化 key whitelist 的键名。"""
    if not key_whitelist:
        return {}

    normalized: dict[str, list[str]] = {}
    for key, values in key_whitelist.items():
        canonical = _canonicalize_tag_key(key)
        normalized[canonical] = list(values or [])
    return normalized


def _normalize_tag_rules(rules: dict) -> dict:
    """规范化标签规则结构。"""
    normalized = dict(rules)
    normalized["required_keys"] = _normalize_required_keys(
        list(normalized.get("required_keys", []))
    )
    normalized["key_whitelist"] = _normalize_key_whitelist(
        normalized.get("key_whitelist")
    )
    if not normalized.get("key_naming_pattern"):
        normalized["key_naming_pattern"] = _BUILTIN_DEFAULT_RULES["key_naming_pattern"]
    return normalized


def _load_policy_defaults() -> dict:
    """读取 FinOps 策略中的标签默认值。"""
    policy_data = {}
    try:
        policy_data = json.loads(_POLICY_FILE.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        policy_data = {}

    strategy = policy_data.get("active_strategy", "moderate")
    defaults = dict(
        _POLICY_TAG_DEFAULTS.get(strategy, _POLICY_TAG_DEFAULTS["moderate"])
    )
    overrides = policy_data.get("custom_overrides", {})

    required_keys = overrides.get(
        "required_tag_keys", defaults["required_tag_keys"]
    )
    tag_report_top_n = overrides.get(
        "tag_report_top_n", defaults["tag_report_top_n"]
    )

    return {
        "active_strategy": strategy,
        "required_tag_keys": _normalize_required_keys(list(required_keys)),
        "tag_report_top_n": tag_report_top_n,
        "custom_overrides": overrides,
        "exists": _POLICY_FILE.exists(),
    }


def _load_tag_rules_with_source() -> tuple[dict, str, Optional[str]]:
    """加载标签规则，并返回来源和关联策略。"""
    if _RULES_FILE.exists():
        try:
            data = json.loads(_RULES_FILE.read_text(encoding="utf-8"))
            if isinstance(data, dict) and "required_keys" in data:
                return _normalize_tag_rules(data), "custom", None
            logger.warning("规则文件格式异常，回退内置默认: %s", _RULES_FILE)
        except Exception as e:
            logger.warning("读取规则文件失败，回退内置默认: %s", e)

    policy_defaults = _load_policy_defaults()
    if policy_defaults["required_tag_keys"]:
        rules = {
            "required_keys": policy_defaults["required_tag_keys"],
            "key_whitelist": _BUILTIN_DEFAULT_RULES["key_whitelist"],
            "key_naming_pattern": _BUILTIN_DEFAULT_RULES["key_naming_pattern"],
            "description": (
                "继承当前 FinOps 策略的标签要求；"
                "建议通过 tagf_save_rules 进一步补充白名单"
            ),
        }
        return (
            _normalize_tag_rules(rules),
            "finops_policy",
            policy_defaults["active_strategy"],
        )

    return _normalize_tag_rules(dict(_BUILTIN_DEFAULT_RULES)), "builtin_default", None


def _load_tag_rules() -> dict:
    """加载标签规则：优先自定义规则，无则回退 FinOps 策略，再回退内置默认。"""
    rules, _, _ = _load_tag_rules_with_source()
    return rules


def _save_tag_rules(rules: dict) -> str:
    """将标签规则持久化到本地 JSON 文件。返回保存路径。"""
    _RULES_DIR.mkdir(parents=True, exist_ok=True)
    _RULES_FILE.write_text(
        json.dumps(rules, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return str(_RULES_FILE)


def _sync_policy_required_keys(required_keys: list[str]) -> None:
    """将标签规则同步回 FinOps 策略。"""
    policy_data = {}
    try:
        policy_data = json.loads(_POLICY_FILE.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        policy_data = {}

    overrides = policy_data.get("custom_overrides", {})
    overrides["required_tag_keys"] = _normalize_required_keys(required_keys)
    policy_data["custom_overrides"] = overrides
    if not policy_data.get("active_strategy"):
        policy_data["active_strategy"] = "moderate"

    _RULES_DIR.mkdir(parents=True, exist_ok=True)
    _POLICY_FILE.write_text(
        json.dumps(policy_data, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


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
    """构建 Resource Center 客户端（全局端点）。"""
    ak, sk = _get_ak_sk(credential)
    config = Config(
        access_key_id=ak,
        access_key_secret=sk,
        endpoint=_RC_ENDPOINT,
        region_id="cn-hangzhou",
    )
    return ResourceCenterClient(config)


def _build_tag_client(credential, region_id: str = "cn-hangzhou") -> TagClient:
    """构建统一 Tag API 客户端（按地域端点）。"""
    ak, sk = _get_ak_sk(credential)
    config = Config(
        access_key_id=ak,
        access_key_secret=sk,
        endpoint=_TAG_ENDPOINT_TPL.format(region=region_id),
        region_id=region_id,
    )
    return TagClient(config)


# =============================================================================
# ARN 解析辅助
# =============================================================================


def _parse_arn_region(arn: str) -> str:
    """从 ARN 中提取 region。"""
    parts = arn.split(":")
    if len(parts) >= 4:
        return parts[3]
    return "cn-hangzhou"


def _parse_arn_product(arn: str) -> str:
    """从 ARN 中提取产品 service code。"""
    parts = arn.split(":")
    if len(parts) >= 3:
        return parts[2]
    return "unknown"


def _is_retryable_error(exc: Exception) -> bool:
    """判断异常是否可重试。"""
    err_str = str(exc)
    retryable_codes = (
        "Throttling", "ServiceBusy", "InternalError",
        "ServiceUnavailable", "OperationConflict",
        "timeout", "Timeout", "ConnectionError",
    )
    return any(code in err_str for code in retryable_codes)


async def _tag_region_batch(
    tag_client: TagClient,
    region_id: str,
    arns: list[str],
    tag_list: list,
    batch_size: int = _TAG_BATCH_SIZE,
) -> dict:
    """对单个 Region 内的资源分批打标，含重试与速率控制。"""
    tagged = 0
    failed = 0
    errors = []
    failed_arns = []
    total_batches = math.ceil(len(arns) / batch_size)

    for batch_idx, i in enumerate(range(0, len(arns), batch_size), 1):
        batch = arns[i:i + batch_size]
        req = tag_models.TagResourcesRequest(
            region_id=region_id,
            resource_arn=batch,
            tags=tag_list,
        )

        last_err = None
        for attempt in range(1, _TAG_RETRY_MAX + 1):
            try:
                await asyncio.to_thread(tag_client.tag_resources, req)
                tagged += len(batch)
                last_err = None
                break
            except Exception as e:
                last_err = e
                if attempt < _TAG_RETRY_MAX and _is_retryable_error(e):
                    delay = _TAG_RETRY_BASE_DELAY * (2 ** (attempt - 1))
                    logger.info(
                        "打标重试 (region=%s, batch=%d/%d, attempt=%d/%d, delay=%.1fs): %s",
                        region_id, batch_idx, total_batches, attempt, _TAG_RETRY_MAX, delay, e,
                    )
                    await asyncio.sleep(delay)
                else:
                    break

        if last_err is not None:
            logger.warning(
                "批量打标失败 (region=%s, batch=%d/%d): %s",
                region_id, batch_idx, total_batches, last_err,
            )
            failed += len(batch)
            failed_arns.extend(batch)
            errors.append({
                "batch_index": batch_idx,
                "batch_size": len(batch),
                "error": str(last_err),
                "retryable": _is_retryable_error(last_err),
                "failed_arns": batch,
            })
        else:
            logger.info(
                "打标进度 region=%s: batch %d/%d 完成 (%d 资源)",
                region_id, batch_idx, total_batches, len(batch),
            )

        if i + batch_size < len(arns):
            await asyncio.sleep(_TAG_BATCH_INTERVAL)

    return {
        "tagged": tagged,
        "failed": failed,
        "errors": errors,
        "failed_arns": failed_arns,
    }


def _find_tag_value(tags: dict[str, str], key: str) -> Optional[str]:
    """按规范化键名查找标签值。"""
    canonical = _canonicalize_tag_key(key)
    for existing_key, value in tags.items():
        if _canonicalize_tag_key(existing_key) == canonical:
            return value
    return None


def _has_tag_key(tags: dict[str, str], key: str) -> bool:
    """判断资源标签中是否存在指定标签键。"""
    return _find_tag_value(tags, key) is not None


def _validate_tags_against_rules(tags: dict[str, str], rules: dict) -> list[str]:
    """校验待写入标签是否符合当前治理规则。"""
    errors = []
    naming_pattern = rules.get("key_naming_pattern")
    key_whitelist = rules.get("key_whitelist", {})

    if naming_pattern:
        pattern = re.compile(naming_pattern)
        invalid_names = [
            key for key in tags if not key.startswith("acs:") and not pattern.match(key)
        ]
        if invalid_names:
            errors.append(
                "以下标签键不符合命名规范: " + ", ".join(sorted(invalid_names))
            )

    for key, value in tags.items():
        canonical = _canonicalize_tag_key(key)
        allowed_values = key_whitelist.get(canonical)
        if allowed_values and value not in allowed_values:
            errors.append(
                f"标签 {key} 的值 {value!r} 不在允许范围 {allowed_values} 内"
            )

    return errors


# =============================================================================
# Resource Center 分页查询
# =============================================================================


async def _search_resources_paged(
    rc_client: ResourceCenterClient,
    resource_type_filter: Optional[list[str]] = None,
    region_ids: Optional[list[str]] = None,
    max_total: int = 500,
    only_billable: bool = True,
    filter_ack_managed: bool = True,
) -> tuple[list[dict], bool, dict]:
    """Resource Center 分页查询，NextToken 模式。

    Args:
        rc_client: ResourceCenter 客户端
        resource_type_filter: 资源类型过滤
        region_ids: 地域过滤
        max_total: 安全上限，默认 50000，防止超大账号无限循环
        only_billable: 仅返回可计费资源类型（默认 True）
        filter_ack_managed: 过滤 ACK 托管资源（默认 True）

    Returns:
        tuple[list[dict], bool, dict]: (资源列表, 是否因达到上限被截断, 过滤统计)
    """
    all_resources = []
    next_token = None
    truncated = False
    page_count = 0
    filter_stats = {
        "total_scanned": 0,
        "filtered_non_billable": 0,
        "filtered_ack_managed": 0,
        "kept": 0,
    }

    # 获取可计费资源类型白名单
    billable_types = None
    if only_billable:
        billable_types = _get_billable_resource_types()
        if billable_types:
            billable_types_set = set(billable_types)
            logger.info("启用可计费资源过滤，共 %d 个资源类型", len(billable_types_set))

    while True:
        # 达到安全上限
        if len(all_resources) >= max_total:
            truncated = True
            logger.info(
                "资源扫描达到安全上限 %d，停止分页（可通过 max_total 参数调整）",
                max_total,
            )
            break

        filters = []
        # 资源类型过滤：优先使用用户指定，否则使用可计费白名单
        effective_type_filter = resource_type_filter
        if not effective_type_filter and billable_types:
            effective_type_filter = billable_types

        if effective_type_filter:
            # 服务端过滤资源类型，大幅减少返回数据量
            filters.append(rc_models.SearchResourcesRequestFilter(
                key="ResourceType",
                value=effective_type_filter,
                match_type="Equals",
            ))
        if region_ids:
            filters.append(rc_models.SearchResourcesRequestFilter(
                key="RegionId",
                value=region_ids,
                match_type="Equals",
            ))

        # 单次请求最大 100 条（阿里云 SearchResources API 限制）
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
        kept_count = 0
        if resp.body and resp.body.resources:
            for r in resp.body.resources:
                filter_stats["total_scanned"] += 1

                tags = {}
                if r.tags:
                    for t in r.tags:
                        if t.key:
                            tags[t.key] = t.value or ""

                resource = {
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
                }

                # 过滤 ACK 托管资源
                if filter_ack_managed and _is_ack_managed_resource(resource):
                    filter_stats["filtered_ack_managed"] += 1
                    continue

                all_resources.append(resource)
                filter_stats["kept"] += 1
                kept_count += 1
                batch_count += 1

        # 输出进度日志
        logger.info(
            "资源扫描进度: 第 %d 页，本页保留 %d 条，累计 %d 条",
            page_count, kept_count, len(all_resources),
        )

        next_token = resp.body.next_token if resp.body else None
        if not next_token:
            # 没有更多数据
            break

    logger.info(
        "资源扫描完成: 总扫描 %d，ACK过滤 %d，保留 %d",
        filter_stats["total_scanned"],
        filter_stats["filtered_ack_managed"],
        filter_stats["kept"],
    )
    return all_resources[:max_total], truncated, filter_stats


async def _get_resource_counts(
    rc_client: ResourceCenterClient,
    group_by: str = "ResourceType",
    resource_type_filter: list[str] | None = None,
    region_ids: list[str] | None = None,
) -> list[dict]:
    """服务端聚合 — 通过 GetResourceCounts API 按维度分组统计。"""
    filters = []
    if resource_type_filter:
        # 将所有资源类型合并为一个 filter（OR 逻辑），而非每个类型一个 filter（AND 逻辑会返回空）
        filters.append(rc_models.GetResourceCountsRequestFilter(
            key="ResourceType",
            value=resource_type_filter,  # 所有类型放入一个 value 数组
            match_type="Equals",
        ))
    if region_ids:
        filters.append(rc_models.GetResourceCountsRequestFilter(
            key="RegionId",
            value=region_ids,
            match_type="Equals",
        ))

    req = rc_models.GetResourceCountsRequest(
        group_by_key=group_by,
        filter=filters if filters else None,
    )

    try:
        resp = await asyncio.to_thread(rc_client.get_resource_counts, req)
    except Exception as e:
        error_msg = str(e)
        if "ServiceUnavailable" in error_msg or "NotOpen" in error_msg:
            raise RuntimeError(
                "资源中心服务未开通。请在阿里云控制台开通 Resource Center 服务后重试。"
            ) from e
        raise

    results = []
    # 解析响应体 - 尝试多种可能的属性名和结构
    body = getattr(resp, "body", None)
    if body:
        # 优先从 resp.body.resource_counts 读取（实际 API 返回的数据位置）
        resource_counts = getattr(body, "resource_counts", None)
        if resource_counts and isinstance(resource_counts, list):
            for rc_item in resource_counts:
                # 兼容 snake_case 和 CamelCase 属性名
                group_name = getattr(rc_item, "group_name", None) or getattr(rc_item, "GroupName", None) or getattr(rc_item, "key", None) or ""
                count = getattr(rc_item, "count", None) or getattr(rc_item, "Count", None) or 0
                if group_name:  # 只添加有效的记录
                    results.append({
                        "group_name": group_name,
                        "count": count,
                    })
        # Fallback: 尝试 resp.body.filters（兼容旧版 SDK）
        if not results:
            filter_list = getattr(body, "filters", None)
            if filter_list and isinstance(filter_list, list):
                for f in filter_list:
                    # 兼容 snake_case 和 CamelCase 属性名
                    group_name = getattr(f, "group_name", None) or getattr(f, "GroupName", None) or ""
                    count = getattr(f, "count", None) or getattr(f, "Count", None) or 0
                    if group_name:
                        results.append({
                            "group_name": group_name,
                            "count": count,
                        })

    return results


async def _fetch_supported_type_capabilities(
    tag_client: TagClient,
    region_id: str = "cn-hangzhou",
) -> dict[str, dict[str, bool]]:
    """获取统一 Tag API 支持的资源类型能力图谱。"""
    capabilities_by_type: dict[str, dict[str, bool]] = {}
    next_token = None

    for _ in range(50):
        req = tag_models.ListSupportResourceTypesRequest(
            region_id=region_id,
            show_items=True,
            max_result=_LIST_TYPES_PAGE_SIZE,
            next_token=next_token,
        )
        resp = await asyncio.to_thread(tag_client.list_support_resource_types, req)

        if resp.body and resp.body.support_resource_types:
            for srt in resp.body.support_resource_types:
                if not srt.resource_type:
                    continue
                support_map: dict[str, bool] = {}
                if srt.support_items:
                    for item in srt.support_items:
                        if item.support_code:
                            support_map[item.support_code] = bool(item.support)
                capabilities_by_type[srt.resource_type] = support_map

        next_token = resp.body.next_token if resp.body else None
        if not next_token:
            break

    return capabilities_by_type


# =============================================================================
# 覆盖率计算辅助
# =============================================================================


def _compute_coverage(
    resources: list[dict],
    required_keys: list[str],
) -> dict:
    """计算标签覆盖率统计。"""
    normalized_required_keys = _normalize_required_keys(required_keys)
    total = len(resources)
    if total == 0:
        return {
            "total_resources": 0,
            "fully_tagged": 0,
            "coverage_percent": 0.0,
            "by_key": {},
            "by_product": {},
        }

    key_stats = {}
    for key in normalized_required_keys:
        tagged = sum(1 for r in resources if _has_tag_key(r.get("tags", {}), key))
        key_stats[key] = {
            "tagged": tagged,
            "missing": total - tagged,
            "percent": round(tagged / total * 100, 1),
        }

    fully_tagged = sum(
        1 for r in resources
        if all(_has_tag_key(r.get("tags", {}), k) for k in normalized_required_keys)
    )

    product_groups: dict[str, list[dict]] = defaultdict(list)
    for r in resources:
        product_groups[r["resource_type"]].append(r)

    by_product = {}
    for rt, group in sorted(product_groups.items(), key=lambda x: -len(x[1])):
        p_total = len(group)
        p_fully = sum(
            1 for r in group
            if all(_has_tag_key(r.get("tags", {}), k) for k in normalized_required_keys)
        )
        p_by_key = {}
        for key in normalized_required_keys:
            p_tagged = sum(
                1 for r in group if _has_tag_key(r.get("tags", {}), key)
            )
            p_by_key[key] = {
                "tagged": p_tagged,
                "missing": p_total - p_tagged,
                "percent": round(p_tagged / p_total * 100, 1),
            }
        by_product[rt] = {
            "total": p_total,
            "fully_tagged": p_fully,
            "coverage_percent": round(p_fully / p_total * 100, 1),
            "by_key": p_by_key,
        }

    return {
        "total_resources": total,
        "fully_tagged": fully_tagged,
        "coverage_percent": round(fully_tagged / total * 100, 1),
        "by_key": key_stats,
        "by_product": by_product,
    }


# =============================================================================
# 工具函数 1: 查看当前标签规则
# =============================================================================


async def tagf_load_rules(**kwargs) -> str:
    """查看当前标签规则 — 显示必选 Key、值白名单、命名规范等。

    优先读取用户自定义规则文件（~/.copaw/data/tag_pipeline_rules.json），
    若不存在则返回内置默认规则。

    Returns:
        JSON 字符串：当前生效的标签规则 + 规则来源
    """
    rules, source, linked_strategy = _load_tag_rules_with_source()

    result = {
        "success": True,
        "source": source,
        "rules_file": str(_RULES_FILE),
        "policy_file": str(_POLICY_FILE),
        "linked_finops_strategy": linked_strategy,
        "rules": rules,
        "hint": (
            "使用 tagf_save_rules 可自定义规则；"
            "规则确认后将持久化到 " + str(_RULES_FILE)
        ),
    }
    return json.dumps(result, ensure_ascii=False, indent=2)


# =============================================================================
# 工具函数 2: 保存/更新标签规则
# =============================================================================


async def tagf_save_rules(
    required_keys: list[str],
    key_whitelist: dict[str, list[str]] = None,
    key_naming_pattern: str = None,
    description: str = None,
    sync_finops_policy: bool = True,
    **kwargs,
) -> str:
    """保存标签规则 — 将用户确认的标签治理规则持久化到本地配置。

    Args:
        required_keys: 必选标签键列表，如 ["env", "team", "app"]
        key_whitelist: 可选，各 key 的合法值白名单，如 {"env": ["dev","test","prod"]}
        key_naming_pattern: 可选，标签 key 命名正则，如 "^[a-z][a-z0-9_-]*$"
        description: 可选，规则说明备注
        sync_finops_policy: 是否同步到 FinOps 策略，默认 True
        **kwargs: 框架注入参数

    Returns:
        JSON 字符串：保存结果 + 规则文件路径
    """
    if not required_keys:
        return json.dumps({
            "success": False,
            "error_code": "INVALID_PARAM",
            "error_msg": "required_keys 不能为空",
        }, ensure_ascii=False)

    normalized_required_keys = _normalize_required_keys(required_keys)
    rules: dict[str, Any] = {"required_keys": normalized_required_keys}
    if key_whitelist is not None:
        rules["key_whitelist"] = _normalize_key_whitelist(key_whitelist)
    if key_naming_pattern is not None:
        rules["key_naming_pattern"] = key_naming_pattern
    if description is not None:
        rules["description"] = description

    try:
        normalized_rules = _normalize_tag_rules(rules)
        saved_path = _save_tag_rules(normalized_rules)
        if sync_finops_policy:
            _sync_policy_required_keys(normalized_required_keys)
        result = {
            "success": True,
            "saved_to": saved_path,
            "policy_synced": sync_finops_policy,
            "policy_file": str(_POLICY_FILE) if sync_finops_policy else None,
            "rules": normalized_rules,
            "note": (
                "规则已保存，后续 tagf_coverage_report / tagf_gap_analysis / "
                "tagf_compliance_check 将自动使用此规则"
            ),
        }
        return json.dumps(result, ensure_ascii=False, indent=2)
    except Exception as e:
        logger.exception("tagf_save_rules 保存失败")
        return json.dumps({
            "success": False,
            "error_code": "SAVE_ERROR",
            "error_msg": str(e),
        }, ensure_ascii=False)


# =============================================================================
# 工具函数 3: 全量资源发现
# =============================================================================


async def tagf_discover_resources(
    resource_types: list[str] = None,
    regions: list[str] = None,
    tag_filter: dict[str, str] = None,
    group_by: str = None,
    max_total: int = 500,
    aggregate_mode: bool = False,
    only_billable: bool = True,
    filter_ack_managed: bool = True,
    **kwargs,
) -> str:
    """全量资源发现 — 使用资源中心跟产品、跟地域盘点云资源。

    默认仅统计可计费资源类型（排除 VPC/VSwitch/SecurityGroup/Listener 等免费资源），
    并过滤 ACK 托管资源（ACK 自动创建的资源通过 ACK 集群统一计费）。

    Args:
        resource_types: 资源类型过滤，如 ["ACS::ECS::Instance"]，为空则使用可计费资源白名单
        regions: 地域过滤，如 ["cn-hangzhou"]，为空则全部地域
        tag_filter: 标签过滤条件（保留参数，暂未实现）
        group_by: 分组维度（保留参数，暂未实现）
        max_total: 安全上限，默认 50000，防止超大账号无限循环
        aggregate_mode: 聚合模式。True 时使用 GetResourceCounts 服务端聚合，
                        不拉取全量资源，适合 9000+ 大规模场景。
        only_billable: 仅统计可计费资源类型（默认 True）
        filter_ack_managed: 过滤 ACK 托管资源（默认 True）
        **kwargs: 框架注入参数（credential 等）

    Returns:
        JSON 字符串：聚合统计或资源清单（含 truncated 标记）
    """
    credential = kwargs.get("credential") or get_credential()

    try:
        rc_client = _build_rc_client(credential)

        if aggregate_mode:
            # 当 only_billable=True 且未指定 resource_types 时，使用可计费资源白名单
            type_filter = resource_types
            if only_billable and type_filter is None:
                type_filter = _get_billable_resource_types()

            by_type_task = _get_resource_counts(
                rc_client, "ResourceType",
                resource_type_filter=type_filter, region_ids=regions,
            )
            by_region_task = _get_resource_counts(
                rc_client, "RegionId",
                resource_type_filter=type_filter, region_ids=regions,
            )
            by_rg_task = _get_resource_counts(
                rc_client, "ResourceGroupId",
                resource_type_filter=type_filter, region_ids=regions,
            )

            counts_by_type, counts_by_region, counts_by_rg = await asyncio.gather(
                by_type_task, by_region_task, by_rg_task,
            )

            total = sum(item["count"] for item in counts_by_type)

            result = {
                "success": True,
                "mode": "aggregate",
                "total_resources": total,
                "by_resource_type": sorted(counts_by_type, key=lambda x: -x["count"]),
                "by_region": sorted(counts_by_region, key=lambda x: -x["count"]),
                "by_resource_group": sorted(counts_by_rg, key=lambda x: -x["count"]),
                "note": "聚合模式仅返回统计数据，如需明细资源列表请设 aggregate_mode=False",
            }
            return json.dumps(result, ensure_ascii=False, indent=2)

        resources, scan_truncated, filter_stats = await _search_resources_paged(
            rc_client,
            resource_type_filter=resource_types,
            region_ids=regions,
            max_total=max_total,
            only_billable=only_billable,
            filter_ack_managed=filter_ack_managed,
        )

        by_type: dict[str, dict] = defaultdict(lambda: {"count": 0, "regions": set()})
        for r in resources:
            rt = r["resource_type"]
            by_type[rt]["count"] += 1
            by_type[rt]["regions"].add(r["region_id"])

        by_type_serializable = {
            rt: {"count": info["count"], "regions": sorted(info["regions"])}
            for rt, info in sorted(by_type.items(), key=lambda x: -x[1]["count"])
        }

        by_region: dict[str, int] = defaultdict(int)
        for r in resources:
            by_region[r["region_id"]] += 1

        with_any_tag = sum(1 for r in resources if r.get("tags"))
        without_tag = len(resources) - with_any_tag

        output_truncated = len(resources) > _DETAIL_OUTPUT_CAP
        output_resources = resources[:_DETAIL_OUTPUT_CAP] if output_truncated else resources

        result = {
            "success": True,
            "mode": "detail",
            "total_resources": len(resources),
            "truncated": scan_truncated,
            "max_total": max_total,
            "by_resource_type": by_type_serializable,
            "by_region": dict(sorted(by_region.items(), key=lambda x: -x[1])),
            "tag_overview": {
                "resources_with_any_tag": with_any_tag,
                "resources_without_tags": without_tag,
                "tag_coverage_percent": round(
                    with_any_tag / len(resources) * 100, 1
                ) if resources else 0.0,
            },
            "resources": output_resources,
            "resources_output_truncated": output_truncated,
        }
        if scan_truncated:
            result["truncation_note"] = (
                f"资源扫描已达安全上限 {max_total} 条并被截断。"
                f"如需获取更多资源，请增加 max_total 参数值。"
            )
        if output_truncated:
            result["output_note"] = (
                f"资源列表已截断为前 {_DETAIL_OUTPUT_CAP} 条（共 {len(resources)} 条）。"
                f"建议使用 resource_types / regions 过滤缩小范围，"
                f"或使用 aggregate_mode=True 获取聚合统计。"
            )
        return json.dumps(result, ensure_ascii=False, indent=2)

    except RuntimeError as e:
        return json.dumps({
            "success": False,
            "error_code": "RESOURCE_CENTER_NOT_OPEN",
            "error_msg": str(e),
        }, ensure_ascii=False)
    except Exception as e:
        logger.exception("tagf_discover_resources 失败")
        return json.dumps({
            "success": False,
            "error_code": "RESOURCE_CENTER_ERROR",
            "error_msg": str(e),
        }, ensure_ascii=False)


# =============================================================================
# 工具函数 4: 标签能力发现
# =============================================================================


async def tagf_discover_capabilities(
    resource_types: list[str] = None,
    region_id: str = "cn-hangzhou",
    **kwargs,
) -> str:
    """标签能力发现 — 查询各资源类型支持的标签能力项。

    Args:
        resource_types: 资源类型过滤（保留参数）
        region_id: 地域 ID，默认 cn-hangzhou
        **kwargs: 框架注入参数

    Returns:
        JSON 字符串：各资源类型的标签能力矩阵
    """
    credential = kwargs.get("credential") or get_credential()

    try:
        tag_client = _build_tag_client(credential, region_id)

        all_types = []
        next_token = None
        max_rounds = 50

        for _ in range(max_rounds):
            req = tag_models.ListSupportResourceTypesRequest(
                region_id=region_id,
                show_items=True,
                max_result=_LIST_TYPES_PAGE_SIZE,
                next_token=next_token,
            )

            resp = await asyncio.to_thread(
                tag_client.list_support_resource_types, req
            )

            if resp.body and resp.body.support_resource_types:
                for srt in resp.body.support_resource_types:
                    capabilities = {}
                    if srt.support_items:
                        for item in srt.support_items:
                            capabilities[item.support_code] = item.support

                    all_types.append({
                        "product_code": srt.product_code or "",
                        "resource_type": srt.resource_type or "",
                        "capabilities": capabilities,
                    })

            next_token = resp.body.next_token if resp.body else None
            if not next_token:
                break

        by_product: dict[str, list[str]] = defaultdict(list)
        for t in all_types:
            by_product[t["product_code"]].append(t["resource_type"])

        result = {
            "success": True,
            "region_id": region_id,
            "total_supported_types": len(all_types),
            "resource_types": all_types,
            "summary_by_product": {
                k: sorted(v) for k, v in sorted(by_product.items())
            },
        }
        return json.dumps(result, ensure_ascii=False, indent=2)

    except Exception as e:
        logger.exception("tagf_discover_capabilities 失败")
        return json.dumps({
            "success": False,
            "error_code": "TAG_API_ERROR",
            "error_msg": str(e),
        }, ensure_ascii=False)


# =============================================================================
# 工具函数 5: 标签覆盖率报告
# =============================================================================


async def tagf_coverage_report(
    required_keys: list[str] = None,
    resource_types: list[str] = None,
    regions: list[str] = None,
    top_n: Optional[int] = None,
    max_total: int = 500,
    max_results: int = None,
    only_billable: bool = True,
    filter_ack_managed: bool = True,
    **kwargs,
) -> str:
    """标签覆盖率报告 — 分析各产品的必选标签覆盖情况。

    默认仅统计可计费资源类型（排除 VPC/VSwitch/SecurityGroup 等免费资源），
    并过滤 ACK 托管资源（ACK 自动创建的资源通过 ACK 集群统一计费）。

    Args:
        required_keys: 必选标签键列表，默认从已保存的标签规则加载
        resource_types: 资源类型过滤（Resource Center 格式）
        regions: 地域过滤
        top_n: 未打标资源展示数量，默认 30
        max_total: 安全上限，默认 50000，防止超大账号无限循环
        max_results: max_total 的别名（兼容参数）
        only_billable: 仅统计可计费资源类型（默认 True）
        filter_ack_managed: 过滤 ACK 托管资源（默认 True）
        **kwargs: 框架注入参数

    Returns:
        JSON 字符串：覆盖率统计 + Top N 未打标资源列表（含 truncated 标记）
    """
    # 兼容 max_results 参数名
    if max_results is not None:
        max_total = max_results
    credential = kwargs.get("credential") or get_credential()
    rules, rules_source, linked_strategy = _load_tag_rules_with_source()
    if not required_keys:
        required_keys = list(rules.get("required_keys", ["env"]))
    else:
        required_keys = _normalize_required_keys(required_keys)

    policy_defaults = _load_policy_defaults()
    effective_top_n = top_n
    if effective_top_n is None:
        effective_top_n = policy_defaults["tag_report_top_n"]
    if effective_top_n == 0:
        effective_top_n = len(required_keys) * 1000 or 1000

    try:
        rc_client = _build_rc_client(credential)
        resources, scan_truncated, filter_stats = await _search_resources_paged(
            rc_client,
            resource_type_filter=resource_types,
            region_ids=regions,
            max_total=max_total,
            only_billable=only_billable,
            filter_ack_managed=filter_ack_managed,
        )

        coverage = _compute_coverage(resources, required_keys)

        untagged = []
        for r in resources:
            tags = r.get("tags", {})
            missing = [k for k in required_keys if not _has_tag_key(tags, k)]
            if missing:
                untagged.append({
                    "resource_id": r["resource_id"],
                    "resource_type": r["resource_type"],
                    "resource_name": r["resource_name"],
                    "region_id": r["region_id"],
                    "resource_arn": r["resource_arn"],
                    "missing_keys": missing,
                    "existing_tags": tags,
                    "missing_key_count": len(missing),
                })

        untagged.sort(key=lambda x: -x["missing_key_count"])
        top_untagged = untagged[:effective_top_n]
        for item in top_untagged:
            del item["missing_key_count"]

        total_missing = len(untagged)
        recommendation = ""
        if total_missing > 0:
            recommendation = (
                f"{total_missing} 个资源缺少必选标签，"
                f"建议使用 tagf_gap_analysis 分析治理可行性后批量打标"
            )

        result = {
            "success": True,
            "required_keys": required_keys,
            "rules_source": rules_source,
            "linked_finops_strategy": linked_strategy,
            "truncated": scan_truncated,
            "max_total": max_total,
            "filter_settings": {
                "only_billable": only_billable,
                "filter_ack_managed": filter_ack_managed,
            },
            "filter_stats": filter_stats,
            "overall_coverage": {
                "total_resources": coverage["total_resources"],
                "fully_tagged": coverage["fully_tagged"],
                "coverage_percent": coverage["coverage_percent"],
            },
            "coverage_by_key": coverage["by_key"],
            "coverage_by_product": coverage["by_product"],
            "top_untagged_resources": top_untagged,
            "top_n": effective_top_n,
            "total_untagged": total_missing,
            "recommendation": recommendation,
        }
        if scan_truncated:
            result["truncation_note"] = (
                f"资源扫描已达安全上限 {max_total} 条并被截断。"
                f"覆盖率统计可能不完整，如需全量分析请增加 max_total 参数值。"
            )
        return json.dumps(result, ensure_ascii=False, indent=2)

    except RuntimeError as e:
        return json.dumps({
            "success": False,
            "error_code": "RESOURCE_CENTER_NOT_OPEN",
            "error_msg": str(e),
        }, ensure_ascii=False)
    except Exception as e:
        logger.exception("tagf_coverage_report 失败")
        return json.dumps({
            "success": False,
            "error_code": "RESOURCE_CENTER_ERROR",
            "error_msg": str(e),
        }, ensure_ascii=False)


# =============================================================================
# 工具函数 6: 标签差距分析
# =============================================================================


async def tagf_gap_analysis(
    required_keys: list[str] = None,
    resource_types: list[str] = None,
    regions: list[str] = None,
    max_total: int = 500,
    only_billable: bool = True,
    filter_ack_managed: bool = True,
    **kwargs,
) -> str:
    """标签差距分析 — 交叉比对资源与统一 Tag API 能力，输出治理计划。

    默认仅统计可计费资源类型，并过滤 ACK 托管资源。

    Args:
        required_keys: 必选标签键列表，默认从已保存的标签规则加载
        resource_types: 资源类型过滤，如 ["ACS::ECS::Instance"]，为空则使用可计费资源白名单
        regions: 地域过滤
        max_total: 安全上限，默认 50000
        only_billable: 仅统计可计费资源类型（默认 True）
        filter_ack_managed: 过滤 ACK 托管资源（默认 True）
        **kwargs: 框架注入参数

    Returns:
        JSON 字符串：可治理/不可治理/已覆盖分类 + 优先级治理计划（含 truncated 标记）
    """
    credential = kwargs.get("credential") or get_credential()
    rules, rules_source, linked_strategy = _load_tag_rules_with_source()
    if not required_keys:
        required_keys = list(rules.get("required_keys", ["env"]))
    else:
        required_keys = _normalize_required_keys(required_keys)

    try:
        rc_client = _build_rc_client(credential)
        tag_client = _build_tag_client(credential, "cn-hangzhou")

        resources_task = _search_resources_paged(
            rc_client,
            resource_type_filter=resource_types,
            region_ids=regions,
            max_total=max_total,
            only_billable=only_billable,
            filter_ack_managed=filter_ack_managed,
        )

        (resources, scan_truncated, filter_stats), capabilities_by_type = await asyncio.gather(
            resources_task,
            _fetch_supported_type_capabilities(tag_client),
        )

        actionable = []
        unsupported = []
        fully_covered = []

        for r in resources:
            tags = r.get("tags", {})
            missing = [k for k in required_keys if not _has_tag_key(tags, k)]

            if not missing:
                fully_covered.append(r)
                continue

            capability = capabilities_by_type.get(r["resource_type"], {})
            if (
                capability.get("TAG_API_SUPPORT", False)
                or r["resource_type"] in capabilities_by_type
            ):
                actionable.append({**r, "_missing": missing, "_capability": capability})
            else:
                unsupported.append({**r, "_missing": missing, "_capability": capability})

        actionable_by_product: dict[str, dict] = defaultdict(
            lambda: {
                "count": 0,
                "missing_keys_dist": defaultdict(int),
                "arns": [],
                "tag_bill_support": False,
                "preventive_check_support": False,
                "remediation_support": False,
            }
        )
        for r in actionable:
            rt = r["resource_type"]
            actionable_by_product[rt]["count"] += 1
            actionable_by_product[rt]["arns"].append(r["resource_arn"])
            capability = r.get("_capability", {})
            actionable_by_product[rt]["tag_bill_support"] = capability.get(
                "TAG_BILL_SUPPORT", False
            )
            actionable_by_product[rt]["preventive_check_support"] = capability.get(
                "TAG_POLICY_PREVENTATIVE_CHECK_SUPPORT", False
            )
            actionable_by_product[rt]["remediation_support"] = capability.get(
                "TAG_POLICY_CHECK_REMEDIATION_SUPPORT", False
            )
            for k in r["_missing"]:
                actionable_by_product[rt]["missing_keys_dist"][k] += 1

        actionable_products = sorted(
            [
                {
                    "resource_type": rt,
                    "count": info["count"],
                    "missing_keys_distribution": dict(info["missing_keys_dist"]),
                    "sample_arns": info["arns"][:5],
                    "actionable": True,
                    "supports_cost_allocation": info["tag_bill_support"],
                    "supports_preventive_policy": info["preventive_check_support"],
                    "supports_policy_remediation": info["remediation_support"],
                }
                for rt, info in actionable_by_product.items()
            ],
            key=lambda x: -x["count"],
        )

        unsupported_by_product: dict[str, dict] = defaultdict(
            lambda: {"count": 0, "has_capability_record": False}
        )
        for r in unsupported:
            unsupported_by_product[r["resource_type"]]["count"] += 1
            unsupported_by_product[r["resource_type"]]["has_capability_record"] = bool(
                r.get("_capability")
            )

        unsupported_products = sorted(
            [
                {
                    "resource_type": rt,
                    "count": info["count"],
                    "note": (
                        "统一 Tag API 不支持此类型，需使用产品级 SDK（Phase-2）"
                        if info["has_capability_record"]
                        else "当前未查到标签能力信息，建议先验证该产品的标签 API 或产品 SDK"
                    ),
                }
                for rt, info in unsupported_by_product.items()
            ],
            key=lambda x: -x["count"],
        )

        remediation_plan = []
        for i, p in enumerate(actionable_products, 1):
            batches = math.ceil(p["count"] / _TAG_BATCH_SIZE)
            remediation_plan.append({
                "priority": i,
                "action": "tagf_batch_tag",
                "resource_type": p["resource_type"],
                "scope": f"{p['count']} 个资源缺少 {list(p['missing_keys_distribution'].keys())}",
                "estimated_batches": batches,
                "post_tag_handoff": (
                    "该资源类型支持费用标签，建议 T+1 后使用 cost_query_by_tag 验证成本归集"
                    if p["supports_cost_allocation"]
                    else "该资源类型未声明费用标签能力，建议先完成治理再做成本侧验证"
                ),
            })

        bill_supported_actionable = sum(
            item["count"] for item in actionable_products
            if item["supports_cost_allocation"]
        )
        next_steps = []
        if actionable_products:
            next_steps.append(
                "先针对 remediation_plan Top 1-3 产品执行 dry_run，确认批量打标范围与标签值"
            )
        if bill_supported_actionable:
            next_steps.append(
                "完成打标后等待 T+1，同步到费用标签后再使用 aliyun-cost 做按标签分账验证"
            )
        next_steps.append(
            "如需持续巡检，建议创建 scheduler 模板 weekly_tag_governance"
        )

        result = {
            "success": True,
            "required_keys": required_keys,
            "rules_source": rules_source,
            "linked_finops_strategy": linked_strategy,
            "truncated": scan_truncated,
            "max_total": max_total,
            "summary": {
                "total_resources": len(resources),
                "actionable_via_unified_api": len(actionable),
                "requires_product_api": len(unsupported),
                "fully_covered": len(fully_covered),
                "actionable_with_cost_allocation_support": bill_supported_actionable,
            },
            "actionable_gap": {
                "total_missing": len(actionable),
                "by_product": actionable_products,
            },
            "unsupported_products": unsupported_products,
            "remediation_plan": remediation_plan,
            "next_steps": next_steps,
        }
        if scan_truncated:
            result["truncation_note"] = (
                f"资源扫描已达安全上限 {max_total} 条并被截断。"
                f"差距分析可能不完整，如需全量分析请增加 max_total 参数值。"
            )
        return json.dumps(result, ensure_ascii=False, indent=2)

    except RuntimeError as e:
        return json.dumps({
            "success": False,
            "error_code": "RESOURCE_CENTER_NOT_OPEN",
            "error_msg": str(e),
        }, ensure_ascii=False)
    except Exception as e:
        logger.exception("tagf_gap_analysis 失败")
        return json.dumps({
            "success": False,
            "error_code": "API_ERROR",
            "error_msg": str(e),
        }, ensure_ascii=False)


# =============================================================================
# 工具函数 7: 跨产品批量打标
# =============================================================================


async def tagf_batch_tag(
    resources: list[str],
    tags: dict[str, str],
    region_id: str = "cn-hangzhou",
    dry_run: bool = True,
    **kwargs,
) -> str:
    """跨产品批量打标 — 使用统一 Tag API 为多种资源添加标签。

    Args:
        resources: ARN 列表（来自 tagf_discover_resources 的发现结果）
        tags: 要添加的标签，如 {"env": "prod", "team": "data"}
        region_id: 默认 region（多 region 场景会从 ARN 自动解析分组）
        dry_run: 仅预览不执行，默认 True
        **kwargs: 框架注入参数

    Returns:
        JSON 字符串：打标计划（dry_run）或执行结果
    """
    credential = kwargs.get("credential") or get_credential()

    if not resources:
        return json.dumps({
            "success": False,
            "error_code": "INVALID_PARAM",
            "error_msg": "resources 不能为空",
        }, ensure_ascii=False)

    if not tags:
        return json.dumps({
            "success": False,
            "error_code": "INVALID_PARAM",
            "error_msg": "tags 不能为空",
        }, ensure_ascii=False)

    rules, rules_source, linked_strategy = _load_tag_rules_with_source()
    validation_errors = _validate_tags_against_rules(tags, rules)
    if validation_errors:
        return json.dumps({
            "success": False,
            "error_code": "RULE_VALIDATION_FAILED",
            "error_msg": "待写入标签不符合当前治理规则",
            "rules_source": rules_source,
            "linked_finops_strategy": linked_strategy,
            "validation_errors": validation_errors,
            "active_rules": rules,
        }, ensure_ascii=False, indent=2)

    by_region: dict[str, list[str]] = defaultdict(list)
    for arn in resources:
        r = _parse_arn_region(arn)
        if not r or r == "*":
            r = region_id
        by_region[r].append(arn)

    plan_by_region = {}
    for r, arns in sorted(by_region.items()):
        plan_by_region[r] = {
            "count": len(arns),
            "batches": math.ceil(len(arns) / _TAG_BATCH_SIZE),
        }

    if dry_run:
        by_product: dict[str, int] = defaultdict(int)
        for arn in resources:
            product = _parse_arn_product(arn)
            by_product[product] += 1

        result = {
            "success": True,
            "mode": "dry_run",
            "plan": {
                "total_resources": len(resources),
                "tags_to_add": tags,
                "by_region": plan_by_region,
                "by_product": dict(sorted(by_product.items())),
                "total_batches": sum(v["batches"] for v in plan_by_region.values()),
            },
            "rules_source": rules_source,
            "linked_finops_strategy": linked_strategy,
            "next_step": "确认后请调用 tagf_batch_tag(dry_run=False) 执行打标",
        }
        return json.dumps(result, ensure_ascii=False, indent=2)

    try:
        tag_list = [
            tag_models.TagResourcesRequestTags(key=k, value=v)
            for k, v in tags.items()
        ]

        async def _process_region(r: str, arns: list[str]) -> tuple[str, dict]:
            tag_client = _build_tag_client(credential, r)
            region_result = await _tag_region_batch(tag_client, r, arns, tag_list)
            return r, region_result

        tasks = [_process_region(r, arns) for r, arns in by_region.items()]
        region_task_results = await asyncio.gather(*tasks)

        total_tagged = 0
        total_failed = 0
        region_results = {}
        all_failed_arns = []
        retryable_count = 0

        for r, r_result in region_task_results:
            total_tagged += r_result["tagged"]
            total_failed += r_result["failed"]
            all_failed_arns.extend(r_result["failed_arns"])
            for err in r_result["errors"]:
                if err.get("retryable"):
                    retryable_count += err["batch_size"]
            region_results[r] = {
                "tagged": r_result["tagged"],
                "failed": r_result["failed"],
                "errors": r_result["errors"],
                "failed_arns": r_result["failed_arns"],
            }

        result = {
            "success": total_failed == 0,
            "mode": "execute",
            "result": {
                "total_resources": len(resources),
                "tagged_count": total_tagged,
                "failed_count": total_failed,
                "tags_added": tags,
                "by_region": region_results,
                "failed_arns": all_failed_arns,
                "retryable_count": retryable_count,
                "hint": (
                    "可将 failed_arns 作为 resources 重新调用 tagf_batch_tag 重试"
                ) if all_failed_arns else None,
            },
        }
        return json.dumps(result, ensure_ascii=False, indent=2)

    except Exception as e:
        logger.exception("tagf_batch_tag 执行失败")
        return json.dumps({
            "success": False,
            "error_code": "TAG_API_ERROR",
            "error_msg": str(e),
        }, ensure_ascii=False)


# =============================================================================
# 工具函数 8: 合规检查（合并覆盖率和一致性检查）
# =============================================================================


async def tagf_compliance_check(
    required_keys: list[str] = None,
    key_whitelist: dict[str, list[str]] = None,
    resource_types: list[str] = None,
    regions: list[str] = None,
    max_total: int = 500,
    sample_limit: int = 30,
    only_billable: bool = True,
    filter_ack_managed: bool = True,
    **kwargs,
) -> str:
    """标签合规检查 — 综合检查覆盖率和值一致性。

    默认仅统计可计费资源类型，并过滤 ACK 托管资源。

    合并 ra_tag_coverage_report 和 ra_tag_consistency_check 的功能：
    - 检查必选标签覆盖率
    - 检查标签值是否在白名单内
    - 检查标签键命名规范
    - 检查标签键/值的大小写和格式一致性

    Args:
        required_keys: 必选标签键列表，默认从已保存的标签规则加载
        key_whitelist: 标签值白名单，默认从已保存的标签规则加载
        resource_types: 资源类型过滤
        regions: 地域过滤
        max_total: 安全上限，默认 50000
        sample_limit: 不合规样例返回数量，默认 30
        only_billable: 仅统计可计费资源类型（默认 True）
        filter_ack_managed: 过滤 ACK 托管资源（默认 True）
        **kwargs: 框架注入参数

    Returns:
        JSON 字符串：合规检查结果（覆盖率 + 一致性问题，含 truncated 标记）
    """
    credential = kwargs.get("credential") or get_credential()
    rules, rules_source, linked_strategy = _load_tag_rules_with_source()

    # 合并参数和规则
    if required_keys:
        rules["required_keys"] = _normalize_required_keys(required_keys)
    if key_whitelist:
        rules["key_whitelist"] = _normalize_key_whitelist(key_whitelist)

    try:
        rc_client = _build_rc_client(credential)
        resources, scan_truncated, filter_stats = await _search_resources_paged(
            rc_client,
            resource_type_filter=resource_types,
            region_ids=regions,
            max_total=max_total,
            only_billable=only_billable,
            filter_ack_managed=filter_ack_managed,
        )

        pattern = re.compile(rules["key_naming_pattern"])
        issues = []
        summary = {
            "missing_required_keys": 0,
            "invalid_key_names": 0,
            "invalid_whitelist_values": 0,
        }
        by_product: dict[str, dict[str, int]] = defaultdict(
            lambda: {
                "resources_with_issues": 0,
                "missing_required_keys": 0,
                "invalid_key_names": 0,
                "invalid_whitelist_values": 0,
            }
        )

        # 一致性检查数据结构
        key_groups: dict[str, set] = {}
        key_resource_count: dict[str, int] = {}
        value_groups: dict[str, set] = {}
        value_resource_count: dict[str, int] = {}
        env_keys = {"env", "Env", "ENV", "environment", "Environment"}

        for resource in resources:
            tags = resource.get("tags", {})

            # 收集一致性检查数据
            for key, value in tags.items():
                norm_key = _KEY_NORMALIZATION.get(key, key.lower())
                if norm_key not in key_groups:
                    key_groups[norm_key] = set()
                key_groups[norm_key].add(key)
                key_resource_count[key] = key_resource_count.get(key, 0) + 1

                if key in env_keys:
                    norm_val = _VALUE_NORMALIZATION.get(value, value.lower())
                    if norm_val not in value_groups:
                        value_groups[norm_val] = set()
                    value_groups[norm_val].add(value)
                    value_resource_count[value] = value_resource_count.get(value, 0) + 1

            # 覆盖率检查
            missing_keys = [
                key for key in rules["required_keys"] if not _has_tag_key(tags, key)
            ]
            invalid_key_names = [
                key
                for key in tags
                if not key.startswith("acs:") and not pattern.match(key)
            ]
            invalid_whitelist_values = []
            for key, allowed_values in rules.get("key_whitelist", {}).items():
                if not allowed_values:
                    continue
                value = _find_tag_value(tags, key)
                if value is not None and value not in allowed_values:
                    invalid_whitelist_values.append({
                        "key": key,
                        "value": value,
                        "allowed_values": allowed_values,
                    })

            if not (missing_keys or invalid_key_names or invalid_whitelist_values):
                continue

            product_stats = by_product[resource["resource_type"]]
            product_stats["resources_with_issues"] += 1

            if missing_keys:
                summary["missing_required_keys"] += 1
                product_stats["missing_required_keys"] += 1
            if invalid_key_names:
                summary["invalid_key_names"] += 1
                product_stats["invalid_key_names"] += 1
            if invalid_whitelist_values:
                summary["invalid_whitelist_values"] += 1
                product_stats["invalid_whitelist_values"] += 1

            issues.append({
                "resource_id": resource["resource_id"],
                "resource_type": resource["resource_type"],
                "resource_name": resource["resource_name"],
                "region_id": resource["region_id"],
                "resource_arn": resource["resource_arn"],
                "missing_required_keys": missing_keys,
                "invalid_key_names": invalid_key_names,
                "invalid_whitelist_values": invalid_whitelist_values,
                "existing_tags": tags,
            })

        issues.sort(
            key=lambda item: (
                -len(item["missing_required_keys"]),
                -len(item["invalid_whitelist_values"]),
                -len(item["invalid_key_names"]),
            )
        )

        # 分析一致性问题
        key_inconsistencies = []
        for norm_key, variants in key_groups.items():
            if len(variants) > 1:
                key_inconsistencies.append({
                    "normalized_key": norm_key,
                    "variants": sorted(variants),
                    "recommendation": f"建议统一为 '{norm_key}'",
                    "variant_counts": {
                        v: key_resource_count.get(v, 0) for v in variants
                    },
                })

        value_inconsistencies = []
        for norm_val, variants in value_groups.items():
            if len(variants) > 1:
                value_inconsistencies.append({
                    "normalized_value": norm_val,
                    "variants": sorted(variants),
                    "recommendation": f"建议统一为 '{norm_val}'",
                    "variant_counts": {
                        v: value_resource_count.get(v, 0) for v in variants
                    },
                })

        # 计算覆盖率
        coverage = _compute_coverage(resources, rules["required_keys"])

        # 计算合规率（完全合规 + 有任意问题）
        fully_compliant = coverage["fully_tagged"]
        resources_with_issues = len(issues)

        result = {
            "success": True,
            "rules_source": rules_source,
            "linked_finops_strategy": linked_strategy,
            "rules": rules,
            "truncated": scan_truncated,
            "max_total": max_total,
            "summary": {
                # 基础统计
                "total_resources": len(resources),
                # 合规状态（互斥）
                "fully_compliant_resources": fully_compliant,
                "resources_with_any_issues": resources_with_issues,
                "fully_compliant_percent": coverage["coverage_percent"],
                # 问题分类统计（可能重叠，因为一个资源可能有多种问题）
                "issue_breakdown": {
                    "missing_required_keys": summary["missing_required_keys"],
                    "invalid_key_names": summary["invalid_key_names"],
                    "invalid_whitelist_values": summary["invalid_whitelist_values"],
                },
                # 注意：问题分类统计可能重叠，如需准确数字请参考上述互斥统计
            },
            "coverage": {
                "total_resources": coverage["total_resources"],
                "fully_tagged": coverage["fully_tagged"],
                "coverage_percent": coverage["coverage_percent"],
                "by_key": coverage["by_key"],
            },
            "compliance_summary": {
                "total_resources": len(resources),
                "non_compliant_resources": len(issues),
                **summary,
            },
            "consistency_summary": {
                "inconsistent_key_groups": len(key_inconsistencies),
                "inconsistent_value_groups": len(value_inconsistencies),
                "total_consistency_issues": len(key_inconsistencies) + len(value_inconsistencies),
            },
            "by_product": dict(
                sorted(
                    by_product.items(),
                    key=lambda item: -item[1]["resources_with_issues"],
                )
            ),
            "key_inconsistencies": key_inconsistencies,
            "value_inconsistencies": value_inconsistencies,
            "compliance_samples": issues[:sample_limit],
            "sample_limit": sample_limit,
            "next_step": (
                "先用 tagf_gap_analysis 确认可治理资源，再使用 "
                "tagf_batch_tag(dry_run=True) 预览修复计划"
            ) if issues else "未发现不合规资源，建议接入 scheduler 做持续巡检",
        }
        if scan_truncated:
            result["truncation_note"] = (
                f"资源扫描已达安全上限 {max_total} 条并被截断。"
                f"合规检查可能不完整，如需全量分析请增加 max_total 参数值。"
            )
        return json.dumps(result, ensure_ascii=False, indent=2)

    except RuntimeError as e:
        return json.dumps({
            "success": False,
            "error_code": "RESOURCE_CENTER_NOT_OPEN",
            "error_msg": str(e),
        }, ensure_ascii=False)
    except Exception as e:
        logger.exception("tagf_compliance_check 失败")
        return json.dumps({
            "success": False,
            "error_code": "COMPLIANCE_CHECK_ERROR",
            "error_msg": str(e),
        }, ensure_ascii=False)

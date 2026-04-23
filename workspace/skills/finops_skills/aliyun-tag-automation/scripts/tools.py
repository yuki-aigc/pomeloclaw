# -*- coding: utf-8 -*-
"""阿里云标签自动化规则引擎。

基于确定性规则自动推断和传播标签：
- 规则管理：创建、更新、删除自动化规则
- 多种规则类型：创建者映射、名称前缀推断、资源组映射、VPC归属
- 规则执行：支持 dry_run 预览和实际执行
- 执行历史：查询规则执行历史
"""

import asyncio
import json
import logging
import re
import uuid
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

from pydantic import BaseModel

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
_RC_SCAN_LIMIT = 20000

_DATA_DIR = Path.home() / ".copaw" / "data"
_RULES_FILE = _DATA_DIR / "tag_automation_rules.json"
_HISTORY_FILE = _DATA_DIR / "tag_automation_history.json"

# 支持的规则类型
SUPPORTED_RULE_TYPES = [
    "creator_to_team",
    "name_prefix_to_env",
    "resource_group_mapping",
    "vpc_to_team",
]


# =============================================================================
# 数据模型
# =============================================================================


class TagAutomationRule(BaseModel):
    """标签自动化规则数据模型。"""
    rule_id: str
    name: str
    enabled: bool = True
    rule_type: str  # creator_to_team | name_prefix_to_env | resource_group_mapping | vpc_to_team
    priority: int = 1
    config: dict = {}  # 规则特定配置
    scope: dict = {"resource_types": [], "regions": []}
    alert_channels: list[str] = []
    last_execution: dict | None = None
    created_at: str = ""
    updated_at: str = ""


# =============================================================================
# 持久化辅助函数
# =============================================================================


def _load_rules() -> list[dict]:
    """加载所有自动化规则。"""
    if not _RULES_FILE.exists():
        return []
    try:
        data = json.loads(_RULES_FILE.read_text(encoding="utf-8"))
        return data.get("rules", [])
    except Exception as e:
        logger.warning("加载规则文件失败: %s", e)
        return []


def _save_rules(rules: list[dict]) -> None:
    """保存规则到文件。"""
    _DATA_DIR.mkdir(parents=True, exist_ok=True)
    _RULES_FILE.write_text(
        json.dumps({"rules": rules}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def _load_history() -> list[dict]:
    """加载执行历史。"""
    if not _HISTORY_FILE.exists():
        return []
    try:
        data = json.loads(_HISTORY_FILE.read_text(encoding="utf-8"))
        return data.get("history", [])
    except Exception as e:
        logger.warning("加载历史文件失败: %s", e)
        return []


def _save_history(history: list[dict]) -> None:
    """保存执行历史。"""
    _DATA_DIR.mkdir(parents=True, exist_ok=True)
    # 只保留最近 1000 条历史
    history = history[-1000:]
    _HISTORY_FILE.write_text(
        json.dumps({"history": history}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def _generate_rule_id() -> str:
    """生成规则 ID。"""
    return f"rule-{uuid.uuid4().hex[:12]}"


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
# 规则执行逻辑
# =============================================================================


def _apply_creator_to_team_rule(
    resource: dict,
    config: dict,
) -> Optional[dict[str, str]]:
    """应用创建者到团队映射规则。"""
    creator_team_map = config.get("creator_team_map", {})
    # 注意：Resource Center 不直接返回创建者信息
    # 这里模拟实现，实际应该通过 ActionTrail 或其他方式获取创建者
    # 暂时使用 account_id 的后缀作为模拟
    account_id = resource.get("account_id", "")
    if not account_id:
        return None

    for creator, team in creator_team_map.items():
        if creator in account_id or creator == account_id:
            existing_team = resource.get("tags", {}).get("team")
            if not existing_team:
                return {"team": team}
    return None


def _apply_name_prefix_to_env_rule(
    resource: dict,
    config: dict,
) -> Optional[dict[str, str]]:
    """应用名称前缀到环境映射规则。"""
    prefix_env_map = config.get("prefix_env_map", {})
    resource_name = resource.get("resource_name", "").lower()
    if not resource_name:
        return None

    for prefix, env in prefix_env_map.items():
        if resource_name.startswith(prefix.lower()):
            existing_env = resource.get("tags", {}).get("env")
            if not existing_env:
                return {"env": env}
    return None


def _apply_resource_group_mapping_rule(
    resource: dict,
    config: dict,
) -> Optional[dict[str, str]]:
    """应用资源组映射规则。"""
    rg_tag_map = config.get("rg_tag_map", {})
    resource_group_id = resource.get("resource_group_id", "")
    if not resource_group_id:
        return None

    for rg_id, tags in rg_tag_map.items():
        if rg_id == resource_group_id:
            # 只添加资源不存在的标签
            existing_tags = resource.get("tags", {})
            new_tags = {}
            for key, value in tags.items():
                if key not in existing_tags:
                    new_tags[key] = value
            return new_tags if new_tags else None
    return None


def _apply_vpc_to_team_rule(
    resource: dict,
    config: dict,
) -> Optional[dict[str, str]]:
    """应用 VPC 到团队映射规则。"""
    vpc_team_map = config.get("vpc_team_map", {})
    # 从标签中查找 VPC 信息（部分资源会有 acs:vpc:instance-id 之类的标签）
    tags = resource.get("tags", {})

    # 尝试从标签中提取 VPC ID
    vpc_id = None
    for key, value in tags.items():
        if "vpc" in key.lower():
            vpc_id = value
            break

    if not vpc_id:
        return None

    for vpc, team in vpc_team_map.items():
        if vpc == vpc_id or vpc in vpc_id:
            existing_team = tags.get("team")
            if not existing_team:
                return {"team": team}
    return None


def _apply_rule(rule: dict, resource: dict) -> Optional[dict[str, str]]:
    """应用规则到资源，返回推断的标签。"""
    rule_type = rule.get("rule_type")
    config = rule.get("config", {})

    if rule_type == "creator_to_team":
        return _apply_creator_to_team_rule(resource, config)
    elif rule_type == "name_prefix_to_env":
        return _apply_name_prefix_to_env_rule(resource, config)
    elif rule_type == "resource_group_mapping":
        return _apply_resource_group_mapping_rule(resource, config)
    elif rule_type == "vpc_to_team":
        return _apply_vpc_to_team_rule(resource, config)
    else:
        logger.warning("未知规则类型: %s", rule_type)
        return None


async def _execute_rule(
    rule: dict,
    credential,
    dry_run: bool = True,
    max_total: int = 500,
) -> dict:
    """执行单个规则。"""
    scope = rule.get("scope", {})
    resource_types = scope.get("resource_types", [])
    regions = scope.get("regions", [])

    rc_client = _build_rc_client(credential)
    resources, scan_truncated = await _search_resources_paged(
        rc_client,
        resource_type_filter=resource_types if resource_types else None,
        region_ids=regions if regions else None,
        max_total=max_total,
    )

    suggestions = []
    for resource in resources:
        inferred_tags = _apply_rule(rule, resource)
        if inferred_tags:
            suggestions.append({
                "resource_arn": resource["resource_arn"],
                "resource_id": resource["resource_id"],
                "resource_name": resource["resource_name"],
                "resource_type": resource["resource_type"],
                "region_id": resource["region_id"],
                "inferred_tags": inferred_tags,
                "existing_tags": resource.get("tags", {}),
            })

    result = {
        "rule_id": rule["rule_id"],
        "rule_name": rule["name"],
        "rule_type": rule["rule_type"],
        "total_resources_scanned": len(resources),
        "matched_resources": len(suggestions),
        "truncated": scan_truncated,
        "max_total": max_total,
        "suggestions": suggestions[:100],  # 限制返回数量
        "suggestions_truncated": len(suggestions) > 100,
    }

    if not dry_run and suggestions:
        # 实际执行打标
        by_region: dict[str, list[dict]] = defaultdict(list)
        for s in suggestions:
            region = s["region_id"]
            by_region[region].append(s)

        total_tagged = 0
        total_failed = 0
        errors = []

        for region, region_suggestions in by_region.items():
            tag_client = _build_tag_client(credential, region)
            for s in region_suggestions:
                try:
                    tag_list = [
                        tag_models.TagResourcesRequestTags(key=k, value=v)
                        for k, v in s["inferred_tags"].items()
                    ]
                    req = tag_models.TagResourcesRequest(
                        region_id=region,
                        resource_arn=[s["resource_arn"]],
                        tags=tag_list,
                    )
                    await asyncio.to_thread(tag_client.tag_resources, req)
                    total_tagged += 1
                except Exception as e:
                    total_failed += 1
                    errors.append({
                        "resource_arn": s["resource_arn"],
                        "error": str(e),
                    })

        result["execution_result"] = {
            "tagged_count": total_tagged,
            "failed_count": total_failed,
            "errors": errors[:20],  # 限制错误数量
        }

    return result


# =============================================================================
# 工具函数 1: 列出所有规则
# =============================================================================


async def taga_list_rules(**kwargs) -> str:
    """列出所有标签自动化规则。

    Returns:
        JSON 字符串：规则列表
    """
    rules = _load_rules()

    result = {
        "success": True,
        "total_rules": len(rules),
        "rules": rules,
        "supported_rule_types": SUPPORTED_RULE_TYPES,
        "rules_file": str(_RULES_FILE),
    }
    return json.dumps(result, ensure_ascii=False, indent=2)


# =============================================================================
# 工具函数 2: 创建规则
# =============================================================================


async def taga_create_rule(
    name: str,
    rule_type: str,
    config: dict,
    scope: dict = None,
    priority: int = 1,
    alert_channels: list[str] = None,
    **kwargs,
) -> str:
    """创建新的标签自动化规则。

    Args:
        name: 规则名称
        rule_type: 规则类型 (creator_to_team | name_prefix_to_env | resource_group_mapping | vpc_to_team)
        config: 规则配置
        scope: 作用范围 {"resource_types": [], "regions": []}
        priority: 优先级（数字越小优先级越高）
        alert_channels: 告警渠道列表
        **kwargs: 框架注入参数

    Returns:
        JSON 字符串：创建结果
    """
    if not name:
        return json.dumps({
            "success": False,
            "error_code": "INVALID_PARAM",
            "error_msg": "name 不能为空",
        }, ensure_ascii=False)

    if rule_type not in SUPPORTED_RULE_TYPES:
        return json.dumps({
            "success": False,
            "error_code": "INVALID_RULE_TYPE",
            "error_msg": f"不支持的规则类型: {rule_type}，支持: {SUPPORTED_RULE_TYPES}",
        }, ensure_ascii=False)

    if not config:
        return json.dumps({
            "success": False,
            "error_code": "INVALID_PARAM",
            "error_msg": "config 不能为空",
        }, ensure_ascii=False)

    now = datetime.now().isoformat()
    rule = TagAutomationRule(
        rule_id=_generate_rule_id(),
        name=name,
        enabled=True,
        rule_type=rule_type,
        priority=priority,
        config=config,
        scope=scope or {"resource_types": [], "regions": []},
        alert_channels=alert_channels or [],
        last_execution=None,
        created_at=now,
        updated_at=now,
    )

    rules = _load_rules()
    rules.append(rule.model_dump())
    _save_rules(rules)

    return json.dumps({
        "success": True,
        "rule": rule.model_dump(),
        "message": f"规则 {rule.rule_id} 创建成功",
    }, ensure_ascii=False, indent=2)


# =============================================================================
# 工具函数 3: 更新规则
# =============================================================================


async def taga_update_rule(
    rule_id: str,
    name: str = None,
    enabled: bool = None,
    config: dict = None,
    scope: dict = None,
    priority: int = None,
    alert_channels: list[str] = None,
    **kwargs,
) -> str:
    """更新标签自动化规则。

    Args:
        rule_id: 规则 ID
        name: 规则名称
        enabled: 是否启用
        config: 规则配置
        scope: 作用范围
        priority: 优先级
        alert_channels: 告警渠道
        **kwargs: 框架注入参数

    Returns:
        JSON 字符串：更新结果
    """
    if not rule_id:
        return json.dumps({
            "success": False,
            "error_code": "INVALID_PARAM",
            "error_msg": "rule_id 不能为空",
        }, ensure_ascii=False)

    rules = _load_rules()
    rule_index = None
    for i, rule in enumerate(rules):
        if rule.get("rule_id") == rule_id:
            rule_index = i
            break

    if rule_index is None:
        return json.dumps({
            "success": False,
            "error_code": "RULE_NOT_FOUND",
            "error_msg": f"规则 {rule_id} 不存在",
        }, ensure_ascii=False)

    rule = rules[rule_index]
    if name is not None:
        rule["name"] = name
    if enabled is not None:
        rule["enabled"] = enabled
    if config is not None:
        rule["config"] = config
    if scope is not None:
        rule["scope"] = scope
    if priority is not None:
        rule["priority"] = priority
    if alert_channels is not None:
        rule["alert_channels"] = alert_channels
    rule["updated_at"] = datetime.now().isoformat()

    rules[rule_index] = rule
    _save_rules(rules)

    return json.dumps({
        "success": True,
        "rule": rule,
        "message": f"规则 {rule_id} 更新成功",
    }, ensure_ascii=False, indent=2)


# =============================================================================
# 工具函数 4: 删除规则
# =============================================================================


async def taga_delete_rule(
    rule_id: str,
    **kwargs,
) -> str:
    """删除标签自动化规则。

    Args:
        rule_id: 规则 ID
        **kwargs: 框架注入参数

    Returns:
        JSON 字符串：删除结果
    """
    if not rule_id:
        return json.dumps({
            "success": False,
            "error_code": "INVALID_PARAM",
            "error_msg": "rule_id 不能为空",
        }, ensure_ascii=False)

    rules = _load_rules()
    rule_index = None
    deleted_rule = None
    for i, rule in enumerate(rules):
        if rule.get("rule_id") == rule_id:
            rule_index = i
            deleted_rule = rule
            break

    if rule_index is None:
        return json.dumps({
            "success": False,
            "error_code": "RULE_NOT_FOUND",
            "error_msg": f"规则 {rule_id} 不存在",
        }, ensure_ascii=False)

    rules.pop(rule_index)
    _save_rules(rules)

    return json.dumps({
        "success": True,
        "deleted_rule": deleted_rule,
        "message": f"规则 {rule_id} 已删除",
    }, ensure_ascii=False, indent=2)


# =============================================================================
# 工具函数 5: 执行规则
# =============================================================================


async def taga_execute_rules(
    rule_ids: list[str] = None,
    dry_run: bool = True,
    **kwargs,
) -> str:
    """执行标签自动化规则。

    Args:
        rule_ids: 要执行的规则 ID 列表，为空则执行所有启用的规则
        dry_run: 仅预览不执行，默认 True
        **kwargs: 框架注入参数

    Returns:
        JSON 字符串：执行结果
    """
    credential = kwargs.get("credential") or get_credential()
    rules = _load_rules()

    # 筛选要执行的规则
    if rule_ids:
        rules_to_execute = [r for r in rules if r.get("rule_id") in rule_ids]
        if not rules_to_execute:
            return json.dumps({
                "success": False,
                "error_code": "RULES_NOT_FOUND",
                "error_msg": f"指定的规则不存在: {rule_ids}",
            }, ensure_ascii=False)
    else:
        rules_to_execute = [r for r in rules if r.get("enabled", True)]

    if not rules_to_execute:
        return json.dumps({
            "success": True,
            "message": "没有可执行的规则",
            "execution_results": [],
        }, ensure_ascii=False)

    # 按优先级排序
    rules_to_execute.sort(key=lambda x: x.get("priority", 1))

    try:
        execution_results = []
        for rule in rules_to_execute:
            result = await _execute_rule(rule, credential, dry_run)
            execution_results.append(result)

        # 记录执行历史
        now = datetime.now().isoformat()
        history_entry = {
            "execution_id": f"exec-{uuid.uuid4().hex[:12]}",
            "executed_at": now,
            "dry_run": dry_run,
            "rules_executed": [r["rule_id"] for r in rules_to_execute],
            "summary": {
                "total_matched": sum(r["matched_resources"] for r in execution_results),
                "total_scanned": sum(r["total_resources_scanned"] for r in execution_results),
            },
        }

        if not dry_run:
            # 更新规则的最后执行时间
            all_rules = _load_rules()
            for rule in all_rules:
                if rule["rule_id"] in [r["rule_id"] for r in rules_to_execute]:
                    rule["last_execution"] = {
                        "executed_at": now,
                        "matched_resources": next(
                            (r["matched_resources"] for r in execution_results
                             if r["rule_id"] == rule["rule_id"]), 0
                        ),
                    }
            _save_rules(all_rules)

            # 保存历史
            history = _load_history()
            history.append(history_entry)
            _save_history(history)

        return json.dumps({
            "success": True,
            "mode": "dry_run" if dry_run else "execute",
            "execution_results": execution_results,
            "next_step": "确认后请调用 taga_execute_rules(dry_run=False) 执行" if dry_run else None,
        }, ensure_ascii=False, indent=2)

    except RuntimeError as e:
        return json.dumps({
            "success": False,
            "error_code": "RESOURCE_CENTER_NOT_OPEN",
            "error_msg": str(e),
        }, ensure_ascii=False)
    except Exception as e:
        logger.exception("taga_execute_rules 执行失败")
        return json.dumps({
            "success": False,
            "error_code": "EXECUTION_ERROR",
            "error_msg": str(e),
        }, ensure_ascii=False)


# =============================================================================
# 工具函数 6: 查询执行历史
# =============================================================================


async def taga_execution_history(
    rule_id: str = None,
    limit: int = 20,
    **kwargs,
) -> str:
    """查询标签自动化规则执行历史。

    Args:
        rule_id: 规则 ID，为空则查询所有规则的历史
        limit: 返回数量限制，默认 20
        **kwargs: 框架注入参数

    Returns:
        JSON 字符串：执行历史
    """
    history = _load_history()

    # 按规则 ID 过滤
    if rule_id:
        history = [
            h for h in history
            if rule_id in h.get("rules_executed", [])
        ]

    # 按时间倒序
    history.sort(key=lambda x: x.get("executed_at", ""), reverse=True)

    # 限制返回数量
    history = history[:limit]

    return json.dumps({
        "success": True,
        "total_entries": len(history),
        "history": history,
        "history_file": str(_HISTORY_FILE),
    }, ensure_ascii=False, indent=2)

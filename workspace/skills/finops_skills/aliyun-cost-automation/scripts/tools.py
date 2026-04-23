# -*- coding: utf-8 -*-
"""阿里云成本自动化规则引擎 — 基于确定性规则自动检测成本异常和预算超标。

支持异常告警、预算阈值、SP/RI 到期预警、每日摘要等规则类型。
规则数据持久化至 ~/.copaw/data/cost_automation_rules.json。
"""

import asyncio
import json
import logging
import os
import statistics
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional

from pydantic import BaseModel

from alibabacloud_tea_openapi.models import Config
from alibabacloud_bssopenapi20171214.client import Client as BssClient
from alibabacloud_bssopenapi20171214 import models as bss_models
import sys
from pathlib import Path
# 添加 _common 目录到 Python 路径
_common_path = Path(__file__).parent.parent.parent / "_common"
if str(_common_path) not in sys.path:
    sys.path.insert(0, str(_common_path))
from credential import get_credential, get_ak_sk



logger = logging.getLogger(__name__)


# =============================================================================
# 数据模型
# =============================================================================


class CostAutomationRule(BaseModel):
    """成本自动化规则数据模型。"""

    rule_id: str
    name: str
    enabled: bool = True
    rule_type: str  # anomaly_alert | budget_threshold | sp_ri_expiry | daily_summary
    priority: int = 1
    config: dict = {}
    scope: dict = {"products": [], "regions": []}
    alert_channels: list[str] = []
    last_execution: dict | None = None
    created_at: str = ""
    updated_at: str = ""


# =============================================================================
# 内部辅助函数
# =============================================================================


def _get_data_dir() -> Path:
    """获取数据存储目录。"""
    data_dir = Path.home() / ".copaw" / "data"
    data_dir.mkdir(parents=True, exist_ok=True)
    return data_dir


def _get_rules_file() -> Path:
    """获取规则文件路径。"""
    return _get_data_dir() / "cost_automation_rules.json"


def _load_rules() -> dict[str, dict]:
    """加载所有规则。"""
    rules_file = _get_rules_file()
    if not rules_file.exists():
        return {}
    try:
        with open(rules_file, "r", encoding="utf-8") as f:
            data = json.load(f)
            return data.get("rules", {})
    except Exception:
        return {}


def _save_rules(rules: dict[str, dict]) -> None:
    """保存所有规则。"""
    rules_file = _get_rules_file()
    with open(rules_file, "w", encoding="utf-8") as f:
        json.dump({"rules": rules}, f, ensure_ascii=False, indent=2)


def _load_execution_history() -> list[dict]:
    """加载执行历史。"""
    rules_file = _get_rules_file()
    if not rules_file.exists():
        return []
    try:
        with open(rules_file, "r", encoding="utf-8") as f:
            data = json.load(f)
            return data.get("execution_history", [])
    except Exception:
        return []


def _save_execution_history(history: list[dict]) -> None:
    """保存执行历史。"""
    rules_file = _get_rules_file()
    try:
        with open(rules_file, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        data = {}
    data["execution_history"] = history[-1000:]  # 保留最近 1000 条
    with open(rules_file, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def _get_ak_sk(credential=None) -> tuple[str, str]:
    """从 credential 或环境变量获取 AK/SK。
    
    优先使用传入的 credential，如果为空则从环境变量获取。
    """
    if credential is None:
        credential = get_credential()
    if hasattr(credential, "access_key_id"):
        return credential.access_key_id, credential.access_key_secret
    return credential["access_key_id"], credential["access_key_secret"]


def _build_bss_client(credential) -> BssClient:
    """构建 BSS OpenAPI 客户端。"""
    ak, sk = _get_ak_sk(credential)
    config = Config(
        access_key_id=ak,
        access_key_secret=sk,
        endpoint="business.aliyuncs.com",
    )
    return BssClient(config)


def _safe_float(value) -> float:
    """安全转 float。"""
    try:
        return float(value) if value is not None else 0.0
    except (ValueError, TypeError):
        return 0.0


def _current_billing_cycle() -> str:
    """返回当月账期。"""
    return datetime.now(timezone.utc).strftime("%Y-%m")


def _months_ago(n: int) -> str:
    """返回 N 个月前的账期。"""
    today = datetime.now(timezone.utc)
    dt = today
    for _ in range(n):
        dt = dt.replace(day=1) - timedelta(days=1)
    return dt.strftime("%Y-%m")


# =============================================================================
# 规则管理函数 (4 个)
# =============================================================================


async def costa_list_rules(**kwargs) -> str:
    """列出所有成本自动化规则。

    Args:
        **kwargs: 框架注入的参数

    Returns:
        规则列表的 JSON 字符串
    """
    try:
        rules = _load_rules()

        rule_list = []
        for rule_id, rule_data in rules.items():
            rule_list.append({
                "rule_id": rule_id,
                "name": rule_data.get("name", ""),
                "enabled": rule_data.get("enabled", True),
                "rule_type": rule_data.get("rule_type", ""),
                "priority": rule_data.get("priority", 1),
                "config": rule_data.get("config", {}),
                "scope": rule_data.get("scope", {}),
                "alert_channels": rule_data.get("alert_channels", []),
                "last_execution": rule_data.get("last_execution"),
                "created_at": rule_data.get("created_at", ""),
                "updated_at": rule_data.get("updated_at", ""),
            })

        rule_list.sort(key=lambda x: x["priority"], reverse=True)

        return json.dumps({
            "success": True,
            "total_count": len(rule_list),
            "rules": rule_list,
        }, ensure_ascii=False, indent=2)

    except Exception as e:
        return json.dumps({
            "success": False, "error": str(e),
        }, ensure_ascii=False)


async def costa_create_rule(
    name: str,
    rule_type: str,
    config: dict = None,
    scope: dict = None,
    priority: int = 1,
    alert_channels: list[str] = None,
    **kwargs,
) -> str:
    """创建成本自动化规则。

    Args:
        name: 规则名称
        rule_type: 规则类型 (anomaly_alert | budget_threshold | sp_ri_expiry | daily_summary)
        config: 规则配置
        scope: 规则范围 {"products": [], "regions": []}
        priority: 优先级，默认 1
        alert_channels: 告警渠道列表
        **kwargs: 框架注入的参数

    Returns:
        创建结果
    """
    valid_types = ["anomaly_alert", "budget_threshold", "sp_ri_expiry", "daily_summary"]
    if rule_type not in valid_types:
        return json.dumps({
            "success": False,
            "error": f"无效的规则类型，支持: {valid_types}",
        }, ensure_ascii=False)

    if config is None:
        # 提供默认配置
        default_configs = {
            "anomaly_alert": {"sigma_threshold": 2.5, "lookback_days": 30},
            "budget_threshold": {"budget_cny": 50000, "alert_percents": [70, 85, 95]},
            "sp_ri_expiry": {"alert_days_before": [30, 7, 3]},
            "daily_summary": {"include_products": [], "top_n": 5},
        }
        config = default_configs.get(rule_type, {})

    if scope is None:
        scope = {"products": [], "regions": []}

    if alert_channels is None:
        alert_channels = []

    try:
        rules = _load_rules()

        rule_id = str(uuid.uuid4())[:8]
        now = datetime.now(timezone.utc).isoformat()

        rule_data = {
            "rule_id": rule_id,
            "name": name,
            "enabled": True,
            "rule_type": rule_type,
            "priority": priority,
            "config": config,
            "scope": scope,
            "alert_channels": alert_channels,
            "last_execution": None,
            "created_at": now,
            "updated_at": now,
        }

        rules[rule_id] = rule_data
        _save_rules(rules)

        return json.dumps({
            "success": True,
            "message": f"规则 '{name}' 创建成功",
            "rule": rule_data,
        }, ensure_ascii=False, indent=2)

    except Exception as e:
        return json.dumps({
            "success": False, "error": str(e),
        }, ensure_ascii=False)


async def costa_update_rule(
    rule_id: str,
    name: Optional[str] = None,
    enabled: Optional[bool] = None,
    config: Optional[dict] = None,
    scope: Optional[dict] = None,
    priority: Optional[int] = None,
    alert_channels: Optional[list[str]] = None,
    **kwargs,
) -> str:
    """更新成本自动化规则。

    Args:
        rule_id: 规则 ID
        name: 新名称（可选）
        enabled: 启用状态（可选）
        config: 新配置（可选）
        scope: 新范围（可选）
        priority: 新优先级（可选）
        alert_channels: 新告警渠道（可选）
        **kwargs: 框架注入的参数

    Returns:
        更新结果
    """
    try:
        rules = _load_rules()

        if rule_id not in rules:
            return json.dumps({
                "success": False,
                "error": f"规则 {rule_id} 不存在",
            }, ensure_ascii=False)

        rule_data = rules[rule_id]
        now = datetime.now(timezone.utc).isoformat()

        if name is not None:
            rule_data["name"] = name
        if enabled is not None:
            rule_data["enabled"] = enabled
        if config is not None:
            rule_data["config"] = config
        if scope is not None:
            rule_data["scope"] = scope
        if priority is not None:
            rule_data["priority"] = priority
        if alert_channels is not None:
            rule_data["alert_channels"] = alert_channels

        rule_data["updated_at"] = now
        rules[rule_id] = rule_data
        _save_rules(rules)

        return json.dumps({
            "success": True,
            "message": f"规则 {rule_id} 更新成功",
            "rule": rule_data,
        }, ensure_ascii=False, indent=2)

    except Exception as e:
        return json.dumps({
            "success": False, "error": str(e),
        }, ensure_ascii=False)


async def costa_delete_rule(rule_id: str, **kwargs) -> str:
    """删除成本自动化规则。

    Args:
        rule_id: 规则 ID
        **kwargs: 框架注入的参数

    Returns:
        删除结果
    """
    try:
        rules = _load_rules()

        if rule_id not in rules:
            return json.dumps({
                "success": False,
                "error": f"规则 {rule_id} 不存在",
            }, ensure_ascii=False)

        deleted_rule = rules.pop(rule_id)
        _save_rules(rules)

        return json.dumps({
            "success": True,
            "message": f"规则 '{deleted_rule['name']}' 已删除",
            "deleted_rule_id": rule_id,
        }, ensure_ascii=False, indent=2)

    except Exception as e:
        return json.dumps({
            "success": False, "error": str(e),
        }, ensure_ascii=False)


# =============================================================================
# 规则执行函数 (2 个)
# =============================================================================


async def _execute_anomaly_alert(rule: dict, credential) -> dict:
    """执行异常告警规则检查。"""
    config = rule.get("config", {})
    sigma_threshold = config.get("sigma_threshold", 2.5)
    lookback_days = config.get("lookback_days", 30)

    client = _build_bss_client(credential)

    # 确定需要查询的日期
    today = datetime.now(timezone.utc)

    # 生成查询日期列表
    dates_to_query = []
    for i in range(lookback_days):
        dt = today - timedelta(days=i+1)  # 从昨天开始
        dates_to_query.append(dt.strftime("%Y-%m-%d"))

    # 收集日账单 (按天查询，DAILY 粒度必须指定 BillingDate)
    daily_map: dict[str, float] = {}
    for billing_date in dates_to_query:
        billing_cycle = billing_date[:7]  # YYYY-MM
        
        for page in range(1, 51):
            req = bss_models.QueryAccountBillRequest(
                billing_cycle=billing_cycle,
                billing_date=billing_date,
                page_num=page,
                page_size=100,
                granularity="DAILY",
            )
            resp = await asyncio.to_thread(client.query_account_bill, req)
            body = resp.body

            if not body.success:
                break

            data = body.data
            items = data.items.item if data.items and data.items.item else []
            for item in items:
                cost = _safe_float(item.pretax_amount)
                daily_map[billing_date] = daily_map.get(billing_date, 0.0) + cost

            if len(items) < 100:
                break

    # 只保留有数据的天
    filtered = {d: c for d, c in daily_map.items() if c > 0}

    if len(filtered) < 3:
        return {
            "status": "skipped",
            "reason": f"数据不足（仅 {len(filtered)} 天）",
            "anomalies": [],
        }

    values = list(filtered.values())
    mean = statistics.mean(values)
    stdev = statistics.stdev(values) if len(values) > 1 else 0
    threshold = mean + sigma_threshold * stdev

    anomalies = []
    for day, cost in sorted(filtered.items()):
        if cost > threshold:
            deviation = round((cost - mean) / stdev, 1) if stdev > 0 else 0
            anomalies.append({
                "date": day,
                "pretax_amount": round(cost, 2),
                "deviation_sigma": deviation,
                "excess_amount": round(cost - mean, 2),
            })

    return {
        "status": "alert" if anomalies else "ok",
        "mean_daily_cost": round(mean, 2),
        "threshold": round(threshold, 2),
        "anomaly_count": len(anomalies),
        "anomalies": anomalies,
    }


async def _execute_budget_threshold(rule: dict, credential) -> dict:
    """执行预算阈值规则检查。"""
    config = rule.get("config", {})
    budget_cny = config.get("budget_cny", 50000)
    alert_percents = config.get("alert_percents", [70, 85, 95])

    client = _build_bss_client(credential)

    # 获取当月累计消费
    cycle = _current_billing_cycle()
    req = bss_models.QueryBillOverviewRequest(billing_cycle=cycle)
    resp = await asyncio.to_thread(client.query_bill_overview, req)
    body = resp.body

    if not body.success:
        return {
            "status": "error",
            "error": body.message,
        }

    data = body.data
    items = data.items.item if data.items and data.items.item else []
    total = sum(_safe_float(item.pretax_amount) for item in items)

    usage_percent = round(total / budget_cny * 100, 1) if budget_cny > 0 else 0

    triggered_alerts = [p for p in sorted(alert_percents) if usage_percent >= p]

    return {
        "status": "alert" if triggered_alerts else "ok",
        "billing_cycle": cycle,
        "current_cost": round(total, 2),
        "budget_cny": budget_cny,
        "usage_percent": usage_percent,
        "triggered_percents": triggered_alerts,
    }


async def _execute_sp_ri_expiry(rule: dict, credential) -> dict:
    """执行 SP/RI 到期预警规则检查。"""
    config = rule.get("config", {})
    alert_days_before = config.get("alert_days_before", [30, 7, 3])

    client = _build_bss_client(credential)

    now = datetime.now(timezone.utc)

    # 查询节省计划
    expiring_items = []

    try:
        req = bss_models.QuerySavingsPlansInstanceRequest(
            page_num=1,
            page_size=100,
        )
        resp = await asyncio.to_thread(client.query_savings_plans_instance, req)
        body = resp.body

        if body.success and body.data and body.data.items:
            for item in body.data.items:
                end_time = item.end_time if hasattr(item, "end_time") else ""
                if end_time:
                    try:
                        if end_time.endswith("Z"):
                            end_dt = datetime.fromisoformat(end_time.replace("Z", "+00:00"))
                        else:
                            end_dt = datetime.fromisoformat(end_time)
                        days_left = (end_dt - now).days

                        for alert_day in sorted(alert_days_before, reverse=True):
                            if days_left <= alert_day:
                                expiring_items.append({
                                    "type": "SavingsPlan",
                                    "instance_id": item.instance_id if hasattr(item, "instance_id") else "",
                                    "end_time": end_time,
                                    "days_until_expiry": max(days_left, 0),
                                    "alert_threshold_days": alert_day,
                                })
                                break
                    except (ValueError, TypeError):
                        pass
    except Exception:
        pass

    return {
        "status": "alert" if expiring_items else "ok",
        "expiring_count": len(expiring_items),
        "expiring_items": expiring_items,
    }


async def _execute_daily_summary(rule: dict, credential) -> dict:
    """执行每日摘要规则检查。"""
    config = rule.get("config", {})
    top_n = config.get("top_n", 5)

    client = _build_bss_client(credential)

    # 获取昨日账单
    yesterday = (datetime.now(timezone.utc) - timedelta(days=1)).strftime("%Y-%m-%d")
    cycle = yesterday[:7]  # YYYY-MM

    all_items = []
    for page in range(1, 51):
        req = bss_models.QueryAccountBillRequest(
            billing_cycle=cycle,
            billing_date=yesterday,  # DAILY 粒度必须指定 BillingDate
            page_num=page,
            page_size=100,
            granularity="DAILY",
        )
        resp = await asyncio.to_thread(client.query_account_bill, req)
        body = resp.body

        if not body.success:
            break

        data = body.data
        items = data.items.item if data.items and data.items.item else []
        all_items.extend(items)

        if len(items) < 100:
            break

    # 按产品聚合
    by_product: dict[str, float] = {}
    total = 0.0
    for item in all_items:
        pname = item.product_name or item.product_code or "unknown"
        cost = _safe_float(item.pretax_amount)
        by_product[pname] = by_product.get(pname, 0.0) + cost
        total += cost

    top_products = sorted(by_product.items(), key=lambda x: x[1], reverse=True)[:top_n]

    return {
        "status": "ok",
        "date": yesterday,
        "total_cost": round(total, 2),
        "top_products": [
            {"product": p, "cost": round(c, 2)}
            for p, c in top_products
        ],
    }


async def costa_execute_check(
    rule_ids: list[str] = None,
    **kwargs,
) -> str:
    """执行指定规则检查。

    Args:
        rule_ids: 要执行的规则 ID 列表，为空则执行所有启用的规则
        **kwargs: 框架注入的参数

    Returns:
        检查结果
    """
    credential = kwargs.get("credential") or get_credential()

    try:
        rules = _load_rules()

        if rule_ids:
            rules_to_check = {rid: rules[rid] for rid in rule_ids if rid in rules}
        else:
            rules_to_check = {rid: r for rid, r in rules.items() if r.get("enabled", True)}

        if not rules_to_check:
            return json.dumps({
                "success": True,
                "message": "没有需要检查的规则",
                "results": [],
            }, ensure_ascii=False, indent=2)

        results = []
        history = _load_execution_history()
        now = datetime.now(timezone.utc).isoformat()

        for rule_id, rule in rules_to_check.items():
            rule_type = rule.get("rule_type", "")

            try:
                if rule_type == "anomaly_alert":
                    check_result = await _execute_anomaly_alert(rule, credential)
                elif rule_type == "budget_threshold":
                    check_result = await _execute_budget_threshold(rule, credential)
                elif rule_type == "sp_ri_expiry":
                    check_result = await _execute_sp_ri_expiry(rule, credential)
                elif rule_type == "daily_summary":
                    check_result = await _execute_daily_summary(rule, credential)
                else:
                    check_result = {"status": "error", "error": f"未知规则类型: {rule_type}"}

                execution_record = {
                    "rule_id": rule_id,
                    "rule_name": rule.get("name", ""),
                    "rule_type": rule_type,
                    "executed_at": now,
                    "result": check_result,
                }

                results.append(execution_record)
                history.append(execution_record)

                # 更新规则的 last_execution
                rules[rule_id]["last_execution"] = {
                    "executed_at": now,
                    "status": check_result.get("status", "unknown"),
                }

            except Exception as e:
                results.append({
                    "rule_id": rule_id,
                    "rule_name": rule.get("name", ""),
                    "rule_type": rule_type,
                    "executed_at": now,
                    "result": {"status": "error", "error": str(e)},
                })

        _save_rules(rules)
        _save_execution_history(history)

        alert_count = sum(1 for r in results if r["result"].get("status") == "alert")

        return json.dumps({
            "success": True,
            "executed_count": len(results),
            "alert_count": alert_count,
            "results": results,
        }, ensure_ascii=False, indent=2)

    except Exception as e:
        return json.dumps({
            "success": False, "error": str(e),
        }, ensure_ascii=False)


async def costa_execution_history(
    rule_id: Optional[str] = None,
    limit: int = 20,
    **kwargs,
) -> str:
    """查看规则执行历史。

    Args:
        rule_id: 指定规则 ID 过滤（可选）
        limit: 返回数量限制，默认 20
        **kwargs: 框架注入的参数

    Returns:
        执行历史
    """
    try:
        history = _load_execution_history()

        if rule_id:
            history = [h for h in history if h.get("rule_id") == rule_id]

        # 按时间倒序
        history.sort(key=lambda x: x.get("executed_at", ""), reverse=True)
        history = history[:limit]

        return json.dumps({
            "success": True,
            "total_count": len(history),
            "history": history,
        }, ensure_ascii=False, indent=2)

    except Exception as e:
        return json.dumps({
            "success": False, "error": str(e),
        }, ensure_ascii=False)

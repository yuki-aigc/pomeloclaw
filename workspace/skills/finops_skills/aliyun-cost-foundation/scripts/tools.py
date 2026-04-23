# -*- coding: utf-8 -*-
"""阿里云成本数据基座 — 账单查询、趋势分析、价格查询与成本分摊。

全部 READ 操作，风险等级 LOW。基于 BSS OpenAPI 实现账单查询、趋势分析、
价格查询、费率覆盖分析与成本分摊等基础 FinOps 能力。
"""

import asyncio
import json
import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from alibabacloud_tea_openapi.models import Config
from alibabacloud_bssopenapi20171214.client import Client as BssClient
from alibabacloud_bssopenapi20171214 import models as bss_models
from alibabacloud_ecs20140526.client import Client as EcsClient
from alibabacloud_ecs20140526 import models as ecs_models
import sys
from pathlib import Path
# 添加 _common 目录到 Python 路径
_common_path = Path(__file__).parent.parent.parent / "_common"
if str(_common_path) not in sys.path:
    sys.path.insert(0, str(_common_path))
from credential import get_credential, get_ak_sk



logger = logging.getLogger(__name__)


# =============================================================================
# 内部辅助函数
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


def _build_bss_client(credential) -> BssClient:
    """构建 BSS OpenAPI 客户端。BSS 是全局服务，endpoint 固定。"""
    ak, sk = _get_ak_sk(credential)
    config = Config(
        access_key_id=ak,
        access_key_secret=sk,
        endpoint="business.aliyuncs.com",
    )
    return BssClient(config)


def _build_ecs_client(credential, region: str) -> EcsClient:
    """构建 ECS OpenAPI 客户端。"""
    ak, sk = _get_ak_sk(credential)
    config = Config(
        access_key_id=ak,
        access_key_secret=sk,
        endpoint=f"ecs.{region}.aliyuncs.com",
    )
    return EcsClient(config)


def _default_billing_cycle() -> str:
    """返回上个月的账期，格式 YYYY-MM。"""
    today = datetime.now(timezone.utc)
    first_of_month = today.replace(day=1)
    last_month = first_of_month - timedelta(days=1)
    return last_month.strftime("%Y-%m")


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


def _safe_float(value) -> float:
    """安全转 float。"""
    try:
        return float(value) if value is not None else 0.0
    except (ValueError, TypeError):
        return 0.0


def _safe_int(value) -> int:
    """安全转 int。"""
    try:
        return int(value) if value is not None else 0
    except (ValueError, TypeError):
        return 0


# =============================================================================
# 账单查询 (3 个函数)
# =============================================================================


async def costf_account_bill(
    billing_cycle: str = "",
    product_code: Optional[str] = None,
    **kwargs,
) -> str:
    """查询指定月份的账户级账单总览。

    返回月度总费用、各产品费用分布、付费方式分布等信息。

    Args:
        billing_cycle: 账期，格式 "YYYY-MM"，默认上月
        product_code: 按产品过滤（如 "ecs", "rds"），可选
        **kwargs: 框架注入的参数（credential 等）

    Returns:
        账单总览的 JSON 字符串
    """
    credential = kwargs.get("credential") or get_credential()
    client = _build_bss_client(credential)

    if not billing_cycle:
        billing_cycle = _default_billing_cycle()

    try:
        req = bss_models.QueryAccountBillRequest(
            billing_cycle=billing_cycle,
            page_num=1,
            page_size=100,
            is_group_by_product=True,
        )
        if product_code:
            req.product_code = product_code

        resp = await asyncio.to_thread(client.query_account_bill, req)
        body = resp.body

        if not body.success:
            return json.dumps({
                "success": False,
                "error_code": body.code,
                "error_msg": body.message,
            }, ensure_ascii=False)

        data = body.data
        items = data.items.item if data.items and data.items.item else []

        total_cost = 0.0
        by_product = []
        for item in items:
            cost = _safe_float(item.pretax_amount)
            total_cost += cost
            by_product.append({
                "product_code": item.product_code,
                "product_name": item.product_name,
                "pretax_amount": round(cost, 2),
                "subscription_type": item.subscription_type,
                "currency": item.currency,
            })

        by_product.sort(key=lambda x: x["pretax_amount"], reverse=True)

        return json.dumps({
            "success": True,
            "billing_cycle": billing_cycle,
            "total_pretax_amount": round(total_cost, 2),
            "currency": items[0].currency if items else "CNY",
            "product_count": len(by_product),
            "by_product": by_product,
            "note": "账单数据有 T+1 延迟",
        }, ensure_ascii=False, indent=2)

    except Exception as e:
        return json.dumps({
            "success": False, "error": str(e),
        }, ensure_ascii=False)


async def costf_instance_bill(
    billing_cycle: str = "",
    product_code: Optional[str] = None,
    instance_id: Optional[str] = None,
    max_results: int = 50,
    **kwargs,
) -> str:
    """查询实例级账单明细。

    返回每个实例的费用明细，支持按产品和实例 ID 过滤。

    Args:
        billing_cycle: 账期，格式 "YYYY-MM"，默认上月
        product_code: 按产品过滤，可选
        instance_id: 按实例 ID 过滤，可选
        max_results: 最大返回数量，默认 50
        **kwargs: 框架注入的参数

    Returns:
        实例级账单的 JSON 字符串
    """
    credential = kwargs.get("credential") or get_credential()
    client = _build_bss_client(credential)

    if not billing_cycle:
        billing_cycle = _default_billing_cycle()

    try:
        req = bss_models.QueryInstanceBillRequest(
            billing_cycle=billing_cycle,
            page_num=1,
            page_size=min(max_results, 100),
        )
        if product_code:
            req.product_code = product_code
        if instance_id:
            req.instance_id = instance_id

        resp = await asyncio.to_thread(client.query_instance_bill, req)
        body = resp.body

        if not body.success:
            return json.dumps({
                "success": False,
                "error_code": body.code,
                "error_msg": body.message,
            }, ensure_ascii=False)

        data = body.data
        items = data.items.item if data.items and data.items.item else []

        instances = []
        for item in items:
            instances.append({
                "instance_id": item.instance_id,
                "product_code": item.product_code,
                "product_name": item.product_name,
                "subscription_type": item.subscription_type,
                "pretax_amount": round(_safe_float(item.pretax_amount), 2),
                "region": item.region,
                "resource_group": item.resource_group,
                "tag": item.tag,
                "instance_config": item.instance_config,
            })

        return json.dumps({
            "success": True,
            "billing_cycle": billing_cycle,
            "total_count": data.total_count,
            "returned_count": len(instances),
            "instances": instances,
        }, ensure_ascii=False, indent=2)

    except Exception as e:
        return json.dumps({
            "success": False, "error": str(e),
        }, ensure_ascii=False)


async def costf_bill_overview(
    billing_cycle: str = "",
    **kwargs,
) -> str:
    """查询按产品分组的月度费用汇总。

    返回各产品的月度费用、占比和排名。

    Args:
        billing_cycle: 账期，格式 "YYYY-MM"，默认上月
        **kwargs: 框架注入的参数

    Returns:
        费用汇总的 JSON 字符串
    """
    credential = kwargs.get("credential") or get_credential()
    client = _build_bss_client(credential)

    if not billing_cycle:
        billing_cycle = _default_billing_cycle()

    try:
        req = bss_models.QueryBillOverviewRequest(
            billing_cycle=billing_cycle,
        )
        resp = await asyncio.to_thread(client.query_bill_overview, req)
        body = resp.body

        if not body.success:
            return json.dumps({
                "success": False,
                "error_code": body.code,
                "error_msg": body.message,
            }, ensure_ascii=False)

        data = body.data
        items = data.items.item if data.items and data.items.item else []

        total_cost = 0.0
        products = []
        for item in items:
            cost = _safe_float(item.pretax_amount)
            total_cost += cost
            products.append({
                "product_code": item.product_code,
                "product_name": item.product_name,
                "pretax_amount": round(cost, 2),
                "subscription_type": item.subscription_type,
            })

        products.sort(key=lambda x: x["pretax_amount"], reverse=True)

        for p in products:
            p["percent"] = (
                round(p["pretax_amount"] / total_cost * 100, 1)
                if total_cost > 0 else 0
            )

        return json.dumps({
            "success": True,
            "billing_cycle": billing_cycle,
            "total_pretax_amount": round(total_cost, 2),
            "product_count": len(products),
            "products": products,
        }, ensure_ascii=False, indent=2)

    except Exception as e:
        return json.dumps({
            "success": False, "error": str(e),
        }, ensure_ascii=False)


# =============================================================================
# 趋势分析 (3 个函数)
# =============================================================================


async def costf_monthly_trend(
    months: int = 6,
    **kwargs,
) -> str:
    """查询最近 N 个月的成本趋势。

    返回每月总费用、环比增长率和 Top 3 增长产品。

    Args:
        months: 查询月数，默认 6
        **kwargs: 框架注入的参数

    Returns:
        月度趋势的 JSON 字符串
    """
    credential = kwargs.get("credential") or get_credential()
    client = _build_bss_client(credential)

    months = min(max(months, 2), 12)

    try:
        monthly_data = []
        for i in range(months - 1, -1, -1):
            cycle = _months_ago(i) if i > 0 else _current_billing_cycle()
            req = bss_models.QueryBillOverviewRequest(billing_cycle=cycle)
            resp = await asyncio.to_thread(client.query_bill_overview, req)
            body = resp.body

            if not body.success:
                monthly_data.append({"billing_cycle": cycle, "total": 0.0, "products": {}})
                continue

            data = body.data
            items = data.items.item if data.items and data.items.item else []

            total = 0.0
            products = {}
            for item in items:
                cost = _safe_float(item.pretax_amount)
                total += cost
                pname = item.product_name or item.product_code
                products[pname] = products.get(pname, 0.0) + cost

            monthly_data.append({
                "billing_cycle": cycle,
                "total": round(total, 2),
                "products": products,
            })

        # 计算环比
        trend = []
        for idx, m in enumerate(monthly_data):
            entry = {
                "billing_cycle": m["billing_cycle"],
                "total_pretax_amount": m["total"],
            }
            if idx > 0 and monthly_data[idx - 1]["total"] > 0:
                prev = monthly_data[idx - 1]["total"]
                change = m["total"] - prev
                entry["mom_change"] = round(change, 2)
                entry["mom_percent"] = round(change / prev * 100, 1)
            else:
                entry["mom_change"] = None
                entry["mom_percent"] = None
            trend.append(entry)

        # Top 3 增长产品（对比最近两个月）
        top_growth = []
        if len(monthly_data) >= 2:
            curr_products = monthly_data[-1]["products"]
            prev_products = monthly_data[-2]["products"]
            growth_list = []
            for pname, curr_cost in curr_products.items():
                prev_cost = prev_products.get(pname, 0.0)
                if prev_cost > 0:
                    growth = curr_cost - prev_cost
                    growth_pct = growth / prev_cost * 100
                    growth_list.append({
                        "product": pname,
                        "current": round(curr_cost, 2),
                        "previous": round(prev_cost, 2),
                        "growth": round(growth, 2),
                        "growth_percent": round(growth_pct, 1),
                    })
            growth_list.sort(key=lambda x: x["growth"], reverse=True)
            top_growth = growth_list[:3]

        return json.dumps({
            "success": True,
            "months": months,
            "trend": trend,
            "top_growth_products": top_growth,
        }, ensure_ascii=False, indent=2)

    except Exception as e:
        return json.dumps({
            "success": False, "error": str(e),
        }, ensure_ascii=False)


async def costf_daily_trend(
    billing_cycle: str = "",
    product_code: Optional[str] = None,
    **kwargs,
) -> str:
    """查询指定月份的日级成本曲线。

    Args:
        billing_cycle: 账期，格式 "YYYY-MM"，默认上月
        product_code: 按产品过滤，可选
        **kwargs: 框架注入的参数

    Returns:
        日级成本数据的 JSON 字符串
    """
    credential = kwargs.get("credential") or get_credential()
    client = _build_bss_client(credential)

    if not billing_cycle:
        billing_cycle = _default_billing_cycle()

    try:
        # 生成该月所有日期
        year, month = map(int, billing_cycle.split("-"))
        from calendar import monthrange
        _, days_in_month = monthrange(year, month)
        
        # 确定查询范围（如果是当月，只查询到昨天）
        today = datetime.now(timezone.utc)
        if billing_cycle == today.strftime("%Y-%m"):
            max_day = today.day - 1  # 查询到昨天
        else:
            max_day = days_in_month
        
        if max_day < 1:
            return json.dumps({
                "success": True,
                "billing_cycle": billing_cycle,
                "product_code": product_code,
                "total_pretax_amount": 0,
                "daily_average": 0,
                "days": 0,
                "daily_trend": [],
                "note": "当月尚无可用的日级账单数据",
            }, ensure_ascii=False, indent=2)
        
        daily_map: dict[str, float] = {}
        
        # 按天查询 (DAILY 粒度必须指定 BillingDate)
        for day in range(1, max_day + 1):
            billing_date = f"{billing_cycle}-{day:02d}"
            
            for page in range(1, 51):
                req = bss_models.QueryAccountBillRequest(
                    billing_cycle=billing_cycle,
                    billing_date=billing_date,
                    page_num=page,
                    page_size=100,
                    granularity="DAILY",
                )
                if product_code:
                    req.product_code = product_code

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

        daily_trend = [
            {"date": day, "pretax_amount": round(cost, 2)}
            for day, cost in sorted(daily_map.items()) if cost > 0
        ]

        total = sum(d["pretax_amount"] for d in daily_trend)
        avg = round(total / len(daily_trend), 2) if daily_trend else 0

        return json.dumps({
            "success": True,
            "billing_cycle": billing_cycle,
            "product_code": product_code,
            "total_pretax_amount": round(total, 2),
            "daily_average": avg,
            "days": len(daily_trend),
            "daily_trend": daily_trend,
        }, ensure_ascii=False, indent=2)

    except Exception as e:
        return json.dumps({
            "success": False, "error": str(e),
        }, ensure_ascii=False)


async def costf_compare_periods(
    period1: str = "",
    period2: str = "",
    **kwargs,
) -> str:
    """对比两个月份的成本。

    Args:
        period1: 第一个账期，格式 "YYYY-MM"，默认上上月
        period2: 第二个账期，格式 "YYYY-MM"，默认上月
        **kwargs: 框架注入的参数

    Returns:
        两时段对比结果
    """
    credential = kwargs.get("credential") or get_credential()
    client = _build_bss_client(credential)

    if not period1:
        period1 = _months_ago(2)
    if not period2:
        period2 = _months_ago(1)

    try:
        results = {}
        for label, cycle in [("period1", period1), ("period2", period2)]:
            req = bss_models.QueryBillOverviewRequest(billing_cycle=cycle)
            resp = await asyncio.to_thread(client.query_bill_overview, req)
            body = resp.body

            products = {}
            total = 0.0
            if body.success:
                data = body.data
                items = data.items.item if data.items and data.items.item else []
                for item in items:
                    cost = _safe_float(item.pretax_amount)
                    total += cost
                    pname = item.product_name or item.product_code
                    products[pname] = products.get(pname, 0.0) + cost

            results[label] = {"cycle": cycle, "total": total, "products": products}

        a = results["period1"]
        b = results["period2"]
        total_change = b["total"] - a["total"]
        total_pct = round(total_change / a["total"] * 100, 1) if a["total"] > 0 else 0

        all_products = set(a["products"].keys()) | set(b["products"].keys())
        product_changes = []
        for pname in all_products:
            cost_a = a["products"].get(pname, 0.0)
            cost_b = b["products"].get(pname, 0.0)
            change = cost_b - cost_a
            pct = round(change / cost_a * 100, 1) if cost_a > 0 else (100.0 if cost_b > 0 else 0)
            product_changes.append({
                "product": pname,
                "period1": round(cost_a, 2),
                "period2": round(cost_b, 2),
                "change": round(change, 2),
                "change_percent": pct,
            })

        product_changes.sort(key=lambda x: abs(x["change"]), reverse=True)

        return json.dumps({
            "success": True,
            "period1": {"billing_cycle": a["cycle"], "total": round(a["total"], 2)},
            "period2": {"billing_cycle": b["cycle"], "total": round(b["total"], 2)},
            "total_change": round(total_change, 2),
            "total_change_percent": total_pct,
            "product_changes": product_changes[:10],
        }, ensure_ascii=False, indent=2)

    except Exception as e:
        return json.dumps({
            "success": False, "error": str(e),
        }, ensure_ascii=False)


# =============================================================================
# 分摊分析 (6 个函数)
# =============================================================================


async def costf_by_tag(
    billing_cycle: str = "",
    tag_key: str = "env",
    **kwargs,
) -> str:
    """按指定 Tag Key 分组查询成本。

    用于成本分摊，例如按 env 标签查看各环境的成本占比。

    Args:
        billing_cycle: 账期，默认上月
        tag_key: 分组的标签键，默认 "env"
        **kwargs: 框架注入的参数

    Returns:
        按 Tag 分组的成本数据
    """
    credential = kwargs.get("credential") or get_credential()
    client = _build_bss_client(credential)

    if not billing_cycle:
        billing_cycle = _default_billing_cycle()

    try:
        all_items = []
        for page in range(1, 51):
            req = bss_models.QueryInstanceBillRequest(
                billing_cycle=billing_cycle,
                page_num=page,
                page_size=100,
            )
            resp = await asyncio.to_thread(client.query_instance_bill, req)
            body = resp.body

            if not body.success:
                break

            data = body.data
            items = data.items.item if data.items and data.items.item else []
            all_items.extend(items)

            if len(all_items) >= (data.total_count or 0):
                break

        group_map: dict[str, float] = {}
        for item in all_items:
            tag_value = "untagged"
            tag_str = item.tag or ""
            if tag_str:
                # BSS API 返回格式: "key:xxx value:yyy; key:xxx2 value:yyy2"
                for pair in tag_str.split(";"):
                    pair = pair.strip()
                    parts = pair.split()
                    if len(parts) >= 2:
                        key_part = parts[0]  # "key:xxx"
                        value_part = parts[1]  # "value:yyy"
                        if key_part.startswith("key:") and value_part.startswith("value:"):
                            k = key_part[4:]  # 去掉 "key:" 前缀
                            v = value_part[6:]  # 去掉 "value:" 前缀
                            if k == tag_key:
                                tag_value = v
                                break

            cost = _safe_float(item.pretax_amount)
            group_map[tag_value] = group_map.get(tag_value, 0.0) + cost

        total = sum(group_map.values())
        groups = [
            {
                "tag_value": tv,
                "pretax_amount": round(cost, 2),
                "percent": round(cost / total * 100, 1) if total > 0 else 0,
            }
            for tv, cost in sorted(group_map.items(), key=lambda x: x[1], reverse=True)
        ]

        return json.dumps({
            "success": True,
            "billing_cycle": billing_cycle,
            "tag_key": tag_key,
            "total_pretax_amount": round(total, 2),
            "groups": groups,
        }, ensure_ascii=False, indent=2)

    except Exception as e:
        return json.dumps({
            "success": False, "error": str(e),
        }, ensure_ascii=False)


async def costf_by_resource_group(
    billing_cycle: str = "",
    resource_group_id: Optional[str] = None,
    **kwargs,
) -> str:
    """按资源组分组查询成本。

    Args:
        billing_cycle: 账期，默认上月
        resource_group_id: 指定资源组 ID 过滤，可选
        **kwargs: 框架注入的参数

    Returns:
        按资源组分组的成本数据
    """
    credential = kwargs.get("credential") or get_credential()
    client = _build_bss_client(credential)

    if not billing_cycle:
        billing_cycle = _default_billing_cycle()

    try:
        all_items = []
        for page in range(1, 51):
            req = bss_models.QueryInstanceBillRequest(
                billing_cycle=billing_cycle,
                page_num=page,
                page_size=100,
            )
            resp = await asyncio.to_thread(client.query_instance_bill, req)
            body = resp.body

            if not body.success:
                break

            data = body.data
            items = data.items.item if data.items and data.items.item else []
            all_items.extend(items)

            if len(all_items) >= (data.total_count or 0):
                break

        group_map: dict[str, float] = {}
        for item in all_items:
            rg = item.resource_group or "default"
            if resource_group_id and rg != resource_group_id:
                continue
            cost = _safe_float(item.pretax_amount)
            group_map[rg] = group_map.get(rg, 0.0) + cost

        total = sum(group_map.values())
        groups = [
            {
                "resource_group": rg,
                "pretax_amount": round(cost, 2),
                "percent": round(cost / total * 100, 1) if total > 0 else 0,
            }
            for rg, cost in sorted(group_map.items(), key=lambda x: x[1], reverse=True)
        ]

        return json.dumps({
            "success": True,
            "billing_cycle": billing_cycle,
            "total_pretax_amount": round(total, 2),
            "groups": groups,
        }, ensure_ascii=False, indent=2)

    except Exception as e:
        return json.dumps({
            "success": False, "error": str(e),
        }, ensure_ascii=False)


async def costf_product_breakdown(
    billing_cycle: str = "",
    top_n: int = 10,
    **kwargs,
) -> str:
    """产品维度 Top N 费用及占比。

    Args:
        billing_cycle: 账期，默认上月
        top_n: 返回 Top N 产品，默认 10
        **kwargs: 框架注入的参数

    Returns:
        产品维度费用排名
    """
    credential = kwargs.get("credential") or get_credential()
    client = _build_bss_client(credential)

    if not billing_cycle:
        billing_cycle = _default_billing_cycle()

    try:
        req = bss_models.QueryBillOverviewRequest(
            billing_cycle=billing_cycle,
        )
        resp = await asyncio.to_thread(client.query_bill_overview, req)
        body = resp.body

        if not body.success:
            return json.dumps({
                "success": False,
                "error_code": body.code,
                "error_msg": body.message,
            }, ensure_ascii=False)

        data = body.data
        items = data.items.item if data.items and data.items.item else []

        product_map: dict[str, dict] = {}
        for item in items:
            pcode = item.product_code
            cost = _safe_float(item.pretax_amount)
            if pcode not in product_map:
                product_map[pcode] = {
                    "product_code": pcode,
                    "product_name": item.product_name,
                    "pretax_amount": 0.0,
                }
            product_map[pcode]["pretax_amount"] += cost

        products = sorted(product_map.values(), key=lambda x: x["pretax_amount"], reverse=True)
        total = sum(p["pretax_amount"] for p in products)

        top_products = products[:top_n]
        for p in top_products:
            p["pretax_amount"] = round(p["pretax_amount"], 2)
            p["percent"] = round(p["pretax_amount"] / total * 100, 1) if total > 0 else 0

        others_cost = sum(p["pretax_amount"] for p in products[top_n:])

        return json.dumps({
            "success": True,
            "billing_cycle": billing_cycle,
            "total_pretax_amount": round(total, 2),
            "top_n": top_n,
            "products": top_products,
            "others_pretax_amount": round(others_cost, 2),
        }, ensure_ascii=False, indent=2)

    except Exception as e:
        return json.dumps({
            "success": False, "error": str(e),
        }, ensure_ascii=False)


async def costf_region_breakdown(
    billing_cycle: str = "",
    **kwargs,
) -> str:
    """按区域分组的成本分布。

    Args:
        billing_cycle: 账期，默认上月
        **kwargs: 框架注入的参数

    Returns:
        区域维度的成本分布
    """
    credential = kwargs.get("credential") or get_credential()
    client = _build_bss_client(credential)

    if not billing_cycle:
        billing_cycle = _default_billing_cycle()

    try:
        all_items = []
        for page in range(1, 51):
            req = bss_models.QueryInstanceBillRequest(
                billing_cycle=billing_cycle,
                page_num=page,
                page_size=100,
            )
            resp = await asyncio.to_thread(client.query_instance_bill, req)
            body = resp.body

            if not body.success:
                break

            data = body.data
            items = data.items.item if data.items and data.items.item else []
            all_items.extend(items)

            if len(all_items) >= (data.total_count or 0):
                break

        region_map: dict[str, float] = {}
        for item in all_items:
            region = item.region or "global"
            cost = _safe_float(item.pretax_amount)
            region_map[region] = region_map.get(region, 0.0) + cost

        total = sum(region_map.values())
        regions = [
            {
                "region": r,
                "pretax_amount": round(cost, 2),
                "percent": round(cost / total * 100, 1) if total > 0 else 0,
            }
            for r, cost in sorted(region_map.items(), key=lambda x: x[1], reverse=True)
        ]

        return json.dumps({
            "success": True,
            "billing_cycle": billing_cycle,
            "total_pretax_amount": round(total, 2),
            "regions": regions,
        }, ensure_ascii=False, indent=2)

    except Exception as e:
        return json.dumps({
            "success": False, "error": str(e),
        }, ensure_ascii=False)


async def costf_chargeback_report(
    billing_cycle: str = "",
    dimensions: list[str] = None,
    include_shared: bool = False,
    output_format: str = "markdown_table",
    **kwargs,
) -> str:
    """基于 QueryInstanceBill 的多维度成本分摊报告。

    Args:
        billing_cycle: 账期，默认上月
        dimensions: 分摊维度，如 ["tag:team", "product", "resource_group"]
        include_shared: 是否包含共享资源分摊
        output_format: 输出格式 "markdown_table" | "chart_data"
        **kwargs: 框架注入的参数

    Returns:
        markdown 表格或 chart-ready JSON
    """
    credential = kwargs.get("credential") or get_credential()
    client = _build_bss_client(credential)

    if not billing_cycle:
        billing_cycle = _default_billing_cycle()
    if dimensions is None:
        dimensions = ["product"]

    try:
        all_items = []
        for page in range(1, 51):
            req = bss_models.QueryInstanceBillRequest(
                billing_cycle=billing_cycle,
                page_num=page,
                page_size=100,
            )
            resp = await asyncio.to_thread(client.query_instance_bill, req)
            body = resp.body

            if not body.success:
                break

            data = body.data
            items = data.items.item if data.items and data.items.item else []
            all_items.extend(items)

            if len(all_items) >= (data.total_count or 0):
                break

        # 多维度聚合
        chargeback_data: dict[str, dict] = {}

        for item in all_items:
            for dim in dimensions:
                dim_value = "unknown"
                if dim == "product":
                    dim_value = item.product_name or item.product_code or "unknown"
                elif dim == "resource_group":
                    dim_value = item.resource_group or "default"
                elif dim.startswith("tag:"):
                    tag_key = dim[4:]
                    tag_str = item.tag or ""
                    dim_value = "untagged"
                    if tag_str:
                        # BSS API 返回格式: "key:xxx value:yyy; key:xxx2 value:yyy2"
                        for pair in tag_str.split(";"):
                            pair = pair.strip()
                            parts = pair.split()
                            if len(parts) >= 2:
                                key_part = parts[0]  # "key:xxx"
                                value_part = parts[1]  # "value:yyy"
                                if key_part.startswith("key:") and value_part.startswith("value:"):
                                    k = key_part[4:]  # 去掉 "key:" 前缀
                                    v = value_part[6:]  # 去掉 "value:" 前缀
                                    if k == tag_key:
                                        dim_value = v
                                        break

                key = f"{dim}:{dim_value}"
                if key not in chargeback_data:
                    chargeback_data[key] = {
                        "dimension": dim,
                        "value": dim_value,
                        "direct_cost": 0.0,
                        "shared_cost": 0.0,
                    }

                cost = _safe_float(item.pretax_amount)
                chargeback_data[key]["direct_cost"] += cost

        # 计算总成本和占比
        total = sum(d["direct_cost"] for d in chargeback_data.values())
        for d in chargeback_data.values():
            d["total_cost"] = round(d["direct_cost"] + d["shared_cost"], 2)
            d["direct_cost"] = round(d["direct_cost"], 2)
            d["shared_cost"] = round(d["shared_cost"], 2)
            d["percent"] = round(d["total_cost"] / total * 100, 1) if total > 0 else 0

        allocations = sorted(chargeback_data.values(), key=lambda x: x["total_cost"], reverse=True)

        if output_format == "markdown_table":
            lines = ["| 维度 | 值 | 直接成本(CNY) | 共享分摊(CNY) | 总成本(CNY) | 占比 |"]
            lines.append("|------|-----|--------------|--------------|-------------|------|")
            for a in allocations[:20]:
                lines.append(
                    f"| {a['dimension']} | {a['value']} | {a['direct_cost']} | "
                    f"{a['shared_cost']} | {a['total_cost']} | {a['percent']}% |"
                )
            return json.dumps({
                "success": True,
                "billing_cycle": billing_cycle,
                "output_format": "markdown_table",
                "table": "\n".join(lines),
                "total_cost": round(total, 2),
            }, ensure_ascii=False, indent=2)
        else:
            return json.dumps({
                "success": True,
                "billing_cycle": billing_cycle,
                "output_format": "chart_data",
                "total_cost": round(total, 2),
                "allocations": allocations,
            }, ensure_ascii=False, indent=2)

    except Exception as e:
        return json.dumps({
            "success": False, "error": str(e),
        }, ensure_ascii=False)


async def costf_chargeback_trend(
    months: int = 6,
    dimension: str = "product",
    top_n: int = 5,
    **kwargs,
) -> str:
    """分摊趋势对比（最近 N 月）。

    返回各维度值的月度趋势。

    Args:
        months: 查询月数，默认 6
        dimension: 分摊维度，如 "product", "tag:team", "resource_group"
        top_n: 返回 Top N 项，默认 5
        **kwargs: 框架注入的参数

    Returns:
        分摊趋势数据
    """
    credential = kwargs.get("credential") or get_credential()
    client = _build_bss_client(credential)

    months = min(max(months, 2), 12)

    try:
        monthly_breakdown: list[dict] = []

        for i in range(months - 1, -1, -1):
            cycle = _months_ago(i) if i > 0 else _current_billing_cycle()

            all_items = []
            for page in range(1, 51):
                req = bss_models.QueryInstanceBillRequest(
                    billing_cycle=cycle,
                    page_num=page,
                    page_size=100,
                )
                resp = await asyncio.to_thread(client.query_instance_bill, req)
                body = resp.body

                if not body.success:
                    break

                data = body.data
                items = data.items.item if data.items and data.items.item else []
                all_items.extend(items)

                if len(all_items) >= (data.total_count or 0):
                    break

            dim_map: dict[str, float] = {}
            for item in all_items:
                dim_value = "unknown"
                if dimension == "product":
                    dim_value = item.product_name or item.product_code or "unknown"
                elif dimension == "resource_group":
                    dim_value = item.resource_group or "default"
                elif dimension.startswith("tag:"):
                    tag_key = dimension[4:]
                    tag_str = item.tag or ""
                    dim_value = "untagged"
                    if tag_str:
                        # BSS API 返回格式: "key:xxx value:yyy; key:xxx2 value:yyy2"
                        for pair in tag_str.split(";"):
                            pair = pair.strip()
                            parts = pair.split()
                            if len(parts) >= 2:
                                key_part = parts[0]  # "key:xxx"
                                value_part = parts[1]  # "value:yyy"
                                if key_part.startswith("key:") and value_part.startswith("value:"):
                                    k = key_part[4:]  # 去掉 "key:" 前缀
                                    v = value_part[6:]  # 去掉 "value:" 前缀
                                    if k == tag_key:
                                        dim_value = v
                                        break

                cost = _safe_float(item.pretax_amount)
                dim_map[dim_value] = dim_map.get(dim_value, 0.0) + cost

            monthly_breakdown.append({
                "billing_cycle": cycle,
                "breakdown": dim_map,
            })

        # 汇总所有维度值，找 Top N
        total_by_dim: dict[str, float] = {}
        for m in monthly_breakdown:
            for dim_val, cost in m["breakdown"].items():
                total_by_dim[dim_val] = total_by_dim.get(dim_val, 0.0) + cost

        top_dims = sorted(total_by_dim.items(), key=lambda x: x[1], reverse=True)[:top_n]
        top_dim_names = [d[0] for d in top_dims]

        # 构建趋势数据
        trend_data = []
        for m in monthly_breakdown:
            entry = {"billing_cycle": m["billing_cycle"]}
            for dim_name in top_dim_names:
                entry[dim_name] = round(m["breakdown"].get(dim_name, 0.0), 2)
            trend_data.append(entry)

        return json.dumps({
            "success": True,
            "months": months,
            "dimension": dimension,
            "top_n": top_n,
            "dimensions": top_dim_names,
            "trend": trend_data,
        }, ensure_ascii=False, indent=2)

    except Exception as e:
        return json.dumps({
            "success": False, "error": str(e),
        }, ensure_ascii=False)


# =============================================================================
# 价格查询 (2 个函数)
# =============================================================================


async def costf_get_payg_price(
    product_code: str,
    region: str,
    modules: list[dict] = None,
    **kwargs,
) -> str:
    """查询按量付费价格。

    调用 BSS GetPayAsYouGoPrice API。

    Args:
        product_code: 产品代码（如 "ecs", "rds", "slb"）
        region: 区域（如 "cn-hangzhou"）
        modules: 模块配置，如 [{"ModuleCode": "InstanceType", "Config": "ecs.g7.large"}]
        **kwargs: 框架注入的参数

    Returns:
        价格查询结果
    """
    credential = kwargs.get("credential") or get_credential()
    client = _build_bss_client(credential)

    if modules is None:
        modules = []

    try:
        module_list = []
        for m in modules:
            module_code = m.get("ModuleCode", "")
            config_value = m.get("Config", "")
            # API 要求 Config 格式为 "moduleCode:value"
            config_str = f"{module_code}:{config_value}" if module_code and config_value else config_value
            module_list.append(bss_models.GetPayAsYouGoPriceRequestModuleList(
                module_code=module_code,
                config=config_str,
                price_type=m.get("PriceType", "Hour"),
            ))

        req = bss_models.GetPayAsYouGoPriceRequest(
            product_code=product_code,
            region=region,
            subscription_type="PayAsYouGo",
            module_list=module_list if module_list else None,
        )

        resp = await asyncio.to_thread(client.get_pay_as_you_go_price, req)
        body = resp.body

        if not body.success:
            return json.dumps({
                "success": False,
                "error_code": body.code,
                "error_msg": body.message,
            }, ensure_ascii=False)

        data = body.data
        module_details = []
        if data.module_details and data.module_details.module_detail:
            for detail in data.module_details.module_detail:
                module_details.append({
                    "module_code": detail.module_code,
                    "original_cost": _safe_float(detail.original_cost),
                    "invoice_discount": _safe_float(detail.invoice_discount),
                    "cost_after_discount": _safe_float(detail.cost_after_discount),
                })

        return json.dumps({
            "success": True,
            "product_code": product_code,
            "region": region,
            "currency": data.currency or "CNY",
            "price": {
                "original_price": _safe_float(data.order.original_amount) if data.order else 0,
                "trade_price": _safe_float(data.order.trade_amount) if data.order else 0,
                "discount_amount": _safe_float(data.order.discount_amount) if data.order else 0,
            },
            "module_details": module_details,
        }, ensure_ascii=False, indent=2)

    except Exception as e:
        return json.dumps({
            "success": False, "error": str(e),
        }, ensure_ascii=False)


async def costf_get_subscription_price(
    product_code: str,
    region: str,
    modules: list[dict] = None,
    service_period: int = 1,
    order_type: str = "NewOrder",
    **kwargs,
) -> str:
    """查询包年包月价格。

    调用 BSS GetSubscriptionPrice API。

    Args:
        product_code: 产品代码（如 "ecs", "rds", "slb"）
        region: 区域（如 "cn-hangzhou"）
        modules: 模块配置
        service_period: 月数（如 1, 12）
        order_type: "NewOrder" | "Renewal" | "Upgrade"
        **kwargs: 框架注入的参数

    Returns:
        价格查询结果
    """
    credential = kwargs.get("credential") or get_credential()
    client = _build_bss_client(credential)

    if modules is None:
        modules = []

    try:
        module_list = []
        for m in modules:
            module_code = m.get("ModuleCode", "")
            config_value = m.get("Config", "")
            # API 要求 Config 格式为 "moduleCode:value"
            config_str = f"{module_code}:{config_value}" if module_code and config_value else config_value
            module_list.append(bss_models.GetSubscriptionPriceRequestModuleList(
                module_code=module_code,
                config=config_str,
            ))

        req = bss_models.GetSubscriptionPriceRequest(
            product_code=product_code,
            region=region,
            order_type=order_type,
            service_period_quantity=service_period,
            service_period_unit="Month",
            module_list=module_list if module_list else None,
        )

        resp = await asyncio.to_thread(client.get_subscription_price, req)
        body = resp.body

        if not body.success:
            return json.dumps({
                "success": False,
                "error_code": body.code,
                "error_msg": body.message,
            }, ensure_ascii=False)

        data = body.data
        module_details = []
        if data.module_details and data.module_details.module_detail:
            for detail in data.module_details.module_detail:
                module_details.append({
                    "module_code": detail.module_code,
                    "original_cost": _safe_float(detail.original_cost),
                    "invoice_discount": _safe_float(detail.invoice_discount),
                    "cost_after_discount": _safe_float(detail.cost_after_discount),
                })

        return json.dumps({
            "success": True,
            "product_code": product_code,
            "region": region,
            "order_type": order_type,
            "service_period_months": service_period,
            "currency": data.currency or "CNY",
            "price": {
                "original_price": _safe_float(data.order.original_amount) if data.order else 0,
                "trade_price": _safe_float(data.order.trade_amount) if data.order else 0,
                "discount_amount": _safe_float(data.order.discount_amount) if data.order else 0,
            },
            "module_details": module_details,
        }, ensure_ascii=False, indent=2)

    except Exception as e:
        return json.dumps({
            "success": False, "error": str(e),
        }, ensure_ascii=False)


# =============================================================================
# 费率覆盖分析 (3 个函数)
# =============================================================================


async def costf_savings_plan_analysis(
    strategy: str = "default",
    **kwargs,
) -> str:
    """节省计划分析。

    查询活跃的节省计划列表，分析利用率、覆盖率，
    预警 30 天内到期的节省计划。

    Args:
        strategy: 分析策略，默认 "default"
        **kwargs: 框架注入的参数

    Returns:
        节省计划分析结果
    """
    credential = kwargs.get("credential") or get_credential()
    client = _build_bss_client(credential)

    now = datetime.now(timezone.utc)
    warn_date = now + timedelta(days=30)

    try:
        req = bss_models.QuerySavingsPlansInstanceRequest(
            page_num=1,
            page_size=100,
        )
        resp = await asyncio.to_thread(client.query_savings_plans_instance, req)
        body = resp.body

        if not body.success:
            return json.dumps({
                "success": False,
                "error_code": body.code,
                "error_msg": body.message,
            }, ensure_ascii=False)

        data = body.data
        items = data.items if data and data.items else []

        plans = []
        expiring_soon = []
        total_commitment = 0.0

        for item in items:
            plan_id = item.instance_id if hasattr(item, "instance_id") else ""
            plan_type = item.savings_type if hasattr(item, "savings_type") else ""
            status = item.status if hasattr(item, "status") else ""
            commitment = _safe_float(item.pool_value if hasattr(item, "pool_value") else 0)
            start_time = item.start_time if hasattr(item, "start_time") else ""
            end_time = item.end_time if hasattr(item, "end_time") else ""
            utilization = _safe_float(item.utilization if hasattr(item, "utilization") else 0)

            total_commitment += commitment

            plan_info = {
                "instance_id": plan_id,
                "type": plan_type,
                "status": status,
                "commitment_amount": round(commitment, 2),
                "start_time": start_time,
                "end_time": end_time,
                "utilization_percent": round(utilization, 1),
            }
            plans.append(plan_info)

            if end_time:
                try:
                    if end_time.endswith("Z"):
                        end_dt = datetime.fromisoformat(end_time.replace("Z", "+00:00"))
                    else:
                        end_dt = datetime.fromisoformat(end_time)
                    if end_dt <= warn_date:
                        days_left = (end_dt - now).days
                        plan_info["days_until_expiry"] = max(days_left, 0)
                        expiring_soon.append(plan_info)
                except (ValueError, TypeError):
                    pass

        avg_utilization = (
            round(sum(p["utilization_percent"] for p in plans) / len(plans), 1)
            if plans else 0
        )

        return json.dumps({
            "success": True,
            "total_plans": len(plans),
            "total_commitment_amount": round(total_commitment, 2),
            "average_utilization_percent": avg_utilization,
            "expiring_within_30d": len(expiring_soon),
            "plans": plans,
            "expiring_soon": expiring_soon,
            "recommendation": (
                "节省计划利用率偏低，建议审查承诺金额是否过高"
                if avg_utilization < 80 and plans
                else None
            ),
        }, ensure_ascii=False, indent=2)

    except Exception as e:
        return json.dumps({
            "success": False, "error": str(e),
        }, ensure_ascii=False)


async def costf_ri_coverage_analysis(
    region: str = "cn-hangzhou",
    strategy: str = "default",
    **kwargs,
) -> str:
    """预留实例券覆盖率分析。

    查询当前区域的预留实例券列表，分析覆盖率和利用率。

    Args:
        region: 区域 ID
        strategy: 分析策略，默认 "default"
        **kwargs: 框架注入的参数

    Returns:
        预留实例覆盖率分析结果
    """
    credential = kwargs.get("credential") or get_credential()
    ecs_client = _build_ecs_client(credential, region)

    now = datetime.now(timezone.utc)
    warn_date = now + timedelta(days=30)

    try:
        req = ecs_models.DescribeReservedInstancesRequest(
            region_id=region,
        )
        resp = await asyncio.to_thread(ecs_client.describe_reserved_instances, req)
        body = resp.body

        ris_raw = body.reserved_instances
        ris = ris_raw.reserved_instance if ris_raw and hasattr(ris_raw, "reserved_instance") else []

        ri_list = []
        expiring_soon = []
        active_count = 0

        for ri in ris:
            ri_id = ri.reserved_instance_id if hasattr(ri, "reserved_instance_id") else ""
            status = ri.status if hasattr(ri, "status") else ""
            inst_type = ri.instance_type if hasattr(ri, "instance_type") else ""
            instance_amount = _safe_int(ri.instance_amount if hasattr(ri, "instance_amount") else 0)
            start_time = ri.start_time if hasattr(ri, "start_time") else ""
            expired_time = ri.expired_time if hasattr(ri, "expired_time") else ""

            if status == "Active":
                active_count += 1

            ri_info = {
                "reserved_instance_id": ri_id,
                "status": status,
                "instance_type": inst_type,
                "instance_amount": instance_amount,
                "start_time": start_time,
                "expired_time": expired_time,
            }
            ri_list.append(ri_info)

            if expired_time:
                try:
                    if expired_time.endswith("Z"):
                        exp_dt = datetime.fromisoformat(expired_time.replace("Z", "+00:00"))
                    else:
                        exp_dt = datetime.fromisoformat(expired_time)
                    if exp_dt <= warn_date:
                        days_left = (exp_dt - now).days
                        ri_info["days_until_expiry"] = max(days_left, 0)
                        expiring_soon.append(ri_info)
                except (ValueError, TypeError):
                    pass

        return json.dumps({
            "success": True,
            "region": region,
            "total_reserved_instances": len(ri_list),
            "active_count": active_count,
            "expiring_within_30d": len(expiring_soon),
            "reserved_instances": ri_list,
            "expiring_soon": expiring_soon,
        }, ensure_ascii=False, indent=2)

    except Exception as e:
        return json.dumps({
            "success": False, "error": str(e),
        }, ensure_ascii=False)


async def costf_charge_type_distribution(
    region: str = "cn-hangzhou",
    strategy: str = "default",
    **kwargs,
) -> str:
    """付费方式分布分析。

    分析 ECS 实例的付费方式分布（按量/包年包月/抢占式），
    识别长期运行的按量实例并建议转包年包月。

    Args:
        region: 区域 ID
        strategy: 分析策略，默认 "default"
        **kwargs: 框架注入的参数

    Returns:
        付费方式分布分析
    """
    credential = kwargs.get("credential") or get_credential()
    ecs_client = _build_ecs_client(credential, region)

    now = datetime.now(timezone.utc)
    long_running_threshold_days = 180

    try:
        all_instances = []
        page = 1
        while True:
            req = ecs_models.DescribeInstancesRequest(
                region_id=region,
                page_number=page,
                page_size=100,
            )
            resp = await asyncio.to_thread(ecs_client.describe_instances, req)
            body = resp.body
            if body.instances and body.instances.instance:
                all_instances.extend(body.instances.instance)
            total = body.total_count or 0
            if len(all_instances) >= total:
                break
            page += 1

        by_charge_type: dict[str, dict] = {}
        long_running_payg = []

        for inst in all_instances:
            charge_type = inst.instance_charge_type or "PostPaid"
            inst_id = inst.instance_id or ""
            inst_name = inst.instance_name or ""
            inst_type = inst.instance_type or ""
            creation_time = inst.creation_time or ""

            ct_label = {
                "PostPaid": "按量付费",
                "PrePaid": "包年包月",
                "SpotInstance": "抢占式",
            }.get(charge_type, charge_type)

            if ct_label not in by_charge_type:
                by_charge_type[ct_label] = {"count": 0, "charge_type": charge_type}
            by_charge_type[ct_label]["count"] += 1

            if charge_type == "PostPaid" and creation_time:
                try:
                    if creation_time.endswith("Z"):
                        created = datetime.fromisoformat(creation_time.replace("Z", "+00:00"))
                    else:
                        created = datetime.fromisoformat(creation_time)
                    running_days = (now - created).days
                    if running_days >= long_running_threshold_days:
                        long_running_payg.append({
                            "instance_id": inst_id,
                            "instance_name": inst_name,
                            "instance_type": inst_type,
                            "running_days": running_days,
                            "recommendation": (
                                f"该按量实例已运行 {running_days} 天，"
                                "建议评估转包年包月以节省费用（通常可节省 30-50%）"
                            ),
                        })
                except (ValueError, TypeError):
                    pass

        total_instances = len(all_instances)
        for info in by_charge_type.values():
            info["percent"] = round(info["count"] / total_instances * 100, 1) if total_instances > 0 else 0

        return json.dumps({
            "success": True,
            "region": region,
            "total_instances": total_instances,
            "by_charge_type": by_charge_type,
            "long_running_payg_count": len(long_running_payg),
            "long_running_payg_instances": long_running_payg[:50],
            "note": f"长期运行按量实例定义：运行超过 {long_running_threshold_days} 天",
        }, ensure_ascii=False, indent=2)

    except Exception as e:
        return json.dumps({
            "success": False, "error": str(e),
        }, ensure_ascii=False)

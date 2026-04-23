# -*- coding: utf-8 -*-
"""阿里云成本智能推断引擎 — 异常根因分析、价格估算、购买推荐与费用分摊。

全部 READ 操作，风险等级 LOW。提供基于分析推断的智能成本优化能力。
"""

import asyncio
import json
import logging
import statistics
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
# 静态单价表（用于 API 失败时的回退估算）
# =============================================================================


_ECS_PRICE_ESTIMATE = {
    # 通用型 g7 系列 (CNY/hour)
    "ecs.g7.large": 0.98,
    "ecs.g7.xlarge": 1.96,
    "ecs.g7.2xlarge": 3.92,
    "ecs.g7.4xlarge": 7.84,
    "ecs.g7.8xlarge": 15.68,
    # 通用型 g6 系列
    "ecs.g6.large": 0.85,
    "ecs.g6.xlarge": 1.70,
    "ecs.g6.2xlarge": 3.40,
    "ecs.g6.4xlarge": 6.80,
    # 计算型 c7 系列
    "ecs.c7.large": 0.82,
    "ecs.c7.xlarge": 1.64,
    "ecs.c7.2xlarge": 3.28,
    "ecs.c7.4xlarge": 6.56,
    # 内存型 r7 系列
    "ecs.r7.large": 1.14,
    "ecs.r7.xlarge": 2.28,
    "ecs.r7.2xlarge": 4.56,
    "ecs.r7.4xlarge": 9.12,
}

# 每核心粗略估算价格（用于未知规格）
_PRICE_PER_CORE_ESTIMATE = 0.25  # CNY/hour/core


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
    """构建 BSS OpenAPI 客户端。"""
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


def _extract_cpu_cores(instance_type: str) -> int:
    """从实例规格名称提取 CPU 核心数估算。"""
    # 格式如 ecs.g7.xlarge -> xlarge 对应 4 核
    size_to_cores = {
        "small": 1,
        "medium": 2,
        "large": 2,
        "xlarge": 4,
        "2xlarge": 8,
        "4xlarge": 16,
        "8xlarge": 32,
        "16xlarge": 64,
    }
    parts = instance_type.split(".")
    if len(parts) >= 3:
        size = parts[-1]
        return size_to_cores.get(size, 2)
    return 2


# =============================================================================
# 异常分析 (2 个函数)
# =============================================================================


async def costi_anomaly_detection(
    days_back: int = 30,
    sigma_threshold: float = 2.0,
    **kwargs,
) -> str:
    """检测成本异常。

    查询最近 N 天的日账单，使用均值+标准差方法检测异常消费日。

    Args:
        days_back: 分析天数，默认 30
        sigma_threshold: 异常判定标准差倍数，默认 2.0
        **kwargs: 框架注入的参数

    Returns:
        异常检测结果的 JSON 字符串
    """
    credential = kwargs.get("credential") or get_credential()
    client = _build_bss_client(credential)

    today = datetime.now(timezone.utc)

    try:
        daily_map: dict[str, float] = {}

        # 生成查询日期列表
        dates_to_query = []
        for i in range(days_back):
            dt = today - timedelta(days=i+1)  # 从昨天开始
            dates_to_query.append(dt.strftime("%Y-%m-%d"))
        
        # 按天查询 (DAILY 粒度必须指定 BillingDate)
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

        filtered = {d: c for d, c in daily_map.items() if c > 0}

        if len(filtered) < 3:
            return json.dumps({
                "success": True,
                "message": f"数据不足（仅 {len(filtered)} 天），无法进行异常检测",
                "anomalies": [],
            }, ensure_ascii=False, indent=2)

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

        return json.dumps({
            "success": True,
            "period_days": len(filtered),
            "mean_daily_cost": round(mean, 2),
            "stdev": round(stdev, 2),
            "threshold": round(threshold, 2),
            "sigma_threshold": sigma_threshold,
            "anomaly_count": len(anomalies),
            "anomalies": anomalies,
        }, ensure_ascii=False, indent=2)

    except Exception as e:
        return json.dumps({
            "success": False, "error": str(e),
        }, ensure_ascii=False)


async def costi_anomaly_root_cause(
    anomaly_date: str,
    product_code: Optional[str] = None,
    **kwargs,
) -> str:
    """对指定日期的异常进行根因下钻。

    对比异常日与前 7 天平均，按产品/区域/实例维度定位变化最大的项。

    Args:
        anomaly_date: 异常日期，格式 "YYYY-MM-DD"
        product_code: 限定产品（可选）
        **kwargs: 框架注入的参数

    Returns:
        根因分析结果
    """
    credential = kwargs.get("credential") or get_credential()
    client = _build_bss_client(credential)

    try:
        anomaly_dt = datetime.strptime(anomaly_date, "%Y-%m-%d")
    except ValueError:
        return json.dumps({
            "success": False,
            "error": "日期格式错误，应为 YYYY-MM-DD",
        }, ensure_ascii=False)

    try:
        # 获取异常日和前 7 天的数据
        dates_to_check = [anomaly_date]
        for i in range(1, 8):
            dt = anomaly_dt - timedelta(days=i)
            dates_to_check.append(dt.strftime("%Y-%m-%d"))

        cycles = set(d[:7] for d in dates_to_check)

        # 按日期收集实例账单
        daily_bills: dict[str, list] = {d: [] for d in dates_to_check}

        for cycle in cycles:
            for page in range(1, 51):
                req = bss_models.QueryInstanceBillRequest(
                    billing_cycle=cycle,
                    page_num=page,
                    page_size=100,
                )
                if product_code:
                    req.product_code = product_code

                resp = await asyncio.to_thread(client.query_instance_bill, req)
                body = resp.body

                if not body.success:
                    break

                data = body.data
                items = data.items.item if data.items and data.items.item else []

                for item in items:
                    bill_date = item.billing_date or ""
                    if bill_date in daily_bills:
                        daily_bills[bill_date].append(item)

                if len(items) < 100:
                    break

        # 计算异常日费用
        anomaly_by_product: dict[str, float] = {}
        anomaly_by_region: dict[str, float] = {}
        anomaly_total = 0.0

        for item in daily_bills[anomaly_date]:
            pname = item.product_name or item.product_code or "unknown"
            region = item.region or "global"
            cost = _safe_float(item.pretax_amount)

            anomaly_by_product[pname] = anomaly_by_product.get(pname, 0.0) + cost
            anomaly_by_region[region] = anomaly_by_region.get(region, 0.0) + cost
            anomaly_total += cost

        # 计算前 7 天平均
        baseline_by_product: dict[str, float] = {}
        baseline_by_region: dict[str, float] = {}
        baseline_total = 0.0
        baseline_days = 0

        for d in dates_to_check[1:]:
            if daily_bills[d]:
                baseline_days += 1
                for item in daily_bills[d]:
                    pname = item.product_name or item.product_code or "unknown"
                    region = item.region or "global"
                    cost = _safe_float(item.pretax_amount)

                    baseline_by_product[pname] = baseline_by_product.get(pname, 0.0) + cost
                    baseline_by_region[region] = baseline_by_region.get(region, 0.0) + cost
                    baseline_total += cost

        if baseline_days > 0:
            for k in baseline_by_product:
                baseline_by_product[k] /= baseline_days
            for k in baseline_by_region:
                baseline_by_region[k] /= baseline_days
            baseline_total /= baseline_days

        # 计算差异
        root_causes = []

        # 产品维度
        for pname, anomaly_cost in anomaly_by_product.items():
            baseline_cost = baseline_by_product.get(pname, 0.0)
            delta = anomaly_cost - baseline_cost
            delta_pct = round(delta / baseline_cost * 100, 1) if baseline_cost > 0 else 100.0
            if abs(delta) > 10:  # 至少 10 元差异
                root_causes.append({
                    "dimension": "product",
                    "item": pname,
                    "anomaly_cost": round(anomaly_cost, 2),
                    "baseline_cost": round(baseline_cost, 2),
                    "delta_cny": round(delta, 2),
                    "delta_percent": delta_pct,
                })

        # 区域维度
        for region, anomaly_cost in anomaly_by_region.items():
            baseline_cost = baseline_by_region.get(region, 0.0)
            delta = anomaly_cost - baseline_cost
            delta_pct = round(delta / baseline_cost * 100, 1) if baseline_cost > 0 else 100.0
            if abs(delta) > 10:
                root_causes.append({
                    "dimension": "region",
                    "item": region,
                    "anomaly_cost": round(anomaly_cost, 2),
                    "baseline_cost": round(baseline_cost, 2),
                    "delta_cny": round(delta, 2),
                    "delta_percent": delta_pct,
                })

        # 按差异金额排序
        root_causes.sort(key=lambda x: abs(x["delta_cny"]), reverse=True)

        return json.dumps({
            "success": True,
            "anomaly_date": anomaly_date,
            "anomaly_total": round(anomaly_total, 2),
            "baseline_average": round(baseline_total, 2),
            "total_delta": round(anomaly_total - baseline_total, 2),
            "baseline_days": baseline_days,
            "root_causes": root_causes[:10],
        }, ensure_ascii=False, indent=2)

    except Exception as e:
        return json.dumps({
            "success": False, "error": str(e),
        }, ensure_ascii=False)


# =============================================================================
# 预测与估算 (2 个函数)
# =============================================================================


async def costi_forecast(
    months_ahead: int = 1,
    method: str = "linear",
    **kwargs,
) -> str:
    """基于历史数据预测未来费用。

    Args:
        months_ahead: 预测月数，默认 1
        method: 预测方法 "linear" | "seasonal"
        **kwargs: 框架注入的参数

    Returns:
        费用预测结果
    """
    credential = kwargs.get("credential") or get_credential()
    client = _build_bss_client(credential)

    history_months = 6

    try:
        monthly_totals = []
        for i in range(history_months, 0, -1):
            cycle = _months_ago(i)
            req = bss_models.QueryBillOverviewRequest(billing_cycle=cycle)
            resp = await asyncio.to_thread(client.query_bill_overview, req)
            body = resp.body

            total = 0.0
            if body.success:
                data = body.data
                items = data.items.item if data.items and data.items.item else []
                for item in items:
                    total += _safe_float(item.pretax_amount)

            monthly_totals.append({
                "billing_cycle": cycle,
                "total": round(total, 2),
            })

        if len(monthly_totals) < 3:
            return json.dumps({
                "success": True,
                "message": "数据不足，无法预测",
                "forecast": None,
            }, ensure_ascii=False, indent=2)

        n = len(monthly_totals)
        xs = list(range(n))
        ys = [m["total"] for m in monthly_totals]

        forecasts = []

        if method == "linear":
            # 简单线性回归
            x_mean = sum(xs) / n
            y_mean = sum(ys) / n

            numerator = sum((x - x_mean) * (y - y_mean) for x, y in zip(xs, ys))
            denominator = sum((x - x_mean) ** 2 for x in xs)

            if denominator == 0:
                slope = 0
            else:
                slope = numerator / denominator
            intercept = y_mean - slope * x_mean

            for ahead in range(1, months_ahead + 1):
                forecast_value = max(intercept + slope * (n + ahead - 1), 0)
                forecasts.append({
                    "month_ahead": ahead,
                    "predicted_amount": round(forecast_value, 2),
                })

            return json.dumps({
                "success": True,
                "method": "linear_regression",
                "data_months": n,
                "historical": monthly_totals,
                "trend_slope": round(slope, 2),
                "forecasts": forecasts,
                "note": "正斜率表示费用上升趋势，负斜率表示下降趋势",
                "disclaimer": "此为基于历史数据的简单线性预测，仅供参考",
            }, ensure_ascii=False, indent=2)

        elif method == "seasonal":
            # 季节性调整（简单移动平均 + 季节因子）
            # 使用最近 3 个月的平均作为基础
            recent_avg = sum(ys[-3:]) / 3

            # 计算季节因子（假设年周期）
            # 如果历史数据不足一年，使用简单增长率
            growth_rate = 0.0
            if len(ys) >= 2:
                growth_rate = (ys[-1] - ys[0]) / ys[0] if ys[0] > 0 else 0

            for ahead in range(1, months_ahead + 1):
                seasonal_factor = 1 + growth_rate * ahead / n
                forecast_value = max(recent_avg * seasonal_factor, 0)
                forecasts.append({
                    "month_ahead": ahead,
                    "predicted_amount": round(forecast_value, 2),
                })

            return json.dumps({
                "success": True,
                "method": "seasonal_adjusted",
                "data_months": n,
                "historical": monthly_totals,
                "recent_average": round(recent_avg, 2),
                "growth_rate": round(growth_rate * 100, 1),
                "forecasts": forecasts,
                "disclaimer": "此为基于历史数据的季节性调整预测，仅供参考",
            }, ensure_ascii=False, indent=2)

        else:
            return json.dumps({
                "success": False,
                "error": f"不支持的预测方法: {method}，可选: linear, seasonal",
            }, ensure_ascii=False)

    except Exception as e:
        return json.dumps({
            "success": False, "error": str(e),
        }, ensure_ascii=False)


async def costi_estimate_resource_price(
    product: str,
    spec: str,
    charge_type: str = "PayAsYouGo",
    period: int = 1,
    region: str = "cn-hangzhou",
    **kwargs,
) -> str:
    """高层级资源价格估算（含回退方案）。

    流程: 先尝试 API 查询 → API 失败则用静态单价表 → 无匹配则按 CPU 核数粗略估算

    Args:
        product: 产品类型（如 "ecs"）
        spec: 规格（如 "ecs.g7.large"）
        charge_type: 付费类型 "PayAsYouGo" | "Subscription"
        period: 包年包月月数，默认 1
        region: 区域，默认 cn-hangzhou
        **kwargs: 框架注入的参数

    Returns:
        价格估算结果
    """
    credential = kwargs.get("credential") or get_credential()
    client = _build_bss_client(credential)

    price_source = "api"
    price = 0.0
    unit = "CNY/hour" if charge_type == "PayAsYouGo" else "CNY/month"

    try:
        # 尝试 API 查询
        if charge_type == "PayAsYouGo":
            req = bss_models.GetPayAsYouGoPriceRequest(
                product_code=product,
                region=region,
                subscription_type="PayAsYouGo",
                module_list=[
                    bss_models.GetPayAsYouGoPriceRequestModuleList(
                        module_code="InstanceType",
                        config=f"InstanceType:{spec}",  # API 要求 Config 格式为 "moduleCode:value"
                        price_type="Hour",
                    )
                ],
            )
            resp = await asyncio.to_thread(client.get_pay_as_you_go_price, req)
            body = resp.body

            if body.success and body.data and body.data.order:
                price = _safe_float(body.data.order.trade_amount)
                if price > 0:
                    return json.dumps({
                        "success": True,
                        "product": product,
                        "spec": spec,
                        "charge_type": charge_type,
                        "region": region,
                        "price": round(price, 4),
                        "unit": unit,
                        "price_source": "api",
                    }, ensure_ascii=False, indent=2)

        else:
            req = bss_models.GetSubscriptionPriceRequest(
                product_code=product,
                region=region,
                order_type="NewOrder",
                service_period_quantity=period,
                service_period_unit="Month",
                module_list=[
                    bss_models.GetSubscriptionPriceRequestModuleList(
                        module_code="InstanceType",
                        config=f"InstanceType:{spec}",  # API 要求 Config 格式为 "moduleCode:value"
                    )
                ],
            )
            resp = await asyncio.to_thread(client.get_subscription_price, req)
            body = resp.body

            if body.success and body.data and body.data.order:
                price = _safe_float(body.data.order.trade_amount)
                if price > 0:
                    return json.dumps({
                        "success": True,
                        "product": product,
                        "spec": spec,
                        "charge_type": charge_type,
                        "period_months": period,
                        "region": region,
                        "price": round(price, 2),
                        "unit": unit,
                        "price_source": "api",
                    }, ensure_ascii=False, indent=2)

    except Exception:
        pass

    # 回退到静态单价表
    if spec in _ECS_PRICE_ESTIMATE:
        hourly_price = _ECS_PRICE_ESTIMATE[spec]
        if charge_type == "PayAsYouGo":
            price = hourly_price
            unit = "CNY/hour"
        else:
            price = hourly_price * 24 * 30 * period * 0.7  # 包年包月约 7 折
            unit = "CNY/month"

        return json.dumps({
            "success": True,
            "product": product,
            "spec": spec,
            "charge_type": charge_type,
            "region": region,
            "price": round(price, 2),
            "unit": unit,
            "price_source": "fallback_static_table",
            "note": "价格来自静态单价表，仅供参考",
        }, ensure_ascii=False, indent=2)

    # 最后回退：按 CPU 核数粗略估算
    cores = _extract_cpu_cores(spec)
    hourly_price = cores * _PRICE_PER_CORE_ESTIMATE
    if charge_type == "PayAsYouGo":
        price = hourly_price
        unit = "CNY/hour"
    else:
        price = hourly_price * 24 * 30 * period * 0.7
        unit = "CNY/month"

    return json.dumps({
        "success": True,
        "product": product,
        "spec": spec,
        "charge_type": charge_type,
        "region": region,
        "price": round(price, 2),
        "unit": unit,
        "price_source": "fallback_cpu_estimate",
        "estimated_cores": cores,
        "note": f"价格按 {cores} 核 × {_PRICE_PER_CORE_ESTIMATE} CNY/hour/核 粗略估算，仅供参考",
    }, ensure_ascii=False, indent=2)


# =============================================================================
# 购买推荐 (3 个函数)
# =============================================================================


async def costi_sp_purchase_recommendation(
    lookback_months: int = 3,
    **kwargs,
) -> str:
    """分析历史按量消费，推荐 SP 购买方案。

    计算: 按量消费均值 × 承诺折扣率 = 预估节省

    Args:
        lookback_months: 回溯月数，默认 3
        **kwargs: 框架注入的参数

    Returns:
        SP 购买推荐
    """
    credential = kwargs.get("credential") or get_credential()
    client = _build_bss_client(credential)

    try:
        # 收集历史按量消费
        payg_by_month = []

        for i in range(lookback_months, 0, -1):
            cycle = _months_ago(i)

            all_items = []
            for page in range(1, 51):
                req = bss_models.QueryAccountBillRequest(
                    billing_cycle=cycle,
                    page_num=page,
                    page_size=100,
                    is_group_by_product=True,
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

            # 统计按量消费
            payg_total = 0.0
            for item in all_items:
                if item.subscription_type == "PayAsYouGo":
                    payg_total += _safe_float(item.pretax_amount)

            payg_by_month.append({
                "billing_cycle": cycle,
                "payg_cost": round(payg_total, 2),
            })

        if not payg_by_month:
            return json.dumps({
                "success": True,
                "message": "无历史数据",
                "recommendations": [],
            }, ensure_ascii=False, indent=2)

        avg_payg = sum(m["payg_cost"] for m in payg_by_month) / len(payg_by_month)

        # SP 通常可节省 20-40%
        sp_discount_rates = [
            {"commitment_percent": 50, "discount_rate": 0.25},
            {"commitment_percent": 70, "discount_rate": 0.30},
            {"commitment_percent": 90, "discount_rate": 0.35},
        ]

        recommendations = []
        for rate in sp_discount_rates:
            commitment = avg_payg * rate["commitment_percent"] / 100
            savings = commitment * rate["discount_rate"]
            recommendations.append({
                "commitment_percent": rate["commitment_percent"],
                "recommended_commitment_cny": round(commitment, 2),
                "estimated_discount_rate": f"{int(rate['discount_rate'] * 100)}%",
                "estimated_monthly_savings": round(savings, 2),
            })

        best_rec = max(recommendations, key=lambda x: x["estimated_monthly_savings"])

        return json.dumps({
            "success": True,
            "lookback_months": lookback_months,
            "average_payg_monthly": round(avg_payg, 2),
            "historical_data": payg_by_month,
            "recommendations": recommendations,
            "best_recommendation": best_rec,
            "note": "节省计划承诺金额建议基于历史按量消费均值的一定比例",
        }, ensure_ascii=False, indent=2)

    except Exception as e:
        return json.dumps({
            "success": False, "error": str(e),
        }, ensure_ascii=False)


async def costi_ri_purchase_recommendation(
    product_code: str = "ecs",
    region: str = "cn-hangzhou",
    **kwargs,
) -> str:
    """分析特定产品/区域的 RI 购买机会。

    Args:
        product_code: 产品代码，默认 ecs
        region: 区域，默认 cn-hangzhou
        **kwargs: 框架注入的参数

    Returns:
        RI 购买推荐
    """
    credential = kwargs.get("credential") or get_credential()
    ecs_client = _build_ecs_client(credential, region)

    try:
        # 获取当前运行中的按量实例
        all_instances = []
        page = 1
        while True:
            req = ecs_models.DescribeInstancesRequest(
                region_id=region,
                page_number=page,
                page_size=100,
                instance_charge_type="PostPaid",
            )
            resp = await asyncio.to_thread(ecs_client.describe_instances, req)
            body = resp.body
            if body.instances and body.instances.instance:
                all_instances.extend(body.instances.instance)
            total = body.total_count or 0
            if len(all_instances) >= total:
                break
            page += 1

        now = datetime.now(timezone.utc)
        long_running_threshold = 30  # 30 天以上

        # 按规格聚合长期运行的按量实例
        by_instance_type: dict[str, list] = {}

        for inst in all_instances:
            inst_type = inst.instance_type or ""
            creation_time = inst.creation_time or ""

            if creation_time:
                try:
                    if creation_time.endswith("Z"):
                        created = datetime.fromisoformat(creation_time.replace("Z", "+00:00"))
                    else:
                        created = datetime.fromisoformat(creation_time)
                    running_days = (now - created).days

                    if running_days >= long_running_threshold:
                        if inst_type not in by_instance_type:
                            by_instance_type[inst_type] = []
                        by_instance_type[inst_type].append({
                            "instance_id": inst.instance_id,
                            "instance_name": inst.instance_name,
                            "running_days": running_days,
                        })
                except (ValueError, TypeError):
                    pass

        recommendations = []
        for inst_type, instances in by_instance_type.items():
            count = len(instances)
            # RI 通常可节省 30-50%
            hourly_price = _ECS_PRICE_ESTIMATE.get(inst_type, 1.0)
            monthly_payg = hourly_price * 24 * 30 * count
            monthly_ri = monthly_payg * 0.6  # 假设 RI 价格约为按量的 60%
            savings = monthly_payg - monthly_ri

            recommendations.append({
                "instance_type": inst_type,
                "instance_count": count,
                "avg_running_days": round(sum(i["running_days"] for i in instances) / count, 0),
                "estimated_payg_monthly": round(monthly_payg, 2),
                "estimated_ri_monthly": round(monthly_ri, 2),
                "estimated_monthly_savings": round(savings, 2),
                "instances": instances[:5],  # 最多显示 5 个实例
            })

        recommendations.sort(key=lambda x: x["estimated_monthly_savings"], reverse=True)

        total_savings = sum(r["estimated_monthly_savings"] for r in recommendations)

        return json.dumps({
            "success": True,
            "region": region,
            "product_code": product_code,
            "long_running_threshold_days": long_running_threshold,
            "total_payg_instances": len(all_instances),
            "ri_candidate_types": len(recommendations),
            "estimated_total_monthly_savings": round(total_savings, 2),
            "recommendations": recommendations,
            "note": "建议对长期稳定运行的按量实例购买预留实例以降低成本",
        }, ensure_ascii=False, indent=2)

    except Exception as e:
        return json.dumps({
            "success": False, "error": str(e),
        }, ensure_ascii=False)


async def costi_charge_type_optimization(
    region: str = "cn-hangzhou",
    strategy: str = "default",
    **kwargs,
) -> str:
    """分析付费方式分布，给出优化建议。

    如: "按量实例 A 已连续运行 90 天，建议转包年包月可节省 40%"

    Args:
        region: 区域，默认 cn-hangzhou
        strategy: 分析策略，默认 "default"
        **kwargs: 框架注入的参数

    Returns:
        付费方式优化建议
    """
    credential = kwargs.get("credential") or get_credential()
    ecs_client = _build_ecs_client(credential, region)

    now = datetime.now(timezone.utc)

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

        optimizations = []
        total_potential_savings = 0.0

        for inst in all_instances:
            charge_type = inst.instance_charge_type or "PostPaid"
            inst_id = inst.instance_id or ""
            inst_name = inst.instance_name or ""
            inst_type = inst.instance_type or ""
            creation_time = inst.creation_time or ""

            if charge_type == "PostPaid" and creation_time:
                try:
                    if creation_time.endswith("Z"):
                        created = datetime.fromisoformat(creation_time.replace("Z", "+00:00"))
                    else:
                        created = datetime.fromisoformat(creation_time)
                    running_days = (now - created).days

                    # 运行超过 60 天建议转包年包月
                    if running_days >= 60:
                        hourly_price = _ECS_PRICE_ESTIMATE.get(inst_type, 1.0)
                        monthly_payg = hourly_price * 24 * 30
                        monthly_prepaid = monthly_payg * 0.6  # 包年包月约 60%
                        savings = monthly_payg - monthly_prepaid
                        savings_pct = round((1 - 0.6) * 100)

                        total_potential_savings += savings

                        optimizations.append({
                            "instance_id": inst_id,
                            "instance_name": inst_name,
                            "instance_type": inst_type,
                            "current_charge_type": "按量付费",
                            "running_days": running_days,
                            "monthly_payg_cost": round(monthly_payg, 2),
                            "monthly_prepaid_cost": round(monthly_prepaid, 2),
                            "potential_monthly_savings": round(savings, 2),
                            "savings_percent": f"{savings_pct}%",
                            "recommendation": f"该按量实例已运行 {running_days} 天，建议转包年包月可节省约 {savings_pct}%",
                        })
                except (ValueError, TypeError):
                    pass

        optimizations.sort(key=lambda x: x["potential_monthly_savings"], reverse=True)

        return json.dumps({
            "success": True,
            "region": region,
            "total_instances": len(all_instances),
            "optimization_candidates": len(optimizations),
            "total_potential_monthly_savings": round(total_potential_savings, 2),
            "optimizations": optimizations[:20],
            "note": "建议对运行超过 60 天的按量实例评估转包年包月",
        }, ensure_ascii=False, indent=2)

    except Exception as e:
        return json.dumps({
            "success": False, "error": str(e),
        }, ensure_ascii=False)


# =============================================================================
# 费用分摊 (1 个函数)
# =============================================================================


async def costi_shared_cost_allocation(
    billing_cycle: str = "",
    allocation_rules: dict = None,
    auto_detect: bool = True,
    dimension: str = "tag:team",
    **kwargs,
) -> str:
    """共享资源费用分摊。

    Args:
        billing_cycle: 账期，默认上月
        allocation_rules: 手动分摊规则，可选
        auto_detect: 是否自动检测共享资源
        dimension: 分摊维度，如 "tag:team"
        **kwargs: 框架注入的参数

    Returns:
        费用分摊结果
    """
    credential = kwargs.get("credential") or get_credential()
    client = _build_bss_client(credential)

    if not billing_cycle:
        billing_cycle = _months_ago(1)

    if allocation_rules is None:
        allocation_rules = {}

    try:
        # 获取所有实例账单
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

        # 提取维度值
        dim_key = dimension.split(":")[-1] if ":" in dimension else dimension

        # 按维度聚合直接成本
        direct_costs: dict[str, float] = {}
        shared_costs: dict[str, float] = {}
        shared_items = []

        for item in all_items:
            cost = _safe_float(item.pretax_amount)
            pcode = item.product_code or ""

            # 提取维度值
            dim_value = "unallocated"
            if dimension.startswith("tag:"):
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
                                if k == dim_key:
                                    dim_value = v
                                    break

            # 判断是否为共享资源
            is_shared = False
            if auto_detect:
                # SLB, NAT, 带宽包等通常是共享资源
                shared_products = ["slb", "nat", "cbwp", "cdn", "ga"]
                if pcode.lower() in shared_products:
                    is_shared = True

            # 手动规则覆盖
            if pcode in allocation_rules:
                is_shared = True

            if is_shared:
                shared_items.append({
                    "product_code": pcode,
                    "instance_id": item.instance_id,
                    "cost": cost,
                    "original_dimension": dim_value,
                })
            else:
                direct_costs[dim_value] = direct_costs.get(dim_value, 0.0) + cost

        # 分摊共享成本（按直接成本比例）
        total_direct = sum(direct_costs.values())
        for item in shared_items:
            for dim_value, direct in direct_costs.items():
                ratio = direct / total_direct if total_direct > 0 else 0
                allocated = item["cost"] * ratio
                shared_costs[dim_value] = shared_costs.get(dim_value, 0.0) + allocated

        # 汇总
        allocations = {}
        all_dims = set(direct_costs.keys()) | set(shared_costs.keys())
        for dim_value in all_dims:
            direct = direct_costs.get(dim_value, 0.0)
            shared = shared_costs.get(dim_value, 0.0)
            allocations[dim_value] = {
                "direct": round(direct, 2),
                "shared": round(shared, 2),
                "total": round(direct + shared, 2),
            }

        total_cost = sum(a["total"] for a in allocations.values())

        return json.dumps({
            "success": True,
            "billing_cycle": billing_cycle,
            "dimension": dimension,
            "auto_detect": auto_detect,
            "total_cost": round(total_cost, 2),
            "shared_items_count": len(shared_items),
            "shared_cost_total": round(sum(i["cost"] for i in shared_items), 2),
            "allocations": allocations,
            "note": "共享资源按各维度直接成本比例分摊",
        }, ensure_ascii=False, indent=2)

    except Exception as e:
        return json.dumps({
            "success": False, "error": str(e),
        }, ensure_ascii=False)

# -*- coding: utf-8 -*-
"""云资源成本优化通用框架 - 通用检测规则。

内置 3 条通用检测规则：
1. IdleResourceRule: 闲置资源检测
2. LowUtilizationRule: 低利用率检测
3. PostPaidLongTermRule: 按量付费长期持有检测

每个产品按需选择性启用，并组成各自的责任链。
"""

from __future__ import annotations

import asyncio
import json
import logging
from abc import ABC, abstractmethod
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from alibabacloud_tea_openapi.models import Config
from alibabacloud_cms20190101.client import Client as CmsClient
from alibabacloud_cms20190101 import models as cms_models

from .base import (
    OptimizeStrategy,
    OptimizeResult,
    ResourceInstance,
    ProductConfig,
    MetricConfig,
    IdleCheckMethod,
    ChargeType,
)

logger = logging.getLogger(__name__)


def _safe_float(value) -> float:
    """安全转换为 float。"""
    try:
        return float(value) if value is not None else 0.0
    except (ValueError, TypeError):
        return 0.0


class CmsService:
    """云监控服务封装。"""
    
    def __init__(self, access_key_id: str, access_key_secret: str, region_id: str):
        config = Config(
            access_key_id=access_key_id,
            access_key_secret=access_key_secret,
            endpoint=f"metrics.{region_id}.aliyuncs.com",
            region_id=region_id,
        )
        self._client = CmsClient(config)
    
    async def get_metric_max(
        self,
        namespace: str,
        metric_name: str,
        instance_id: str,
        days: int = 14,
        period: int = 60,
    ) -> float:
        """查询指标近 N 天的全局最大值。
        
        用于闲置检测：取分钟级数据的 Maximum，再取所有数据点的最大值。
        
        Returns:
            最大值，数据为空返回 -1
        """
        now = datetime.now(timezone.utc)
        start_ts = int((now - timedelta(days=days)).timestamp() * 1000)
        end_ts = int(now.timestamp() * 1000)
        
        try:
            req = cms_models.DescribeMetricListRequest(
                namespace=namespace,
                metric_name=metric_name,
                dimensions=json.dumps([{"instanceId": instance_id}]),
                period=str(period),
                start_time=str(start_ts),
                end_time=str(end_ts),
                length="1440",
            )
            resp = await asyncio.to_thread(self._client.describe_metric_list, req)
            body = resp.body
            
            if body.datapoints:
                points = json.loads(body.datapoints)
                max_values = [
                    _safe_float(p.get("Maximum", p.get("maximum", 0)))
                    for p in points
                ]
                return max(max_values) if max_values else -1.0
        except Exception as e:
            logger.warning("CMS max query %s/%s failed: %s", namespace, metric_name, e)
        
        return -1.0
    
    async def get_metric_percentile(
        self,
        namespace: str,
        metric_name: str,
        instance_id: str,
        days: int = 7,
        percentile: float = 0.95,
    ) -> float:
        """查询指标近 N 天的指定百分位数。
        
        用于低利用率检测：计算 P95 利用率。
        
        Returns:
            百分位值，数据为空返回 -1
        """
        now = datetime.now(timezone.utc)
        start_ts = int((now - timedelta(days=days)).timestamp() * 1000)
        end_ts = int(now.timestamp() * 1000)
        
        try:
            req = cms_models.DescribeMetricListRequest(
                namespace=namespace,
                metric_name=metric_name,
                dimensions=json.dumps([{"instanceId": instance_id}]),
                period="86400",  # 日粒度
                start_time=str(start_ts),
                end_time=str(end_ts),
            )
            resp = await asyncio.to_thread(self._client.describe_metric_list, req)
            body = resp.body
            
            if body.datapoints:
                points = json.loads(body.datapoints)
                values = sorted(
                    _safe_float(p.get("Average", p.get("average", 0)))
                    for p in points
                )
                if values:
                    idx = min(int(len(values) * percentile), len(values) - 1)
                    return values[idx]
        except Exception as e:
            logger.warning("CMS percentile query %s/%s failed: %s", namespace, metric_name, e)
        
        return -1.0


class BaseRule(ABC):
    """规则基类。
    
    所有检测规则继承此类，实现 check 方法。
    """
    
    rule_id: str = ""
    strategy: OptimizeStrategy = OptimizeStrategy.RELEASE
    
    @abstractmethod
    async def check(
        self,
        instance: ResourceInstance,
        config: ProductConfig,
        cms: Optional[CmsService] = None,
        **kwargs,
    ) -> Optional[OptimizeResult]:
        """执行规则检测。
        
        Args:
            instance: 资源实例
            config: 产品配置
            cms: 云监控服务（可选）
            **kwargs: 额外参数
        
        Returns:
            命中时返回 OptimizeResult，未命中返回 None
        """
        pass


class IdleResourceRule(BaseRule):
    """闲置资源检测规则。
    
    规则标识：IdleResourceCheck
    优化策略：Release（释放）
    
    判定方式 A（基于监控指标）：
    - 任一监控指标的 Maximum 低于阈值 → 闲置
    - 例如：CPU 或内存任一项最大值 < 1% 即判定为闲置
    
    判定方式 B（基于状态）：
    - 过去 N 天内始终处于未绑定/未挂载状态 → 闲置
    """
    
    rule_id = "IdleResourceCheck"
    strategy = OptimizeStrategy.RELEASE
    
    async def check(
        self,
        instance: ResourceInstance,
        config: ProductConfig,
        cms: Optional[CmsService] = None,
        **kwargs,
    ) -> Optional[OptimizeResult]:
        """检测资源是否闲置。"""
        
        if config.idle_check_method == IdleCheckMethod.METRIC:
            # 方式 A：基于监控指标
            # 判定逻辑：任一指标的 Maximum < 阈值 即判定为闲置
            if not cms or not config.idle_metrics:
                return None
            
            metric_results = {}
            any_idle = False  # 任一项低于阈值即为闲置
            idle_metric = None  # 记录触发闲置判定的指标
            
            for metric in config.idle_metrics:
                max_val = await cms.get_metric_max(
                    namespace=metric.namespace,
                    metric_name=metric.metric_name,
                    instance_id=instance.resource_id,
                    days=metric.days,
                )
                metric_results[metric.metric_name] = max_val
                
                # -1 表示数据获取失败，跳过该指标
                if max_val < 0:
                    continue
                
                # 任一项低于阈值即判定为闲置
                if max_val < metric.threshold:
                    any_idle = True
                    idle_metric = metric.metric_name
            
            if not any_idle:
                return None
            
            # 命中闲置规则
            return OptimizeResult(
                product=config.product_code,
                resource_id=instance.resource_id,
                resource_name=instance.resource_name,
                region_id=instance.region_id,
                zone_id=instance.zone_id,
                instance_type=instance.instance_type,
                charge_type=instance.charge_type.value if isinstance(instance.charge_type, ChargeType) else str(instance.charge_type),
                strategy=self.strategy,
                check_id=self.rule_id,
                optimized_config="",  # Release 不需要目标规格
                extend_result={
                    "metrics": metric_results,
                    "idle_days": config.idle_days,
                },
            )
        
        elif config.idle_check_method == IdleCheckMethod.STATUS:
            # 方式 B：基于状态
            if not config.idle_status_field:
                return None
            
            # 从原始数据获取状态字段
            status_value = instance.raw.get(config.idle_status_field)
            
            # 判断是否为闲置状态
            if status_value == config.idle_status_value:
                return OptimizeResult(
                    product=config.product_code,
                    resource_id=instance.resource_id,
                    resource_name=instance.resource_name,
                    region_id=instance.region_id,
                    zone_id=instance.zone_id,
                    instance_type=instance.instance_type,
                    charge_type=instance.charge_type.value if isinstance(instance.charge_type, ChargeType) else str(instance.charge_type),
                    strategy=self.strategy,
                    check_id=self.rule_id,
                    optimized_config="",
                    extend_result={
                        "status_field": config.idle_status_field,
                        "status_value": str(status_value),
                        "idle_days": config.idle_days,
                    },
                )
        
        return None


class LowUtilizationRule(BaseRule):
    """低利用率检测规则。
    
    规则标识：LowUtilizationCheck
    优化策略：DownScaling（降配）
    
    支持两种检测模式：
    1. 预取模式（ECS）：通过 kwargs['downscaling_instances'] 传入预取的可降配实例列表
    2. 云监控模式（RDS等）：通过云监控 P95 百分位检测
    """
    
    rule_id = "LowUtilizationCheck"
    strategy = OptimizeStrategy.DOWN_SCALING
    
    def __init__(
        self,
        low_util_threshold: float = 20.0,
        lower_threshold: float = 0.0,
        percentile: float = 0.95,
        days: int = 7,
        use_prefetch: bool = False,
    ):
        """初始化低利用率检测规则。
        
        Args:
            low_util_threshold: 低利用率上限阈值（%）
            lower_threshold: 低利用率下限阈值（%），与闲置检测互斥
            percentile: 百分位数（默认 P95）
            days: 回溯天数
            use_prefetch: 是否使用预取模式（适用于 ECS）
        """
        self.low_util_threshold = low_util_threshold
        self.lower_threshold = lower_threshold
        self.percentile = percentile
        self.days = days
        self.use_prefetch = use_prefetch
    
    async def check(
        self,
        instance: ResourceInstance,
        config: ProductConfig,
        cms: Optional[CmsService] = None,
        **kwargs,
    ) -> Optional[OptimizeResult]:
        """检测资源是否低利用率。
        
        支持两种检测模式：
        1. 预取模式：通过 kwargs['downscaling_instances'] 传入预取的可降配实例列表
        2. 云监控模式：通过云监控 P95 百分位检测
        """
        # 模式 1：预取模式（ECS 使用 DescribeResourceStatusDiagnosis API）
        downscaling_instances = kwargs.get("downscaling_instances", {})
        if downscaling_instances:
            diag_info = downscaling_instances.get(instance.resource_id)
            if not diag_info:
                return None  # 不在可降配列表中
            
            # 从诊断信息中提取 CPU/内存利用率
            cpu_percent = float(diag_info.get("cpu_percent", "0") or "0")
            memory_percent = float(diag_info.get("memory_percent", "0") or "0")
            advice_reason = diag_info.get("advice_reason", "")
            
            # 获取推荐规格
            target_spec = ""
            if config.get_recommend_spec_fn:
                try:
                    target_spec = await config.get_recommend_spec_fn(
                        instance.resource_id,
                        instance.instance_type,
                        instance.region_id,
                        raw=instance.raw,
                        zone_id=instance.zone_id,
                        **kwargs,
                    )
                except Exception as e:
                    logger.warning("获取推荐规格失败: %s", e)
            
            return OptimizeResult(
                product=config.product_code,
                resource_id=instance.resource_id,
                resource_name=instance.resource_name,
                region_id=instance.region_id,
                zone_id=instance.zone_id,
                instance_type=instance.instance_type,
                charge_type=instance.charge_type.value if isinstance(instance.charge_type, ChargeType) else str(instance.charge_type),
                strategy=self.strategy,
                check_id=self.rule_id,
                optimized_config=target_spec,
                extend_result={
                    "cpu_percent": cpu_percent,
                    "memory_percent": memory_percent,
                    "advice_reason": advice_reason,
                    "detection_mode": "prefetch",
                },
            )
        
        # 模式 2：云监控 P95 模式（RDS 等产品）
        if not cms or not config.idle_metrics:
            return None
        
        metric_results = {}
        all_low = True
        
        for metric in config.idle_metrics:
            p95_val = await cms.get_metric_percentile(
                namespace=metric.namespace,
                metric_name=metric.metric_name,
                instance_id=instance.resource_id,
                days=self.days,
                percentile=self.percentile,
            )
            metric_results[f"p95_{metric.metric_name}"] = p95_val
            
            # -1 表示数据获取失败
            if p95_val < 0:
                all_low = False
                break
            
            # 超过上限则不命中
            if p95_val >= self.low_util_threshold:
                all_low = False
                break
            
            # 低于下限则不命中（应该被闲置检测捕获）
            if self.lower_threshold > 0 and p95_val <= self.lower_threshold:
                all_low = False
                break
        
        if not all_low:
            return None
        
        # 获取推荐规格（如果有推荐函数）
        target_spec = ""
        if config.get_recommend_spec_fn:
            try:
                # 传递实例的 raw 数据和 zone_id，用于 RDS 降配推荐
                target_spec = await config.get_recommend_spec_fn(
                    instance.resource_id,
                    instance.instance_type,
                    instance.region_id,
                    raw=instance.raw,
                    zone_id=instance.zone_id,
                    **kwargs,
                )
            except Exception as e:
                logger.warning("获取推荐规格失败: %s", e)
        
        return OptimizeResult(
            product=config.product_code,
            resource_id=instance.resource_id,
            resource_name=instance.resource_name,
            region_id=instance.region_id,
            zone_id=instance.zone_id,
            instance_type=instance.instance_type,
            charge_type=instance.charge_type.value if isinstance(instance.charge_type, ChargeType) else str(instance.charge_type),
            strategy=self.strategy,
            check_id=self.rule_id,
            optimized_config=target_spec,
            extend_result={
                "metrics": metric_results,
                "low_util_threshold": self.low_util_threshold,
                "lower_threshold": self.lower_threshold,
                "percentile": self.percentile,
                "detection_mode": "cms_p95",
            },
        )


class PostPaidLongTermRule(BaseRule):
    """按量付费长期持有检测规则。
    
    规则标识：PostPaidLongTermCheck
    优化策略：ConvertToPrePaid（转包年包月）
    
    判定逻辑：
    - 实例付费类型为 PostPaid
    - 持有天数超过阈值（默认 30 天）
    """
    
    rule_id = "PostPaidLongTermCheck"
    strategy = OptimizeStrategy.CONVERT_TO_PREPAID
    
    def __init__(self, hold_days_threshold: int = 30):
        """初始化按量长期持有检测规则。
        
        Args:
            hold_days_threshold: 持有天数阈值
        """
        self.hold_days_threshold = hold_days_threshold
    
    async def check(
        self,
        instance: ResourceInstance,
        config: ProductConfig,
        cms: Optional[CmsService] = None,
        **kwargs,
    ) -> Optional[OptimizeResult]:
        """检测是否按量付费长期持有。"""
        
        # 只检测按量付费实例
        charge_type = instance.charge_type
        if isinstance(charge_type, ChargeType):
            if charge_type != ChargeType.POST_PAID:
                return None
        else:
            charge_str = str(charge_type).lower()
            if charge_str not in ("postpaid", "afterpay", "payasyougo"):
                return None
        
        # 计算持有天数
        creation_time = instance.creation_time
        if not creation_time:
            return None
        
        try:
            if "T" in creation_time:
                create_dt = datetime.fromisoformat(creation_time.replace("Z", "+00:00"))
            else:
                create_dt = datetime.strptime(creation_time[:19], "%Y-%m-%d %H:%M:%S")
                create_dt = create_dt.replace(tzinfo=timezone.utc)
            
            now = datetime.now(timezone.utc)
            hold_days = (now - create_dt).days
            
            if hold_days <= self.hold_days_threshold:
                return None
            
            return OptimizeResult(
                product=config.product_code,
                resource_id=instance.resource_id,
                resource_name=instance.resource_name,
                region_id=instance.region_id,
                zone_id=instance.zone_id,
                instance_type=instance.instance_type,
                charge_type=instance.charge_type.value if isinstance(instance.charge_type, ChargeType) else str(instance.charge_type),
                strategy=self.strategy,
                check_id=self.rule_id,
                optimized_config=instance.instance_type,  # 转包月保持当前规格
                extend_result={
                    "hold_days": hold_days,
                    "threshold": self.hold_days_threshold,
                    "creation_time": creation_time,
                },
            )
        
        except Exception as e:
            logger.warning("解析创建时间失败: %s", e)
            return None


class RuleChain:
    """规则链。
    
    责任链模式：依次执行规则，命中即返回，不再继续后续规则。
    """
    
    def __init__(self, rules: list[BaseRule]):
        """初始化规则链。
        
        Args:
            rules: 规则列表，按优先级从高到低排列
        """
        self.rules = rules
    
    async def execute(
        self,
        instance: ResourceInstance,
        config: ProductConfig,
        cms: Optional[CmsService] = None,
        **kwargs,
    ) -> Optional[OptimizeResult]:
        """执行规则链。
        
        Args:
            instance: 资源实例
            config: 产品配置
            cms: 云监控服务
            **kwargs: 额外参数
        
        Returns:
            第一个命中的规则结果，全部未命中返回 None
        """
        for rule in self.rules:
            result = await rule.check(instance, config, cms, **kwargs)
            if result is not None:
                return result
        return None


def build_rule_chain(
    config: ProductConfig,
    low_util_threshold: float = 20.0,
    hold_days_threshold: int = 30,
) -> RuleChain:
    """根据产品配置构建规则链。
    
    Args:
        config: 产品配置
        low_util_threshold: 低利用率阈值（默认上限）
        hold_days_threshold: 按量持有天数阈值
    
    Returns:
        规则链
    """
    rules: list[BaseRule] = []
    
    for rule_config in config.rule_chain:
        if not rule_config.enabled:
            continue
        
        if rule_config.rule_id == "IdleResourceCheck":
            rules.append(IdleResourceRule())
        elif rule_config.rule_id == "LowUtilizationCheck":
            # 支持上限和下限阈值
            threshold = rule_config.params.get("threshold", low_util_threshold)
            lower = rule_config.params.get("lower_threshold", 0.0)
            rules.append(LowUtilizationRule(
                low_util_threshold=threshold,
                lower_threshold=lower,
            ))
        elif rule_config.rule_id == "PostPaidLongTermCheck":
            days = rule_config.params.get("hold_days", hold_days_threshold)
            rules.append(PostPaidLongTermRule(hold_days_threshold=days))
    
    return RuleChain(rules)

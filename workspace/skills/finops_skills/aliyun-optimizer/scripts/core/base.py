# -*- coding: utf-8 -*-
"""云资源成本优化通用框架 - 基础定义。

包含枚举、数据结构、通用常量等。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Coroutine, Optional


class OptimizeStrategy(str, Enum):
    """优化策略枚举。
    
    按优先级从高到低排列：
    - Release: 释放资源（最高优先级）
    - DownScaling: 降配
    - ConvertToPrePaid: 转包年包月（最低优先级）
    """
    RELEASE = "Release"
    DOWN_SCALING = "DownScaling"
    CONVERT_TO_PREPAID = "ConvertToPrePaid"


# 策略优先级映射（数值越小优先级越高）
STRATEGY_PRIORITY: dict[OptimizeStrategy, int] = {
    OptimizeStrategy.RELEASE: 1,
    OptimizeStrategy.DOWN_SCALING: 2,
    OptimizeStrategy.CONVERT_TO_PREPAID: 3,
}

# 策略中文名映射
STRATEGY_CN: dict[OptimizeStrategy, str] = {
    OptimizeStrategy.RELEASE: "释放资源",
    OptimizeStrategy.DOWN_SCALING: "降配",
    OptimizeStrategy.CONVERT_TO_PREPAID: "转包年包月",
}


class IdleCheckMethod(str, Enum):
    """闲置判定方式。
    
    - METRIC: 基于监控指标判定（适用于计算型产品 ECS/RDS）
    - STATUS: 基于状态判定（适用于存储型/网络型产品 EBS/EIP/SLB）
    """
    METRIC = "metric"
    STATUS = "status"


class ChargeType(str, Enum):
    """付费类型。"""
    POST_PAID = "PostPaid"  # 按量付费
    PRE_PAID = "PrePaid"    # 包年包月
    
    @classmethod
    def from_str(cls, value: str) -> "ChargeType":
        """从字符串解析付费类型，兼容多种格式。"""
        value_lower = value.lower()
        if value_lower in ("postpaid", "afterpay", "payasyougo"):
            return cls.POST_PAID
        elif value_lower in ("prepaid", "subscription"):
            return cls.PRE_PAID
        return cls.POST_PAID


@dataclass
class MetricConfig:
    """监控指标配置。
    
    Attributes:
        metric_name: 指标名称（如 CPUUtilization）
        namespace: 命名空间（如 acs_ecs_dashboard）
        days: 回溯天数
        threshold: 阈值（百分比）
    """
    metric_name: str
    namespace: str
    days: int = 14
    threshold: float = 1.0


@dataclass
class RuleConfig:
    """单条规则配置。
    
    Attributes:
        rule_id: 规则标识
        enabled: 是否启用
        strategy: 对应的优化策略
        params: 规则参数
    """
    rule_id: str
    enabled: bool = True
    strategy: OptimizeStrategy = OptimizeStrategy.RELEASE
    params: dict[str, Any] = field(default_factory=dict)


@dataclass
class ProductConfig:
    """产品配置。
    
    定义某个云产品接入成本优化框架所需的全部配置。
    
    Attributes:
        product_code: 产品代码（如 ecs, rds, disk）
        product_name: 产品名称
        rule_chain: 规则链配置（按顺序执行）
        idle_check_method: 闲置判定方式
        idle_metrics: 闲置监控指标列表（方式 A）
        idle_status_field: 闲置状态字段（方式 B）
        pricing_module_code: 询价 ModuleCode
        pricing_config_template: 询价 Config 模板
        list_instances_fn: 列举实例函数
        get_recommend_spec_fn: 获取推荐规格函数（可选）
    """
    product_code: str
    product_name: str
    rule_chain: list[RuleConfig]
    idle_check_method: IdleCheckMethod
    idle_metrics: list[MetricConfig] = field(default_factory=list)
    idle_status_field: str = ""
    idle_status_value: Any = None
    idle_days: int = 14
    pricing_module_code: str = ""
    pricing_config_template: str = ""
    # 函数钩子（运行时注入）
    list_instances_fn: Optional[Callable[..., Coroutine[Any, Any, list[dict]]]] = None
    get_recommend_spec_fn: Optional[Callable[..., Coroutine[Any, Any, str]]] = None


@dataclass
class ResourceInstance:
    """资源实例标准化结构。
    
    Attributes:
        resource_id: 资源 ID
        resource_name: 资源名称
        region_id: 地域
        zone_id: 可用区
        instance_type: 当前规格
        charge_type: 付费类型
        creation_time: 创建时间
        status: 状态
        raw: 原始数据
    """
    resource_id: str
    resource_name: str
    region_id: str
    zone_id: str = ""
    instance_type: str = ""
    charge_type: ChargeType = ChargeType.POST_PAID
    creation_time: str = ""
    status: str = ""
    raw: dict = field(default_factory=dict)


@dataclass
class OptimizeResult:
    """优化结果。
    
    单条优化建议的完整数据结构。
    """
    # 基础信息
    product: str
    resource_id: str
    resource_name: str
    region_id: str
    zone_id: str = ""
    instance_type: str = ""
    charge_type: str = ""
    
    # 优化策略
    strategy: OptimizeStrategy = OptimizeStrategy.RELEASE
    check_id: str = ""  # 命中的规则标识
    optimized_config: str = ""  # 推荐的目标规格
    
    # 费用
    cost_before: float = 0.0
    cost_after: float = 0.0
    cost_savings: float = 0.0
    savings_pct: float = 0.0  # 节省百分比
    
    # 扩展信息
    extend_result: dict = field(default_factory=dict)
    
    @property
    def priority(self) -> int:
        """获取策略优先级。"""
        return STRATEGY_PRIORITY.get(self.strategy, 99)
    
    @property
    def strategy_cn(self) -> str:
        """获取策略中文名。"""
        return STRATEGY_CN.get(self.strategy, "未知")
    
    def is_valid(self) -> bool:
        """检查结果是否有效（通过剔除规则）。
        
        剔除条件：
        1. 策略为 DownScaling 且推荐规格为空
        2. costAfter 等于 -1（询价失败）
        3. costAfter > costBefore（优化后更贵）
        4. costBefore 等于 0（账单缺失）
        """
        if self.strategy == OptimizeStrategy.DOWN_SCALING and not self.optimized_config:
            return False
        if self.cost_after == -1:
            return False
        if self.cost_after > self.cost_before:
            return False
        if self.cost_before == 0:
            return False
        return True
    
    def to_dict(self) -> dict:
        """转换为字典。"""
        return {
            "product": self.product,
            "resourceId": self.resource_id,
            "resourceName": self.resource_name,
            "regionId": self.region_id,
            "zoneId": self.zone_id,
            "instanceType": self.instance_type,
            "instanceChargeType": self.charge_type,
            "optimizeStrategy": self.strategy.value,
            "checkId": self.check_id,
            "optimizedConfig": self.optimized_config,
            "costBefore": round(self.cost_before, 2),
            "costAfter": round(self.cost_after, 2),
            "costSavings": round(self.cost_savings, 2),
            "savingsPct": round(self.savings_pct, 1),
            "severity": "WARNING",
            "extendResult": self.extend_result,
        }

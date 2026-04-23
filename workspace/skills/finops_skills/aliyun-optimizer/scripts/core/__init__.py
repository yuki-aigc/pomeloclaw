# -*- coding: utf-8 -*-
"""云资源成本优化通用框架 - 核心模块。"""

from .base import (
    OptimizeStrategy,
    IdleCheckMethod,
    RuleConfig,
    ProductConfig,
    OptimizeResult,
    STRATEGY_PRIORITY,
)
from .rules import (
    IdleResourceRule,
    LowUtilizationRule,
    PostPaidLongTermRule,
    RuleChain,
)
from .pipeline import PostProcessor
from .bss import BssService
from .report import (
    generate_cost_report,
    generate_single_product_report,
    generate_report_from_dict,
    CostReportGenerator,
)

__all__ = [
    # 基础定义
    "OptimizeStrategy",
    "IdleCheckMethod",
    "RuleConfig",
    "ProductConfig",
    "OptimizeResult",
    "STRATEGY_PRIORITY",
    # 规则
    "IdleResourceRule",
    "LowUtilizationRule",
    "PostPaidLongTermRule",
    "RuleChain",
    # 流水线
    "PostProcessor",
    # BSS 服务
    "BssService",
    # 报告生成
    "generate_cost_report",
    "generate_single_product_report",
    "generate_report_from_dict",
    "CostReportGenerator",
]

# -*- coding: utf-8 -*-
"""云资源成本优化通用框架 - 后处理流水线。

4 步通用后处理：
1. 推荐优化规格
2. 优化后询价
3. 查账单与计算节省金额
4. 无效数据剔除
"""

from __future__ import annotations

import logging
from typing import Optional

from .base import (
    OptimizeStrategy,
    OptimizeResult,
    ProductConfig,
    ChargeType,
    STRATEGY_CN,
    STRATEGY_PRIORITY,
)
from .bss import BssService

logger = logging.getLogger(__name__)


class PostProcessor:
    """后处理流水线。
    
    对每条优化建议执行 4 步后处理：
    1. 推荐优化规格（部分策略已在规则阶段完成）
    2. 优化后询价（costAfter）
    3. 查账单获取当前费用（costBefore）
    4. 无效数据剔除
    
    Usage:
        processor = PostProcessor(bss_service, product_config)
        
        # 处理单条结果
        result = await processor.process(result)
        if result and result.is_valid():
            valid_results.append(result)
        
        # 批量处理并合并
        results = await processor.process_batch(results)
    """
    
    def __init__(
        self,
        bss: Optional[BssService],
        config: ProductConfig,
        use_bss_pricing: bool = True,
    ):
        """初始化后处理器。
        
        Args:
            bss: BSS 服务实例
            config: 产品配置
            use_bss_pricing: 是否使用 BSS API 精确询价
        """
        self.bss = bss
        self.config = config
        self.use_bss_pricing = use_bss_pricing
    
    async def process(self, result: OptimizeResult) -> OptimizeResult:
        """处理单条优化结果。
        
        执行询价和账单查询，填充费用字段。
        
        Args:
            result: 待处理的优化结果
        
        Returns:
            处理后的结果（已填充费用）
        """
        # 步骤 1：推荐规格（已在规则阶段完成）
        # Release 策略不需要目标规格
        # DownScaling 策略需要推荐规格（在规则阶段获取）
        # ConvertToPrePaid 策略使用当前规格
        
        # 步骤 2 & 3：询价和账单查询
        if self.bss and self.use_bss_pricing:
            await self._query_pricing(result)
        else:
            # 无 BSS 服务时使用估算价格
            self._estimate_pricing(result)
        
        # 计算节省金额和百分比
        if result.cost_before > 0 and result.cost_after >= 0:
            result.cost_savings = max(0, result.cost_before - result.cost_after)
            result.savings_pct = (result.cost_savings / result.cost_before * 100) if result.cost_before > 0 else 0.0
        
        return result
    
    async def _query_pricing(self, result: OptimizeResult) -> None:
        """严格四级价格查询：账单 -> BSS询价 -> OpenAPI询价 -> 估算价格。
        
        价格来源优先级（严格遵守，不到万不得已不估算）：
        1. 账单（bill）- 真实费用，最准确
        2. BSS询价（bss）- 官方询价API
        3. OpenAPI询价（openapi）- 产品级询价API
        4. 估算（estimate）- 最后手段，标记警告
        """
        if not self.bss:
            self._estimate_pricing(result)
            result.extend_result["price_source"] = "estimate"
            result.extend_result["price_warning"] = "无法连接BSS服务，价格为估算值"
            return
        
        cost_before_source = "unknown"
        cost_after_source = "unknown"
        
        # ========== 第一步：查询账单获取 costBefore ==========
        result.cost_before = await self.bss.query_instance_bill(
            result.resource_id,
            self.config.product_code,
        )
        if result.cost_before > 0:
            cost_before_source = "bill"  # 真实账单数据
            print(f"[价格查询] {result.resource_id} ({result.instance_type}) costBefore: {result.cost_before:.2f} 元/月 <- 账单(bill)")
        
        # 根据策略确定询价方式
        if result.strategy == OptimizeStrategy.RELEASE:
            # 释放：costAfter = 0
            result.cost_after = 0.0
            cost_after_source = "N/A"  # 释放没有目标费用
            
            # 如果账单为 0，按优先级查询
            if result.cost_before <= 0:
                result.cost_before, cost_before_source = await self._query_price_strict(
                    result.region_id,
                    result.instance_type,
                    self.config.product_code,
                    "PostPaid",
                )
        
        elif result.strategy == OptimizeStrategy.DOWN_SCALING:
            target_spec = result.optimized_config or result.instance_type
            
            # 如果账单为 0，按优先级查询当前规格价格
            if result.cost_before <= 0:
                result.cost_before, cost_before_source = await self._query_price_strict(
                    result.region_id,
                    result.instance_type,
                    self.config.product_code,
                    "PostPaid",
                )
            
            # 查询目标规格价格（跳过账单查询，因为目标规格还没有实例）
            result.cost_after, cost_after_source = await self._query_price_strict(
                result.region_id,
                target_spec,
                self.config.product_code,
                "PostPaid",
                skip_bill=True,  # 关键：目标规格不查账单
            )
        
        elif result.strategy == OptimizeStrategy.CONVERT_TO_PREPAID:
            # 转包月
            if result.cost_before <= 0:
                result.cost_before, cost_before_source = await self._query_price_strict(
                    result.region_id,
                    result.instance_type,
                    self.config.product_code,
                    "PostPaid",
                )
            
            # 查询包月价格（也跳过账单，因为还没转换）
            result.cost_after, cost_after_source = await self._query_price_strict(
                result.region_id,
                result.instance_type,
                self.config.product_code,
                "PrePaid",
                skip_bill=True,  # 关键：包月价格不查账单
            )
        
        # 记录价格来源
        result.extend_result["price_source"] = cost_before_source
        result.extend_result["cost_before_source"] = cost_before_source
        result.extend_result["cost_after_source"] = cost_after_source
        
        # 如果使用了估算，添加警告
        if cost_before_source == "estimate" or cost_after_source == "estimate":
            result.extend_result["price_warning"] = "部分价格为估算值，仅供参考"
    
    async def _query_price_strict(
        self,
        region_id: str,
        spec: str,
        product_code: str,
        charge_type: str,
        skip_bill: bool = False,
    ) -> tuple[float, str]:
        """严格按优先级查询价格：BSS -> OpenAPI -> 估算。
        
        只有前一级查询失败才会尝试下一级。
        
        Args:
            skip_bill: 是否跳过账单查询（用于查询目标规格价格，因为目标规格还没有实例）
        """
        product_lower = product_code.lower()
        is_payg = charge_type in ("PostPaid", "Postpaid", "payasyougo")
        
        # 第一级：BSS 询价
        if is_payg:
            price = await self.bss.get_payg_price(region_id, spec, product_code)
        else:
            price = await self.bss.get_subscription_price(region_id, spec, product_code)
        
        if price > 0:
            print(f"  [BSS询价成功] {spec} -> {price:.2f} 元/月")
            return (price, "bss")
        else:
            print(f"  [BSS询价失败] {spec} 返回 {price}，尝试 OpenAPI")
        
        # 第二级：OpenAPI 询价（根据产品类型调用不同的询价方法）
        price = -1.0
        
        if product_lower == "ecs":
            price = await self.bss._openapi_ecs_price(
                region_id, spec, 
                "PostPaid" if is_payg else "PrePaid"
            )
        elif product_lower in ("rds", "rds_mysql"):
            price = await self.bss._openapi_rds_price(
                region_id, spec,
                "Postpaid" if is_payg else "Prepaid"
            )
        elif product_lower in ("disk", "ebs", "yundisk"):
            price = await self.bss._openapi_disk_price(
                region_id, spec,
                charge_type="PostPaid" if is_payg else "PrePaid"
            )
        elif product_lower in ("redis", "r-kvstore", "kvstore"):
            price = await self.bss._openapi_redis_price(
                region_id, spec,
                charge_type="PostPaid" if is_payg else "PrePaid"
            )
        elif product_lower == "slb":
            price = await self.bss._openapi_slb_price(
                region_id, spec,
                charge_type="PostPaid" if is_payg else "PrePaid"
            )
        elif product_lower in ("nat", "natgateway", "nat_gateway"):
            price = await self.bss._openapi_nat_price(
                region_id, spec,
                charge_type="PostPaid" if is_payg else "PrePaid"
            )
        
        if price > 0:
            print(f"  [OpenAPI询价成功] {spec} -> {price:.2f} 元/月")
            return (price, "openapi")
        else:
            print(f"  [OpenAPI询价失败] {spec} 返回 {price}，使用估算")
        
        # 第三级：万不得已才估算
        price = self.bss._estimate_price(spec, product_lower)
        print(f"  [估算] {spec} -> {price:.2f} 元/月")
        return (price, "estimate")
    
    def _estimate_pricing(self, result: OptimizeResult) -> None:
        """估算价格（无 BSS 服务时的备选方案）。
        
        基于规格名称粗略估算费用。
        """
        # 简单估算：按量 200 元/核/月，包月 100 元/核/月
        base_price = self._estimate_base_price(result.instance_type)
        
        if result.strategy == OptimizeStrategy.RELEASE:
            result.cost_before = base_price
            result.cost_after = 0.0
        
        elif result.strategy == OptimizeStrategy.DOWN_SCALING:
            result.cost_before = base_price
            target_price = self._estimate_base_price(result.optimized_config or result.instance_type)
            result.cost_after = target_price
        
        elif result.strategy == OptimizeStrategy.CONVERT_TO_PREPAID:
            result.cost_before = base_price
            result.cost_after = base_price * 0.5  # 包月约 5 折
    
    def _estimate_base_price(self, spec: str) -> float:
        """根据规格名称估算月费。"""
        # 解析规格中的核数
        spec_lower = spec.lower()
        
        # 常见 size 后缀映射到核数
        size_map = {
            "small": 1,
            "medium": 2,
            "large": 2,
            "xlarge": 4,
            "2xlarge": 8,
            "4xlarge": 16,
            "8xlarge": 32,
            "16xlarge": 64,
        }
        
        cores = 2  # 默认
        for size, c in size_map.items():
            if size in spec_lower:
                cores = c
                break
        
        # 按量约 200 元/核/月
        return cores * 200.0
    
    async def process_batch(
        self,
        results: list[OptimizeResult],
    ) -> list[OptimizeResult]:
        """批量处理并合并优化结果。
        
        1. 对每条结果执行后处理
        2. 过滤无效结果
        3. 按资源 ID 合并，保留优先级最高的建议
        
        Args:
            results: 待处理的结果列表
        
        Returns:
            处理后的有效结果列表
        """
        # 步骤 1 & 2 & 3：处理每条结果
        processed = []
        for result in results:
            result = await self.process(result)
            processed.append(result)
        
        # 步骤 4：过滤无效结果
        valid = [r for r in processed if r.is_valid()]
        
        # 合并：同一资源保留优先级最高的
        merged: dict[str, OptimizeResult] = {}
        for r in valid:
            key = r.resource_id
            if key not in merged or r.priority < merged[key].priority:
                merged[key] = r
        
        return list(merged.values())


def generate_markdown_report(
    results: list[OptimizeResult],
    product_name: str,
    region_id: str,
    stats: dict,
    params: dict = None,
) -> str:
    """生成 Markdown 格式的优化报告。
    
    使用专业的报告模板生成丰富、美观的成本分析报告。
    
    Args:
        results: 优化结果列表
        product_name: 产品名称
        region_id: 地域
        stats: 统计信息
        params: 分析参数（可选）
    
    Returns:
        Markdown 格式报告
    """
    from .report import generate_single_product_report
    
    return generate_single_product_report(
        results=results,
        product_name=product_name,
        region_id=region_id,
        stats=stats,
        params=params,
    )

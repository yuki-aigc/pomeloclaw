# -*- coding: utf-8 -*-
"""云资源成本优化 - 专业报告生成模块。

提供丰富、专业的成本分析报告模板，支持：
- 执行摘要（Executive Summary）
- ROI 分析
- 风险等级评估
- 优化优先级矩阵
- 详细的分析数据
- 实施建议和时间线
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Optional

from .base import OptimizeResult, OptimizeStrategy, STRATEGY_CN, STRATEGY_PRIORITY


# =============================================================================
# 报告配置常量
# =============================================================================

# 风险等级配色 (用于 Markdown 展示提示)
RISK_LEVELS = {
    "high": {"emoji": "🔴", "label": "高风险", "color": "#FF4D4F"},
    "medium": {"emoji": "🟡", "label": "中风险", "color": "#FAAD14"},
    "low": {"emoji": "🟢", "label": "低风险", "color": "#52C41A"},
}

# 策略图标
STRATEGY_EMOJI = {
    OptimizeStrategy.RELEASE: "🗑️",
    OptimizeStrategy.DOWN_SCALING: "⬇️",
    OptimizeStrategy.CONVERT_TO_PREPAID: "🔄",
}

# 产品图标映射
PRODUCT_EMOJI = {
    "ecs": "🖥️",
    "rds": "🗄️",
    "disk": "💾",
    "eip": "🌐",
    "slb": "⚖️",
    "redis": "⚡",
    "clb": "🔀",
    "nat": "🚀",
    "oss": "📦",
    "cdn": "🌍",
}


@dataclass
class ReportSection:
    """报告章节数据。"""
    title: str
    content: list[str] = field(default_factory=list)
    subsections: list["ReportSection"] = field(default_factory=list)


@dataclass
class ReportData:
    """报告数据结构。"""
    title: str
    region_id: str
    products: list[str]
    results: list[OptimizeResult]
    stats: dict[str, int]
    params: dict[str, Any] = field(default_factory=dict)
    generated_at: datetime = field(default_factory=datetime.now)


# =============================================================================
# 核心报告生成器
# =============================================================================

class CostReportGenerator:
    """成本优化报告生成器。
    
    生成专业、丰富的 Markdown 格式报告。
    """
    
    def __init__(self, data: ReportData):
        self.data = data
        self._lines: list[str] = []
    
    def generate(self) -> str:
        """生成完整报告。"""
        self._lines = []
        
        self._add_header()
        self._add_executive_summary()
        self._add_key_metrics()
        self._add_cost_analysis_top10()  # 新增：成本分析 Top10
        self._add_savings_breakdown()
        self._add_optimization_details()
        self._add_risk_assessment()
        self._add_implementation_guide()
        self._add_policy_rules()  # 新增：策略规则说明
        self._add_analysis_params()
        self._add_footer()
        
        return "\n".join(self._lines)
    
    def _add(self, *lines: str) -> None:
        """添加行。"""
        self._lines.extend(lines)
    
    def _add_divider(self) -> None:
        """添加分隔线。"""
        self._add("")
        self._add("---")
        self._add("")
    
    # =========================================================================
    # 报告章节
    # =========================================================================
    
    def _add_header(self) -> None:
        """添加报告头部。"""
        self._add(f"# 📊 {self.data.title}")
        self._add("")
        
        # 元信息区
        product_list = ", ".join(self.data.products) if self.data.products else "-"
        self._add(f"> **生成时间**: {self.data.generated_at.strftime('%Y-%m-%d %H:%M:%S')}")
        self._add(f"> **分析区域**: {self.data.region_id}")
        self._add(f"> **产品范围**: {product_list}")
        self._add(f"> **分析模式**: 责任链智能检测")
        self._add("")
    
    def _add_executive_summary(self) -> None:
        """添加执行摘要。"""
        total_instances = self.data.stats.get("total", 0)
        total_savings = sum(r.cost_savings for r in self.data.results)
        optimization_count = len(self.data.results)
        optimization_rate = (optimization_count / total_instances * 100) if total_instances > 0 else 0
        
        # 计算年化节省
        annual_savings = total_savings * 12
        
        self._add("## 📋 执行摘要")
        self._add("")
        
        # 核心指标卡片
        self._add('<div align="center">')
        self._add("")
        self._add("| 💰 预估月节省 | 📈 年化节省 | 📦 资源总数 | ⚠️ 可优化资源 | 📊 优化率 |")
        self._add("|:-------------:|:-----------:|:-----------:|:-------------:|:---------:|")
        self._add(
            f"| **¥{total_savings:,.0f}** | **¥{annual_savings:,.0f}** | "
            f"{total_instances} 个 | {optimization_count} 个 | {optimization_rate:.1f}% |"
        )
        self._add("")
        self._add("</div>")
        self._add("")
        
        # 关键发现
        self._add("### 🔍 关键发现")
        self._add("")
        
        findings = self._generate_key_findings()
        for i, finding in enumerate(findings, 1):
            self._add(f"{i}. {finding}")
        self._add("")
    
    def _generate_key_findings(self) -> list[str]:
        """生成关键发现列表。"""
        findings = []
        stats = self.data.stats
        results = self.data.results
        
        # 闲置资源
        idle_count = stats.get("idle", 0)
        if idle_count > 0:
            idle_savings = sum(r.cost_savings for r in results if r.strategy == OptimizeStrategy.RELEASE)
            findings.append(f"发现 **{idle_count} 个闲置资源**，释放后可月省 ¥{idle_savings:,.0f}")
        
        # 低利用率资源
        low_util_count = stats.get("low_util", 0)
        if low_util_count > 0:
            downscale_savings = sum(r.cost_savings for r in results if r.strategy == OptimizeStrategy.DOWN_SCALING)
            findings.append(f"发现 **{low_util_count} 个低利用率资源**，降配后可月省 ¥{downscale_savings:,.0f}")
        
        # 按量长期持有
        postpaid_count = stats.get("postpaid_longterm", 0)
        if postpaid_count > 0:
            convert_savings = sum(r.cost_savings for r in results if r.strategy == OptimizeStrategy.CONVERT_TO_PREPAID)
            findings.append(f"发现 **{postpaid_count} 个按量长期持有资源**，转包月后可月省 ¥{convert_savings:,.0f}")
        
        # 健康资源
        normal_count = stats.get("normal", 0)
        total = stats.get("total", 0)
        if normal_count > 0 and total > 0:
            health_rate = normal_count / total * 100
            findings.append(f"**{normal_count} 个资源** ({health_rate:.0f}%) 处于健康状态，无需优化")
        
        if not findings:
            findings.append("所有资源运行正常，无优化建议")
        
        return findings
    
    def _add_key_metrics(self) -> None:
        """添加关键指标。"""
        self._add("## 📊 资源状态总览")
        self._add("")
        
        stats = self.data.stats
        total = stats.get("total", 0)
        idle = stats.get("idle", 0)
        low_util = stats.get("low_util", 0)
        postpaid = stats.get("postpaid_longterm", 0)
        normal = stats.get("normal", 0)
        
        # 状态分布表
        self._add("| 状态 | 数量 | 占比 | 说明 |")
        self._add("|:-----|-----:|-----:|:-----|")
        
        if total > 0:
            self._add(f"| 🔴 闲置资源 | {idle} 个 | {idle/total*100:.1f}% | 资源完全闲置，建议释放 |")
            self._add(f"| 🟡 低利用率 | {low_util} 个 | {low_util/total*100:.1f}% | 资源利用率偏低，建议降配 |")
            self._add(f"| 🔵 按量长期持有 | {postpaid} 个 | {postpaid/total*100:.1f}% | 按量付费超阈值，建议转包月 |")
            self._add(f"| 🟢 正常运行 | {normal} 个 | {normal/total*100:.1f}% | 资源状态健康 |")
        else:
            self._add("| - | 0 个 | - | 未检测到资源 |")
        
        self._add(f"| **合计** | **{total} 个** | **100%** | - |")
        self._add("")
        
        # 可视化进度条（文字版）
        if total > 0:
            self._add("### 状态分布可视化")
            self._add("")
            self._add("```")
            bar_width = 50
            idle_bar = int(idle / total * bar_width) if total > 0 else 0
            low_bar = int(low_util / total * bar_width) if total > 0 else 0
            postpaid_bar = int(postpaid / total * bar_width) if total > 0 else 0
            normal_bar = bar_width - idle_bar - low_bar - postpaid_bar
            
            bar = "█" * idle_bar + "▓" * low_bar + "▒" * postpaid_bar + "░" * normal_bar
            self._add(f"[{bar}]")
            self._add(f" █ 闲置 ({idle})  ▓ 低利用率 ({low_util})  ▒ 按量长期 ({postpaid})  ░ 正常 ({normal})")
            self._add("```")
            self._add("")
    
    def _add_cost_analysis_top10(self) -> None:
        """添加成本分析 Top10 章节。"""
        if not self.data.results:
            return
        
        # ========== 按产品维度汇总 ==========
        self._add("## 💰 成本分析")
        self._add("")
        self._add("### 按产品维度汇总")
        self._add("")
        
        # 按产品分组统计
        by_product: dict[str, list[OptimizeResult]] = {}
        for r in self.data.results:
            by_product.setdefault(r.product.upper(), []).append(r)
        
        self._add("| 产品 | 可优化资源数 | 当前月费 | 优化后月费 | 预计节省 | 节省比例 | 价格来源 |")
        self._add("|:-----|------------:|---------:|-----------:|---------:|--------:|:-------|")
        
        total_before = 0.0
        total_after = 0.0
        total_savings = 0.0
        
        for product in sorted(by_product.keys()):
            results = by_product[product]
            emoji = PRODUCT_EMOJI.get(product.lower(), "📦")
            
            cost_before = sum(r.cost_before for r in results)
            cost_after = sum(r.cost_after for r in results)
            savings = sum(r.cost_savings for r in results)
            savings_pct = (savings / cost_before * 100) if cost_before > 0 else 0
            
            # 统计价格来源
            sources = set()
            for r in results:
                src = r.extend_result.get("cost_before_source", "")
                if src:
                    sources.add(src)
            source_str = "/".join(sorted(sources)) if sources else "-"
            
            total_before += cost_before
            total_after += cost_after
            total_savings += savings
            
            self._add(
                f"| {emoji} {product} | {len(results)} 个 | ¥{cost_before:,.0f} | "
                f"¥{cost_after:,.0f} | **¥{savings:,.0f}** | {savings_pct:.1f}% | {source_str} |"
            )
        
        # 合计行
        total_pct = (total_savings / total_before * 100) if total_before > 0 else 0
        self._add(
            f"| **合计** | **{len(self.data.results)} 个** | **¥{total_before:,.0f}** | "
            f"**¥{total_after:,.0f}** | **¥{total_savings:,.0f}** | **{total_pct:.1f}%** | - |"
        )
        self._add("")
        
        # 价格来源说明
        self._add("> 📌 **价格来源说明**: ")
        self._add("> - `bill` = 真实账单数据（最准确）")
        self._add("> - `bss` = BSS 官方询价 API")
        self._add("> - `openapi` = 产品 OpenAPI 询价")
        self._add("> - `estimate` = 估算值（仅供参考）")
        self._add("")
        
        # ========== Top10 明细 ==========
        self._add("### 月度费用 Top 10")
        self._add("")
        
        # 按当前月费排序，取 Top10
        sorted_results = sorted(self.data.results, key=lambda x: -x.cost_before)
        top10 = sorted_results[:10]
        
        self._add("| 排名 | 产品 | 实例 ID | 实例名称 | 当前规格 | 当前月费 | 优化策略 | 目标月费 | 预计节省 | 节省% | 来源 |")
        self._add("|-----:|:----:|:---------|:---------|:---------|----------:|:---------|----------:|---------:|------:|:-----|")
        
        for i, r in enumerate(top10, 1):
            emoji = PRODUCT_EMOJI.get(r.product.lower(), "📦")
            strategy_emoji = STRATEGY_EMOJI.get(r.strategy, "")
            strategy_cn = STRATEGY_CN.get(r.strategy, "未知")
            
            name = r.resource_name or "-"
            if len(name) > 15:
                name = name[:12] + "..."
            
            # 目标规格
            target = r.optimized_config or "-"
            if r.strategy == OptimizeStrategy.RELEASE:
                target = "🗑️ 释放"
            elif r.strategy == OptimizeStrategy.CONVERT_TO_PREPAID:
                target = f"🔄 包月"
            elif r.strategy == OptimizeStrategy.DOWN_SCALING and r.optimized_config:
                target = f"⬇️ {r.optimized_config}"
            
            # 价格来源
            source = r.extend_result.get("cost_before_source", "-")
            
            self._add(
                f"| {i} | {emoji} {r.product.upper()} | `{r.resource_id}` | {name} | "
                f"{r.instance_type} | ¥{r.cost_before:,.0f} | {strategy_emoji} {strategy_cn} | "
                f"¥{r.cost_after:,.0f} | **¥{r.cost_savings:,.0f}** | {r.savings_pct:.1f}% | {source} |"
            )
        
        self._add("")
    
    def _add_savings_breakdown(self) -> None:
        """添加节省金额分解。"""
        if not self.data.results:
            return
        
        self._add("## 💰 节省金额分解")
        self._add("")
        
        # 按策略分组统计
        by_strategy: dict[OptimizeStrategy, list[OptimizeResult]] = {}
        for r in self.data.results:
            by_strategy.setdefault(r.strategy, []).append(r)
        
        total_savings = sum(r.cost_savings for r in self.data.results)
        
        self._add("| 优化策略 | 资源数 | 月节省金额 | 占比 | 平均单资源节省 |")
        self._add("|:---------|-------:|-----------:|-----:|---------------:|")
        
        for strategy in sorted(by_strategy.keys(), key=lambda s: STRATEGY_PRIORITY.get(s, 99)):
            results = by_strategy[strategy]
            count = len(results)
            savings = sum(r.cost_savings for r in results)
            pct = (savings / total_savings * 100) if total_savings > 0 else 0
            avg_savings = savings / count if count > 0 else 0
            emoji = STRATEGY_EMOJI.get(strategy, "")
            strategy_cn = STRATEGY_CN.get(strategy, "未知")
            
            self._add(f"| {emoji} {strategy_cn} | {count} 个 | ¥{savings:,.0f} | {pct:.1f}% | ¥{avg_savings:,.0f} |")
        
        self._add(f"| **合计** | **{len(self.data.results)} 个** | **¥{total_savings:,.0f}** | **100%** | - |")
        self._add("")
        
        # 按产品分组统计
        by_product: dict[str, list[OptimizeResult]] = {}
        for r in self.data.results:
            by_product.setdefault(r.product, []).append(r)
        
        if len(by_product) > 1:
            self._add("### 按产品分布")
            self._add("")
            self._add("| 产品 | 资源数 | 月节省金额 | 占比 |")
            self._add("|:-----|-------:|-----------:|-----:|")
            
            for product, results in sorted(by_product.items(), key=lambda x: -sum(r.cost_savings for r in x[1])):
                count = len(results)
                savings = sum(r.cost_savings for r in results)
                pct = (savings / total_savings * 100) if total_savings > 0 else 0
                emoji = PRODUCT_EMOJI.get(product.lower(), "📦")
                
                self._add(f"| {emoji} {product.upper()} | {count} 个 | ¥{savings:,.0f} | {pct:.1f}% |")
            
            self._add("")
    
    def _add_optimization_details(self) -> None:
        """添加优化建议明细。"""
        if not self.data.results:
            self._add("## ✅ 分析结论")
            self._add("")
            self._add("> 所有资源均处于健康状态，无需优化操作。")
            self._add("")
            return
        
        self._add("## 📝 优化建议明细")
        self._add("")
        
        # 按策略分组
        by_strategy: dict[OptimizeStrategy, list[OptimizeResult]] = {}
        for r in self.data.results:
            by_strategy.setdefault(r.strategy, []).append(r)
        
        for strategy in sorted(by_strategy.keys(), key=lambda s: STRATEGY_PRIORITY.get(s, 99)):
            results = by_strategy[strategy]
            priority = STRATEGY_PRIORITY.get(strategy, 99)
            emoji = STRATEGY_EMOJI.get(strategy, "")
            strategy_cn = STRATEGY_CN.get(strategy, "未知")
            strategy_savings = sum(r.cost_savings for r in results)
            
            self._add(f"### {emoji} {priority}. {strategy_cn}（{len(results)} 个，月省 ¥{strategy_savings:,.0f}）")
            self._add("")
            
            # 添加策略说明
            if strategy == OptimizeStrategy.RELEASE:
                self._add("> 💡 **释放策略说明**: 资源监控指标持续处于极低水平，属于完全闲置状态。释放后不影响业务，可立即节省成本。")
            elif strategy == OptimizeStrategy.DOWN_SCALING:
                self._add("> 💡 **降配策略说明**: 资源 P95 利用率长期低于阈值，存在明显的资源过配。降配至推荐规格可在保障业务的同时降低成本。")
            elif strategy == OptimizeStrategy.CONVERT_TO_PREPAID:
                self._add("> 💡 **转包月策略说明**: 按量付费资源已长期稳定运行，预计将持续使用。转为包年包月可享受更优惠的价格。")
            self._add("")
            
            # 明细表格
            self._add("| 实例 ID | 实例名称 | 当前规格 | 目标规格 | 当前月费 | 目标月费 | 月节省 | 节省% |")
            self._add("|:--------|:---------|:---------|:---------|----------:|----------:|--------:|------:|")
            
            for r in sorted(results, key=lambda x: -x.cost_savings):
                target = r.optimized_config or "-"
                if strategy == OptimizeStrategy.RELEASE:
                    target = "🗑️ 释放"
                elif strategy == OptimizeStrategy.CONVERT_TO_PREPAID:
                    target = f"🔄 {r.instance_type}(包月)"
                elif strategy == OptimizeStrategy.DOWN_SCALING and r.optimized_config:
                    target = f"⬇️ {r.optimized_config}"
                
                name = r.resource_name or "-"
                # 截断过长的名称
                if len(name) > 20:
                    name = name[:17] + "..."
                
                self._add(
                    f"| `{r.resource_id}` | {name} | {r.instance_type} | {target} | "
                    f"¥{r.cost_before:,.0f} | ¥{r.cost_after:,.0f} | **¥{r.cost_savings:,.0f}** | {r.savings_pct:.1f}% |"
                )
            
            self._add("")
        
        # 详细说明部分
        self._add_divider()
        self._add("### 📖 详细分析说明")
        self._add("")
        
        for i, r in enumerate(sorted(self.data.results, key=lambda x: (x.priority, -x.cost_savings)), 1):
            emoji = STRATEGY_EMOJI.get(r.strategy, "")
            name_str = f" ({r.resource_name})" if r.resource_name else ""
            
            self._add(f"<details>")
            self._add(f"<summary><b>{i}. {emoji} {r.resource_id}{name_str}</b> - 月省 ¥{r.cost_savings:,.0f}</summary>")
            self._add("")
            
            # 构建详细说明
            self._add(f"- **产品类型**: {r.product.upper()}")
            self._add(f"- **所在区域**: {r.region_id}")
            self._add(f"- **当前规格**: {r.instance_type}")
            self._add(f"- **付费类型**: {r.charge_type}")
            self._add(f"- **优化策略**: {r.strategy_cn}")
            
            # 添加诊断原因
            reason = self._format_reason(r)
            self._add(f"- **诊断原因**: {reason}")
            
            # 添加建议操作
            action = self._format_action(r)
            self._add(f"- **建议操作**: {action}")
            
            # 费用对比
            self._add(f"- **费用对比**: ¥{r.cost_before:,.0f}/月 → ¥{r.cost_after:,.0f}/月 (省 ¥{r.cost_savings:,.0f}/月)")
            
            self._add("")
            self._add("</details>")
            self._add("")
    
    def _format_reason(self, result: OptimizeResult) -> str:
        """格式化诊断原因。"""
        extend = result.extend_result
        
        if result.strategy == OptimizeStrategy.RELEASE:
            metrics = extend.get("metrics", {})
            if metrics:
                metrics_str = ", ".join(f"{k}={v}" for k, v in metrics.items())
                return f"资源完全闲置，监控指标: {metrics_str}"
            return "资源完全闲置，监控数据显示无实际使用"
        
        elif result.strategy == OptimizeStrategy.DOWN_SCALING:
            metrics = extend.get("metrics", {})
            threshold = extend.get("low_util_threshold", 20)
            if metrics:
                metrics_str = ", ".join(f"{k}={v}" for k, v in metrics.items())
                return f"P95 利用率低于 {threshold}%，指标: {metrics_str}"
            return f"资源利用率持续偏低（P95 < {threshold}%）"
        
        elif result.strategy == OptimizeStrategy.CONVERT_TO_PREPAID:
            hold_days = extend.get("hold_days", 0)
            threshold = extend.get("threshold", 30)
            return f"按量付费已持有 {hold_days} 天，超过 {threshold} 天阈值"
        
        return "-"
    
    def _format_action(self, result: OptimizeResult) -> str:
        """格式化建议操作。"""
        if result.strategy == OptimizeStrategy.RELEASE:
            return f"确认无业务依赖后释放实例，预计月省 ¥{result.cost_savings:,.0f}"
        
        elif result.strategy == OptimizeStrategy.DOWN_SCALING:
            target = result.optimized_config or "更低规格"
            return f"将规格从 {result.instance_type} 降配至 {target}，预计月省 ¥{result.cost_savings:,.0f}"
        
        elif result.strategy == OptimizeStrategy.CONVERT_TO_PREPAID:
            return f"将付费模式从按量付费转为包年包月，预计月省 ¥{result.cost_savings:,.0f}"
        
        return "-"
    
    def _add_risk_assessment(self) -> None:
        """添加风险评估。"""
        if not self.data.results:
            return
        
        self._add("## ⚠️ 风险评估")
        self._add("")
        
        self._add("| 优化策略 | 风险等级 | 影响范围 | 回滚难度 | 建议 |")
        self._add("|:---------|:---------|:---------|:---------|:-----|")
        self._add("| 🗑️ 释放资源 | 🔴 高 | 资源永久删除 | 无法回滚 | 务必确认无业务依赖 |")
        self._add("| ⬇️ 降配 | 🟡 中 | 性能下降 | 可升配恢复 | 建议在低峰期操作 |")
        self._add("| 🔄 转包月 | 🟢 低 | 计费方式变更 | 可转按量 | 确认长期使用需求 |")
        self._add("")
        
        # 风险提示
        self._add("### 🚨 重要提示")
        self._add("")
        self._add("1. **释放操作不可逆**: 释放资源前请务必确认数据已备份，业务已迁移")
        self._add("2. **降配可能影响性能**: 请在业务低峰期进行，并监控降配后的性能指标")
        self._add("3. **包月承诺期**: 转为包月后如提前释放可能产生违约金，请确认使用周期")
        self._add("4. **灰度执行**: 建议分批次执行优化操作，每批次观察 24-48 小时")
        self._add("")
    
    def _add_implementation_guide(self) -> None:
        """添加实施建议。"""
        if not self.data.results:
            return
        
        self._add("## 🚀 实施建议")
        self._add("")
        
        # 按优先级分阶段
        total_savings = sum(r.cost_savings for r in self.data.results)
        
        by_strategy: dict[OptimizeStrategy, list[OptimizeResult]] = {}
        for r in self.data.results:
            by_strategy.setdefault(r.strategy, []).append(r)
        
        self._add("### 分阶段实施计划")
        self._add("")
        
        phase = 1
        cumulative_savings = 0
        
        # Phase 1: 低风险操作（转包月）
        if OptimizeStrategy.CONVERT_TO_PREPAID in by_strategy:
            results = by_strategy[OptimizeStrategy.CONVERT_TO_PREPAID]
            savings = sum(r.cost_savings for r in results)
            cumulative_savings += savings
            
            self._add(f"#### 🟢 阶段 {phase}: 计费优化（预计 1-2 天）")
            self._add("")
            self._add(f"- **操作内容**: 将 {len(results)} 个长期按量资源转为包年包月")
            self._add(f"- **预计节省**: ¥{savings:,.0f}/月（累计 ¥{cumulative_savings:,.0f}/月）")
            self._add("- **风险等级**: 🟢 低")
            self._add("- **执行建议**: 可批量操作，无需停机")
            self._add("")
            phase += 1
        
        # Phase 2: 中风险操作（降配）
        if OptimizeStrategy.DOWN_SCALING in by_strategy:
            results = by_strategy[OptimizeStrategy.DOWN_SCALING]
            savings = sum(r.cost_savings for r in results)
            cumulative_savings += savings
            
            self._add(f"#### 🟡 阶段 {phase}: 规格优化（预计 3-5 天）")
            self._add("")
            self._add(f"- **操作内容**: 将 {len(results)} 个低利用率资源降配至推荐规格")
            self._add(f"- **预计节省**: ¥{savings:,.0f}/月（累计 ¥{cumulative_savings:,.0f}/月）")
            self._add("- **风险等级**: 🟡 中")
            self._add("- **执行建议**: 分批操作，每批观察 24 小时后继续")
            self._add("")
            phase += 1
        
        # Phase 3: 高风险操作（释放）
        if OptimizeStrategy.RELEASE in by_strategy:
            results = by_strategy[OptimizeStrategy.RELEASE]
            savings = sum(r.cost_savings for r in results)
            cumulative_savings += savings
            
            self._add(f"#### 🔴 阶段 {phase}: 资源释放（预计 5-7 天）")
            self._add("")
            self._add(f"- **操作内容**: 释放 {len(results)} 个闲置资源")
            self._add(f"- **预计节省**: ¥{savings:,.0f}/月（累计 ¥{cumulative_savings:,.0f}/月）")
            self._add("- **风险等级**: 🔴 高")
            self._add("- **执行建议**: 逐个确认业务依赖，创建快照后操作")
            self._add("")
        
        # ROI 分析
        self._add("### 📈 投资回报分析")
        self._add("")
        self._add("| 指标 | 数值 |")
        self._add("|:-----|-----:|")
        self._add(f"| 月度节省 | ¥{total_savings:,.0f} |")
        self._add(f"| 季度节省 | ¥{total_savings * 3:,.0f} |")
        self._add(f"| 年度节省 | ¥{total_savings * 12:,.0f} |")
        self._add(f"| 实施周期 | 约 1-2 周 |")
        self._add(f"| 首月 ROI | {total_savings / max(total_savings * 0.1, 1) * 100:.0f}%+ |")
        self._add("")
    
    def _add_policy_rules(self) -> None:
        """添加策略规则说明章节。"""
        self._add("## 📖 策略规则说明")
        self._add("")
        self._add("> 本报告基于以下成本优化规则进行分析，各产品规则在检测过程中自动应用。")
        self._add("")
        
        # =================================================================
        # 闲置资源判定标准
        # =================================================================
        self._add("### 🔴 闲置资源判定标准")
        self._add("")
        self._add("> 满足以下条件的资源将被判定为闲置，建议释放以节省成本。")
        self._add("")
        self._add("| 产品 | 判定条件 | 检测周期 | 检测方式 |")
        self._add("|:-----|:---------|:---------|:---------|")
        self._add("| ECS 云服务器 | CPU 最大值 < 1% **且** 内存最大值 < 1% | 7 天 | 云监控 Maximum 统计 |")
        self._add("| RDS 云数据库 | CPU 最大值 < 1% **且** 连接数 < 5 | 7 天 | 云监控 Maximum 统计 |")
        self._add("| Redis 缓存 | CPU/内存/连接数峰值 ≤ 10% **且** 均值 ≤ 5%, QPS 峰值 ≤ 50 **且** 均值 ≤ 25 | 7 天 | 云监控多指标综合 |")
        self._add("| EIP 弹性公网IP | 未绑定任何资源 | > 14 天 | DescribeEipAddresses API |")
        self._add("| NAT 网关 | 无绑定 EIP，**或** 无 SNAT/DNAT 规则 | - | VPC API 查询 |")
        self._add("| SLB 负载均衡 | 无后端服务器，**或** 7天无流量 | 7 天 | API + 云监控 |")
        self._add("| EBS 云盘 | 未挂载到任何 ECS (Status=Available) | - | DescribeDisks API |")
        self._add("| MSE 注册中心 | Eureka/Nacos 健康实例数=0，或 Zookeeper TPS=0 | 7 天 | MSE API + 云监控 |")
        self._add("| RocketMQ | Topic 无监控数据（无生产/消费） | 7 天 | 云监控指标 |")
        self._add("| Elasticsearch | 集群无索引操作 **且** 无查询请求 | 7 天 | 云监控 QPS 指标 |")
        self._add("| DRDS/PolarDB-X | CPU 最大值 < 1% **且** QPS < 10 | 7 天 | 云监控综合 |")
        self._add("")
        
        # =================================================================
        # 低利用率判定标准
        # =================================================================
        self._add("### 🟡 低利用率判定标准")
        self._add("")
        self._add("> 满足以下条件的资源存在资源过配，建议降配至更低规格。")
        self._add("")
        self._add("| 产品 | 判定条件 | 统计方式 | 检测周期 |")
        self._add("|:-----|:---------|:---------|:---------|")
        self._add("| ECS 云服务器 | CPU P95 < 20% **或** 内存 P95 < 20% | 云监控 P95 统计 | 7 天 |")
        self._add("| RDS 云数据库 | CPU P95 < 20% **或** 内存 P95 < 20% | 云监控 P95 统计 | 7 天 |")
        self._add("| Redis 缓存 | CPU/内存/连接数/QPS 峰值 ≤ 30% **且** 均值 ≤ 15% | 云监控多指标 | 14 天 |")
        self._add("| MSE 注册中心 | CPU 峰值 < 30% | 云监控 Maximum | 30 天 |")
        self._add("| NAS 文件存储 | 存储利用率 < 30%（已用/已购） | API 查询 | - |")
        self._add("| SLB 负载均衡 | 活跃连接数 P95 < 规格上限 10% | 云监控 P95 | 7 天 |")
        self._add("| EBS 云盘 | IOPS/吞吐量利用率 < 10% | 云监控 | 7 天 |")
        self._add("| Elasticsearch | 节点 CPU/内存 P95 < 30% | 云监控 P95 | 14 天 |")
        self._add("| DRDS/PolarDB-X | CPU P95 < 20% **或** 内存 P95 < 20% | 云监控 P95 | 7 天 |")
        self._add("")
        
        # =================================================================
        # 计费优化判定标准
        # =================================================================
        self._add("### 🟢 计费优化判定标准")
        self._add("")
        self._add("> 满足以下条件的资源可通过转换计费方式或购买资源包来降低成本。")
        self._add("")
        self._add("| 产品 | 判定条件 | 优化建议 | 预计节省 |")
        self._add("|:-----|:---------|:---------|:---------|")
        self._add("| ECS/RDS/Redis 等 | 按量付费持有时间 > 30 天 | 转为包年包月 | 约 30%-50% |")
        self._add("| CDN 内容分发 | 月流量 > 10TB 但未使用资源包 | 购买流量资源包 | 约 20%-30% |")
        self._add("| SLS 日志服务 | 存储量 > 100GB 未开启智能分层 | 开启智能存储分层 | 约 70% |")
        self._add("| NAS 文件存储 | 未配置生命周期策略 | 开启冷数据自动转储 | 约 50%-92% |")
        self._add("| Redis 缓存 | 存储量 > 100GB·小时/月 | 购买存储资源包 | 约 20%-30% |")
        self._add("| ARMS 监控 | 调用量/Span存储超过免费额度 | 购买资源包 | 约 30%+ |")
        self._add("| MaxCompute | CU 用量/存储量较大 | 购买 CU/存储资源包 | 约 20%-40% |")
        self._add("| WAF 防火墙 | SeCU 用量较大 | 购买 SeCU 资源包 | 约 20%-30% |")
        self._add("")
        
        # =================================================================
        # 各产品详细规则
        # =================================================================
        self._add("### 📝 各产品详细检测规则")
        self._add("")
        
        # ECS 规则
        self._add("#### 🖥️ ECS 云服务器")
        self._add("")
        self._add("| 检测项 | 规则说明 | 阈值 | 检测方式 |")
        self._add("|:-------|:---------|:------|:---------|")
        self._add("| 闲置实例 | CPU Maximum < 阈值 **且** 内存 Maximum < 阈值 | 1% | 云监控 7天指标 |")
        self._add("| 低利用率 | CPU P95 < 阈值 **或** 内存 P95 < 阈值 | 20% | 云监控 P95 统计 |")
        self._add("| 计费优化 | 按量付费持有超过阈值 | 30天 | 实例创建时间 |")
        self._add("| 规格推荐 | 基于实际负载推荐最优规格 | - | DescribeSceneResourceRecommend API |")
        self._add("| 非生产关停 | 非生产环境按量实例可定时关停 | - | 标签识别 + 定时任务 |")
        self._add("")
        
        # RDS 规则
        self._add("#### 🗄️ RDS 云数据库")
        self._add("")
        self._add("| 检测项 | 规则说明 | 阈值 | 检测方式 |")
        self._add("|:-------|:---------|:------|:---------|")
        self._add("| 闲置实例 | CPU Maximum < 阈值 **且** 连接数 < 5 | 1% | 云监控 7天指标 |")
        self._add("| 低利用率 | CPU P95 < 阈值 **或** 内存 P95 < 阈值 | 20% | 云监控 P95 统计 |")
        self._add("| 计费优化 | 按量付费持有超过阈值 | 30天 | 实例创建时间 |")
        self._add("| 规格推荐 | 查询可用规格并计算降配节省 | - | DescribeAvailableClasses API |")
        self._add("| 存储优化 | 磁盘空间使用率 < 30% | 30% | 实例详情查询 |")
        self._add("")
        
        # Redis 规则
        self._add("#### ⚡ Redis 缓存")
        self._add("")
        self._add("| 检测项 | 规则说明 | 阈值 | 检测方式 |")
        self._add("|:-------|:---------|:------|:---------|")
        self._add("| 闲置实例 | CPU/内存/连接数峰值♤1% **且** QPS峰值♈10 | 1%/10 | 云监控 7天指标 |")
        self._add("| 低利用率 | 所有指标峰值≤30% **且** 均值≤15% | 30%/15% | 云监控多指标 |")
        self._add("| 计费优化 | 按量付费持有超过阈值 | 30天 | 实例创建时间 |")
        self._add("| 资源包推荐 | 存储量超 100GB·小时/月 | 100 | BSS 账单分析 |")
        self._add("")
        
        # EIP 规则
        self._add("#### 🌐 EIP 弹性公网IP")
        self._add("")
        self._add("| 检测项 | 规则说明 | 阈值 | 检测方式 |")
        self._add("|:-------|:---------|:------|:---------|")
        self._add("| 未绑定闲置 | EIP 未绑定任何资源 | 14天 | DescribeEipAddresses API |")
        self._add("| 低带宽利用 | 出向带宽利用率 < 阈值 | 10% | 云监控带宽指标 |")
        self._add("| 计费优化 | 按量付费持有超过阈值 | 30天 | 分配时间 |")
        self._add("| 带宽过配 | 实际带宽 < 购买带宽 20% | 20% | 云监控峰值 |")
        self._add("")
        
        # SLB 规则
        self._add("#### ⚖️ SLB 负载均衡")
        self._add("")
        self._add("| 检测项 | 规则说明 | 阈值 | 检测方式 |")
        self._add("|:-------|:---------|:------|:---------|")
        self._add("| 无后端闲置 | SLB 未配置任何后端服务器 | - | DescribeLoadBalancerAttribute API |")
        self._add("| 无流量闲置 | 7天无任何进出流量 | 0 | 云监控流量指标 |")
        self._add("| 计费优化 | 按量付费持有超过阈值 | 30天 | 创建时间 |")
        self._add("| 规格过配 | 活跃连接数 < 规格上限 10% | 10% | 云监控 P95 |")
        self._add("")
        
        # EBS 规则
        self._add("#### 💾 EBS 云盘")
        self._add("")
        self._add("| 检测项 | 规则说明 | 阈值 | 检测方式 |")
        self._add("|:-------|:---------|:------|:---------|")
        self._add("| 未挂载闲置 | 云盘未挂载到任何 ECS | - | DescribeDisks API (Status=Available) |")
        self._add("| 低利用率 | IOPS/吞吐量利用率 < 阈值 | 10% | 云监控云盘指标 |")
        self._add("| 计费优化 | 按量付费持有超过阈值 | 30天 | 创建时间 |")
        self._add("| 存储类型优化 | 高性能云盘但 IOPS 使用率低 | - | 建议降级为高效云盘 |")
        self._add("")
        
        # NAT 规则
        self._add("#### 🚀 NAT 网关")
        self._add("")
        self._add("| 检测项 | 规则说明 | 阈值 | 检测方式 |")
        self._add("|:-------|:---------|:------|:---------|")
        self._add("| 无EIP闲置 | NAT 网关未绑定任何 EIP | 0 | DescribeNatGateways API |")
        self._add("| 无SNAT规则 | 未配置SNAT规则（出向访问） | 0 | DescribeSnatTableEntries API |")
        self._add("| 无DNAT规则 | 未配置DNAT规则（端口映射） | 0 | DescribeForwardTableEntries API |")
        self._add("| 计费优化 | 按量付费持有超过阈值 | 30天 | 创建时间 |")
        self._add("| 规格过配 | 并发连接数 < 规格上限 20% | 20% | 云监控指标 |")
        self._add("")
        
        # CDN 规则
        self._add("#### 🌍 CDN 内容分发")
        self._add("")
        self._add("| 检测项 | 规则说明 | 优化建议 | 预计节省 |")
        self._add("|:-------|:---------|:---------|:---------|")
        self._add("| Range回源 | 未启用 Range 回源功能 | 启用后可减少回源带宽 | 30%+ |")
        self._add("| 智能压缩 | 未启用 Gzip/Brotli 压缩 | 启用后可节省流量 | 40%+ |")
        self._add("| 缓存配置 | 未配置缓存规则或缓存时间 < 1天 | 配置静态资源缓存 7天+ | 回源减少 |")
        self._add("| 共享缓存 | OSS 源站未启用共享缓存 | 启用后可节省回源流量费 | 20%+ |")
        self._add("| 计费优化 | 流量超过 10TB/月但未用资源包 | 购买流量包 | 20%-30% |")
        self._add("| 带宽计费 | 峰值带宽超过 1Gbps | 考虑按流量计费 | 视情况 |")
        self._add("")
        
        # NAS 规则
        self._add("#### 📁 NAS 文件存储")
        self._add("")
        self._add("| 检测项 | 规则说明 | 优化建议 | 预计节省 |")
        self._add("|:-------|:---------|:---------|:---------|")
        self._add("| 生命周期 | 未配置生命周期策略 | 配置冷数据自动转低频存储 | 50%-92% |")
        self._add("| 存储类型 | 全量数据存在性能型存储 | 冷数据转到容量型或低频存储 | 50%+ |")
        self._add("| 计费优化 | 按量付费持有 > 30天 | 购买存储包 | 20%-30% |")
        self._add("| 利用率低 | 存储利用率 < 30% | 评估是否需要当前容量 | - |")
        self._add("")
        
        # SLS 规则
        self._add("#### 📝 SLS 日志服务")
        self._add("")
        self._add("| 检测项 | 规则说明 | 优化建议 | 预计节省 |")
        self._add("|:-------|:---------|:---------|:---------|")
        self._add("| 智能分层 | 保留期>7天未启用智能分层存储 | 启用后冷数据自动转归档 | 70%+ |")
        self._add("| 存储时长 | 日志保存时间过长（>180天） | 设置合理的日志保存期限 | 50%+ |")
        self._add("| 索引优化 | 全字段开启索引 | 精简索引字段节省存储 | 30%+ |")
        self._add("| 存储超标 | 存储量 > 100GB 未开启分层 | 开启智能存储分层 | 70% |")
        self._add("")
        
        # MSE 规则
        self._add("#### 📡 MSE 微服务引擎")
        self._add("")
        self._add("| 检测项 | 规则说明 | 阈值 | 检测方式 |")
        self._add("|:-------|:---------|:------|:---------|")
        self._add("| 闲置(Eureka/Nacos) | 健康实例（Provider）数为0 | 0 | MSE API 查询 |")
        self._add("| 闲置(Zookeeper) | TPS 为 0 | 0 | 云监控指标 |")
        self._add("| 低利用率 | 30天 CPU 峰值 < 阈值 | 30% | 云监控 Maximum |")
        self._add("| 计费优化 | 按量付费持有超过阈值 | 30天 | 实例创建时间 |")
        self._add("")
        
        # 其他产品规则摘要
        self._add("#### 📦 其他产品规则摘要")
        self._add("")
        self._add("| 产品 | 闲置检测 | 低利用率检测 | 计费优化 |")
        self._add("|:-----|:---------|:---------|:---------|")
        self._add("| DRDS/PolarDB-X | CPU<1% 且 QPS<10 | CPU P95<20% | 按量>30天转包月 |")
        self._add("| Elasticsearch | 无索引操作且无查询 | 节点CPU/内存 P95<30% | 按量>30天转包月 |")
        self._add("| RocketMQ | Topic 无生产/消费>7天 | - | 无消息Topic建议清理 |")
        self._add("| ARMS | - | - | 调用量超额购买资源包 |")
        self._add("| MaxCompute | - | - | CU/存储用量大购买资源包 |")
        self._add("| WAF | - | - | SeCU用量大购买资源包 |")
        self._add("| MongoDB | CPU<1% 且 连接数<5 | CPU/内存 P95<20% | 按量>30天转包月 |")
        self._add("")
        
        # 规则说明
        self._add("> 💡 **规则说明**:")
        self._add("> - 上述阈值为默认配置，可根据业务实际情况调整")
        self._add("> - 闲置检测优先于低利用率检测，低利用率优先于计费优化")
        self._add("> - 同一资源命中多条规则时，只保留优先级最高的一条建议")
        self._add("> - 所有优化建议均需经业务方确认后再执行")
        self._add("")
    
    def _add_analysis_params(self) -> None:
        """添加分析参数。"""
        self._add("## ⚙️ 分析参数")
        self._add("")
        
        params = self.data.params
        
        self._add("| 参数 | 当前值 | 说明 |")
        self._add("|:-----|:-------|:-----|")
        self._add(f"| 闲置判定阈值 | {params.get('idle_threshold', 1.0)}% | 监控指标低于此值视为闲置 |")
        self._add(f"| 低利用率阈值 | {params.get('low_util_threshold', 20.0)}% | P95 低于此值建议降配 |")
        self._add(f"| 按量持有天数 | {params.get('hold_days', 30)} 天 | 超过此值建议转包月 |")
        self._add(f"| BSS 精确询价 | {'✅ 是' if params.get('use_bss_pricing', True) else '❌ 否'} | 使用 BSS API 获取准确价格 |")
        self._add("")
        
        self._add("> 💡 **提示**: 可通过调整上述参数来适配不同的优化策略。阈值越低，检测越严格。")
        self._add("")
    
    def _add_footer(self) -> None:
        """添加报告尾部。"""
        self._add_divider()
        self._add("---")
        self._add("")
        self._add(f"*本报告由 Copaw FinOps 成本优化引擎自动生成*")
        self._add(f"*生成时间: {self.data.generated_at.strftime('%Y-%m-%d %H:%M:%S')}*")


# =============================================================================
# 便捷函数
# =============================================================================

def generate_cost_report(
    results: list[OptimizeResult],
    region_id: str,
    products: list[str],
    stats: dict[str, int],
    params: Optional[dict[str, Any]] = None,
    title: str = "云资源成本优化分析报告",
) -> str:
    """生成成本优化报告。
    
    Args:
        results: 优化结果列表
        region_id: 地域 ID
        products: 产品列表
        stats: 统计信息
        params: 分析参数
        title: 报告标题
    
    Returns:
        Markdown 格式报告
    """
    data = ReportData(
        title=title,
        region_id=region_id,
        products=products,
        results=results,
        stats=stats,
        params=params or {},
    )
    
    generator = CostReportGenerator(data)
    return generator.generate()


def generate_single_product_report(
    results: list[OptimizeResult],
    product_name: str,
    region_id: str,
    stats: dict[str, int],
    params: Optional[dict[str, Any]] = None,
) -> str:
    """生成单产品成本优化报告。
    
    Args:
        results: 优化结果列表
        product_name: 产品名称
        region_id: 地域 ID
        stats: 统计信息
        params: 分析参数
    
    Returns:
        Markdown 格式报告
    """
    return generate_cost_report(
        results=results,
        region_id=region_id,
        products=[product_name],
        stats=stats,
        params=params,
        title=f"{product_name} 成本优化分析报告",
    )


def generate_report_from_dict(
    recommendations: list[dict],
    region_id: str,
    product_name: str,
    stats: dict[str, int],
    params: Optional[dict[str, Any]] = None,
) -> str:
    """从字典格式的建议列表生成报告。
    
    用于兼容旧版本的 dict 格式数据。
    
    Args:
        recommendations: 字典格式的建议列表，每项包含:
            - instance_id: 实例 ID
            - instance_name: 实例名称
            - instance_type: 当前规格
            - target_type: 目标规格（可选）
            - strategy: 策略（Release/DownScaling/ConvertToPrePaid）
            - cost_before: 当前月费
            - cost_after: 目标月费
            - cost_saving: 月节省
            - reason: 原因说明
            - action: 建议操作
        region_id: 地域 ID
        product_name: 产品名称
        stats: 统计信息
        params: 分析参数
    
    Returns:
        Markdown 格式报告
    """
    # 将字典转换为 OptimizeResult
    results = []
    for rec in recommendations:
        strategy_str = rec.get("strategy", "Release")
        if strategy_str == "Release":
            strategy = OptimizeStrategy.RELEASE
        elif strategy_str == "DownScaling":
            strategy = OptimizeStrategy.DOWN_SCALING
        elif strategy_str == "ConvertToPrePaid":
            strategy = OptimizeStrategy.CONVERT_TO_PREPAID
        else:
            strategy = OptimizeStrategy.RELEASE
        
        result = OptimizeResult(
            product=product_name.lower(),
            resource_id=rec.get("instance_id", ""),
            resource_name=rec.get("instance_name", ""),
            region_id=region_id,
            instance_type=rec.get("instance_type", ""),
            charge_type=rec.get("charge_type", "PostPaid"),
            strategy=strategy,
            optimized_config=rec.get("target_type", ""),
            cost_before=rec.get("cost_before", 0),
            cost_after=rec.get("cost_after", 0),
            cost_savings=rec.get("cost_saving", 0),
            savings_pct=rec.get("savings_pct", 0) or (
                (rec.get("cost_saving", 0) / rec.get("cost_before", 1) * 100)
                if rec.get("cost_before", 0) > 0 else 0
            ),
            extend_result={
                "reason": rec.get("reason", ""),
                "action": rec.get("action", ""),
                "utilization": rec.get("utilization", {}),
                "hold_days": rec.get("hold_days", 0),
            },
        )
        results.append(result)
    
    return generate_cost_report(
        results=results,
        region_id=region_id,
        products=[product_name],
        stats=stats,
        params=params,
        title=f"{product_name} 成本优化分析报告",
    )

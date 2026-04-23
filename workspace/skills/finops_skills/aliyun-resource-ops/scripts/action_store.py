# -*- coding: utf-8 -*-
"""优化动作存储模块 - optimizer 与 resource-ops 联动的核心。

Action Store 负责：
1. 持久化存储可执行的优化动作
2. 提供查询、更新、统计等 API
3. 支持动作状态流转（pending -> executed / skipped / failed）

数据流：
  optimizer 分析 -> 提取可执行动作 -> Action Store -> resource-ops 执行

存储路径：~/.copaw/data/optimization_actions.json
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Optional
from uuid import uuid4

logger = logging.getLogger(__name__)


# =============================================================================
# 枚举和数据结构
# =============================================================================


class ActionStatus(str, Enum):
    """动作状态枚举。"""
    PENDING = "pending"       # 待执行
    EXECUTED = "executed"     # 已执行
    SKIPPED = "skipped"       # 已跳过（用户主动忽略）
    FAILED = "failed"         # 执行失败
    EXPIRED = "expired"       # 已过期（超过有效期）


class ActionStrategy(str, Enum):
    """执行策略枚举。"""
    RELEASE = "Release"              # 释放资源
    DOWN_SCALING = "DownScaling"     # 降配
    CONVERT_TO_PREPAID = "ConvertToPrePaid"  # 转包月


# 支持自动执行的策略
EXECUTABLE_STRATEGIES = {
    ActionStrategy.RELEASE,
    ActionStrategy.DOWN_SCALING,
}

# 支持的产品类型（后续可扩展）
SUPPORTED_PRODUCTS = {
    "ECS": "ecs:instance",
    "RDS": "rds:instance",
    "EIP": "eip",
    "EBS": "disk",
    "SLB": "slb:instance",
    "CLB": "slb:instance",
    "Redis": "redis:instance",
    "NAT": "nat_gateway",
}


@dataclass
class OptimizationAction:
    """优化动作记录。
    
    单条可执行的优化动作，包含执行所需的全部信息。
    """
    # 唯一标识
    action_id: str
    
    # 资源信息
    product: str                 # 产品类型: ECS / RDS / EIP / EBS / SLB / Redis
    resource_id: str             # 资源 ID
    resource_name: str           # 资源名称
    region_id: str               # 区域 ID
    
    # 优化策略
    strategy: str                # Release / DownScaling
    current_spec: str            # 当前规格
    target_spec: Optional[str]   # 目标规格（降配时有值）
    
    # 费用信息
    cost_before: float           # 当前月费
    cost_after: float            # 目标月费
    cost_saving: float           # 预估节省
    
    # 原因说明
    reason: str                  # 优化原因
    check_id: str = ""           # 命中的规则 ID
    
    # 状态
    status: str = ActionStatus.PENDING.value
    
    # 时间信息
    created_at: str = ""
    executed_at: Optional[str] = None
    expires_at: Optional[str] = None  # 过期时间（7天后）
    
    # 来源追踪
    source_analysis_id: str = ""      # 来源分析任务 ID
    source_product: str = ""          # 来源产品（与 product 可能不同格式）
    
    # 执行结果
    execute_result: dict = field(default_factory=dict)
    skip_reason: str = ""
    
    def to_dict(self) -> dict:
        """转换为字典。"""
        return asdict(self)
    
    @classmethod
    def from_dict(cls, data: dict) -> "OptimizationAction":
        """从字典创建。"""
        return cls(
            action_id=data.get("action_id", ""),
            product=data.get("product", ""),
            resource_id=data.get("resource_id", ""),
            resource_name=data.get("resource_name", ""),
            region_id=data.get("region_id", ""),
            strategy=data.get("strategy", ""),
            current_spec=data.get("current_spec", ""),
            target_spec=data.get("target_spec"),
            cost_before=data.get("cost_before", 0.0),
            cost_after=data.get("cost_after", 0.0),
            cost_saving=data.get("cost_saving", 0.0),
            reason=data.get("reason", ""),
            check_id=data.get("check_id", ""),
            status=data.get("status", ActionStatus.PENDING.value),
            created_at=data.get("created_at", ""),
            executed_at=data.get("executed_at"),
            expires_at=data.get("expires_at"),
            source_analysis_id=data.get("source_analysis_id", ""),
            source_product=data.get("source_product", ""),
            execute_result=data.get("execute_result", {}),
            skip_reason=data.get("skip_reason", ""),
        )
    
    def is_executable(self) -> bool:
        """检查是否可执行。"""
        # 只有 pending 状态才可执行
        if self.status != ActionStatus.PENDING.value:
            return False
        
        # 检查是否已过期
        if self.expires_at:
            try:
                expires = datetime.fromisoformat(self.expires_at.replace("Z", "+00:00"))
                if datetime.now(timezone.utc) > expires:
                    return False
            except ValueError:
                pass
        
        # 策略必须是可执行的
        return self.strategy in [s.value for s in EXECUTABLE_STRATEGIES]


# =============================================================================
# Action Store 管理类
# =============================================================================


class ActionStore:
    """优化动作存储管理器。
    
    Usage:
        store = ActionStore()
        
        # 保存动作
        store.save_actions(actions, analysis_id="report_20260321")
        
        # 查询待执行动作
        pending = store.list_pending(product="ECS")
        
        # 更新状态
        store.mark_executed(action_id, result={...})
        store.mark_skipped(action_id, reason="业务需要保留")
    """
    
    def __init__(self, store_path: Optional[Path] = None):
        """初始化存储管理器。
        
        Args:
            store_path: 存储文件路径，默认 ~/.copaw/data/optimization_actions.json
        """
        self._store_path = store_path or (Path.home() / ".copaw" / "data" / "optimization_actions.json")
        self._store_path.parent.mkdir(parents=True, exist_ok=True)
    
    def _load(self) -> dict:
        """加载存储数据。"""
        try:
            return json.loads(self._store_path.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError):
            return {
                "version": "1.0",
                "actions": [],
                "stats": {
                    "total_created": 0,
                    "total_executed": 0,
                    "total_skipped": 0,
                    "total_savings_realized": 0.0,
                },
                "updated_at": "",
            }
    
    def _save(self, data: dict) -> None:
        """保存存储数据。"""
        data["updated_at"] = datetime.now(timezone.utc).isoformat()
        self._store_path.write_text(
            json.dumps(data, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
    
    # -------------------------------------------------------------------------
    # 写入操作
    # -------------------------------------------------------------------------
    
    def save_actions(
        self,
        actions: list[OptimizationAction],
        analysis_id: str = "",
        replace_pending: bool = False,
    ) -> dict:
        """保存优化动作列表。
        
        Args:
            actions: 动作列表
            analysis_id: 分析任务 ID
            replace_pending: 是否替换现有的 pending 动作（同一资源）
        
        Returns:
            保存结果统计
        """
        data = self._load()
        existing = {a["resource_id"]: a for a in data["actions"]}
        
        added = 0
        updated = 0
        skipped = 0
        
        for action in actions:
            action.source_analysis_id = analysis_id
            
            # 检查是否已存在
            if action.resource_id in existing:
                existing_action = existing[action.resource_id]
                
                # 如果已执行或跳过，跳过更新
                if existing_action["status"] in [ActionStatus.EXECUTED.value, ActionStatus.SKIPPED.value]:
                    skipped += 1
                    continue
                
                # 如果 replace_pending=True，更新现有的 pending 动作
                if replace_pending and existing_action["status"] == ActionStatus.PENDING.value:
                    existing[action.resource_id] = action.to_dict()
                    updated += 1
                else:
                    skipped += 1
            else:
                existing[action.resource_id] = action.to_dict()
                added += 1
        
        data["actions"] = list(existing.values())
        data["stats"]["total_created"] += added
        
        self._save(data)
        
        return {
            "added": added,
            "updated": updated,
            "skipped": skipped,
            "total": len(data["actions"]),
        }
    
    def mark_executed(
        self,
        action_id: str,
        result: dict = None,
    ) -> bool:
        """标记动作为已执行。"""
        data = self._load()
        
        for action in data["actions"]:
            if action["action_id"] == action_id:
                action["status"] = ActionStatus.EXECUTED.value
                action["executed_at"] = datetime.now(timezone.utc).isoformat()
                action["execute_result"] = result or {}
                
                data["stats"]["total_executed"] += 1
                data["stats"]["total_savings_realized"] += action.get("cost_saving", 0)
                
                self._save(data)
                return True
        
        return False
    
    def mark_skipped(
        self,
        action_id: str,
        reason: str = "",
    ) -> bool:
        """标记动作为已跳过。"""
        data = self._load()
        
        for action in data["actions"]:
            if action["action_id"] == action_id:
                action["status"] = ActionStatus.SKIPPED.value
                action["skip_reason"] = reason
                
                data["stats"]["total_skipped"] += 1
                
                self._save(data)
                return True
        
        return False
    
    def mark_failed(
        self,
        action_id: str,
        error: str = "",
    ) -> bool:
        """标记动作为执行失败。"""
        data = self._load()
        
        for action in data["actions"]:
            if action["action_id"] == action_id:
                action["status"] = ActionStatus.FAILED.value
                action["execute_result"] = {"error": error}
                
                self._save(data)
                return True
        
        return False
    
    # -------------------------------------------------------------------------
    # 查询操作
    # -------------------------------------------------------------------------
    
    def list_pending(
        self,
        product: str = "",
        strategy: str = "",
        region_id: str = "",
        min_saving: float = 0,
        limit: int = 100,
    ) -> list[OptimizationAction]:
        """列出待执行的动作。
        
        Args:
            product: 过滤产品类型
            strategy: 过滤策略类型
            region_id: 过滤区域
            min_saving: 最小节省金额
            limit: 返回数量限制
        """
        data = self._load()
        results = []
        
        for action_data in data["actions"]:
            if action_data["status"] != ActionStatus.PENDING.value:
                continue
            
            # 过滤条件
            if product and action_data["product"].upper() != product.upper():
                continue
            if strategy and action_data["strategy"] != strategy:
                continue
            if region_id and action_data["region_id"] != region_id:
                continue
            if action_data.get("cost_saving", 0) < min_saving:
                continue
            
            action = OptimizationAction.from_dict(action_data)
            
            # 检查是否过期
            if not action.is_executable():
                continue
            
            results.append(action)
            
            if len(results) >= limit:
                break
        
        # 按节省金额降序排序
        results.sort(key=lambda x: x.cost_saving, reverse=True)
        
        return results
    
    def get_action(self, action_id: str) -> Optional[OptimizationAction]:
        """获取单条动作。"""
        data = self._load()
        
        for action_data in data["actions"]:
            if action_data["action_id"] == action_id:
                return OptimizationAction.from_dict(action_data)
        
        return None
    
    def get_stats(self) -> dict:
        """获取统计信息。"""
        data = self._load()
        
        # 重新计算统计
        stats = {
            "total": 0,
            "pending": 0,
            "executed": 0,
            "skipped": 0,
            "failed": 0,
            "potential_savings": 0.0,
            "realized_savings": data["stats"].get("total_savings_realized", 0.0),
        }
        
        for action in data["actions"]:
            stats["total"] += 1
            status = action.get("status", "pending")
            
            if status == ActionStatus.PENDING.value:
                stats["pending"] += 1
                stats["potential_savings"] += action.get("cost_saving", 0)
            elif status == ActionStatus.EXECUTED.value:
                stats["executed"] += 1
            elif status == ActionStatus.SKIPPED.value:
                stats["skipped"] += 1
            elif status == ActionStatus.FAILED.value:
                stats["failed"] += 1
        
        return stats
    
    def clear_expired(self) -> int:
        """清理过期动作。"""
        data = self._load()
        now = datetime.now(timezone.utc)
        
        cleared = 0
        for action in data["actions"]:
            if action["status"] != ActionStatus.PENDING.value:
                continue
            
            expires_at = action.get("expires_at")
            if expires_at:
                try:
                    expires = datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
                    if now > expires:
                        action["status"] = ActionStatus.EXPIRED.value
                        cleared += 1
                except ValueError:
                    pass
        
        if cleared > 0:
            self._save(data)
        
        return cleared


# =============================================================================
# 工具函数：从 optimizer 结果提取可执行动作
# =============================================================================


def extract_actions_from_results(
    results: list[dict],
    region_id: str,
    analysis_id: str = "",
    supported_products: set[str] = None,
    expiry_days: int = 7,
) -> list[OptimizationAction]:
    """从 optimizer 的优化结果中提取可执行动作。
    
    Args:
        results: optimizer 输出的优化结果列表（OptimizeResult.to_dict() 格式）
        region_id: 区域 ID
        analysis_id: 分析任务 ID
        supported_products: 支持的产品集合（默认使用 SUPPORTED_PRODUCTS）
        expiry_days: 动作过期天数
    
    Returns:
        可执行的动作列表
    """
    if supported_products is None:
        supported_products = set(SUPPORTED_PRODUCTS.keys())
    
    now = datetime.now(timezone.utc)
    expires_at = (now.replace(hour=0, minute=0, second=0, microsecond=0) + 
                  __import__("datetime").timedelta(days=expiry_days)).isoformat()
    
    actions = []
    
    for result in results:
        # 获取策略
        strategy = result.get("optimizeStrategy") or result.get("strategy")
        if not strategy:
            continue
        
        # 只保留可执行策略
        if strategy not in [s.value for s in EXECUTABLE_STRATEGIES]:
            logger.debug(f"跳过不可执行策略: {strategy}")
            continue
        
        # 获取产品类型
        product = result.get("product", "").upper()
        if product not in supported_products:
            logger.debug(f"跳过不支持的产品: {product}")
            continue
        
        # 提取资源信息
        resource_id = result.get("resourceId") or result.get("resource_id", "")
        resource_name = result.get("resourceName") or result.get("resource_name", "")
        
        if not resource_id:
            continue
        
        # 创建动作
        action = OptimizationAction(
            action_id=f"act_{uuid4().hex[:12]}",
            product=product,
            resource_id=resource_id,
            resource_name=resource_name,
            region_id=result.get("regionId") or result.get("region_id") or region_id,
            strategy=strategy,
            current_spec=result.get("instanceType") or result.get("instance_type", ""),
            target_spec=result.get("optimizedConfig") or result.get("target_type"),
            cost_before=result.get("costBefore") or result.get("cost_before", 0.0),
            cost_after=result.get("costAfter") or result.get("cost_after", 0.0),
            cost_saving=result.get("costSavings") or result.get("cost_saving", 0.0),
            reason=result.get("reason") or _build_reason(result),
            check_id=result.get("checkId") or result.get("check_id", ""),
            status=ActionStatus.PENDING.value,
            created_at=now.isoformat(),
            expires_at=expires_at,
            source_analysis_id=analysis_id,
            source_product=result.get("product", ""),
        )
        
        actions.append(action)
    
    logger.info(f"从 {len(results)} 条优化结果中提取了 {len(actions)} 条可执行动作")
    return actions


def _build_reason(result: dict) -> str:
    """构建原因说明。"""
    extend = result.get("extendResult") or result.get("extend_result", {})
    
    # 尝试从扩展结果中提取监控指标
    parts = []
    
    if "cpu_p95" in extend:
        parts.append(f"CPU P95: {extend['cpu_p95']:.1f}%")
    if "mem_p95" in extend:
        parts.append(f"内存 P95: {extend['mem_p95']:.1f}%")
    if "check_id" in result or "checkId" in result:
        check_id = result.get("checkId") or result.get("check_id", "")
        if check_id:
            parts.append(f"规则: {check_id}")
    
    return ", ".join(parts) if parts else "自动检测发现的优化机会"


# =============================================================================
# 单例实例
# =============================================================================

# 全局单例
_action_store: Optional[ActionStore] = None


def get_action_store() -> ActionStore:
    """获取 ActionStore 单例实例。"""
    global _action_store
    if _action_store is None:
        _action_store = ActionStore()
    return _action_store

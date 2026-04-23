# -*- coding: utf-8 -*-
"""FinOps 定时调度工具 — 将 FinOps 巡检变成持续运营。

管理预定义的 FinOps 巡检模板，通过 CoPaw Cron 基础设施实现定时自动巡检。
支持每日成本摘要、每周全面巡检、每月存储/费率优化、成本异常监控。
"""

import json
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional
from uuid import uuid4
import sys
from pathlib import Path
# 添加 _common 目录到 Python 路径
_common_path = Path(__file__).parent.parent.parent / "_common"
if str(_common_path) not in sys.path:
    sys.path.insert(0, str(_common_path))
from credential import get_credential, get_ak_sk



logger = logging.getLogger(__name__)


# =============================================================================
# 预定义巡检模板
# =============================================================================

FINOPS_JOB_TEMPLATES: dict[str, dict] = {
    # === 核心巡检模板 ===
    "daily_cost_summary": {
        "name": "FinOps 每日成本摘要",
        "description": "每日早9点执行，查询昨日账单总额和产品分布，对比前日标记异常波动",
        "schedule": {"cron": "0 9 * * *", "timezone": "Asia/Shanghai"},
        "query": (
            "请执行每日成本摘要："
            "1. 查询昨日账单总额和产品分布 "
            "2. 与前日对比，标记异常波动 "
            "3. 输出简要摘要（不超过10行）"
        ),
    },
    "weekly_full_audit": {
        "name": "FinOps 每周全面巡检",
        "description": "每周一早10点执行全面巡检，覆盖成本/闲置/存储/标签维度",
        "schedule": {"cron": "0 10 * * 1", "timezone": "Asia/Shanghai"},
        "query": (
            "请执行每周全面 FinOps 巡检，使用当前激活策略："
            "1. 本周成本趋势及环比变化 "
            "2. 闲置资源检测（ECS/RDS/SLB/EIP/NAT/云盘） "
            "3. OSS/NAS 存储冷热分析 "
            "4. 标签覆盖率检查 "
            "5. 输出综合节省建议报告"
        ),
    },
    "monthly_storage_review": {
        "name": "FinOps 每月存储优化",
        "description": "每月1号早10点，全面分析 OSS/NAS/快照/云盘的优化空间",
        "schedule": {"cron": "0 10 1 * *", "timezone": "Asia/Shanghai"},
        "query": (
            "请执行每月存储优化分析："
            "1. OSS 全量 Bucket 清点和冷热分析 "
            "2. OSS 生命周期规则审计 "
            "3. 存储降冷链路建议及预估节省金额 "
            "4. NAS 不活跃文件系统检测 "
            "5. 孤立快照和未挂载云盘清理建议"
        ),
    },
    "monthly_rate_review": {
        "name": "FinOps 每月费率优化",
        "description": "每月2号早10点，分析节省计划/预留实例/付费方式覆盖",
        "schedule": {"cron": "0 10 2 * *", "timezone": "Asia/Shanghai"},
        "query": (
            "请执行每月费率覆盖分析："
            "1. 节省计划利用率和到期预警 "
            "2. 预留实例覆盖率分析 "
            "3. 付费方式分布（按量/包年包月/抢占式） "
            "4. 识别长期按量运行应转包年包月的资源 "
            "5. 费率优化建议"
        ),
    },
    "realtime_anomaly_check": {
        "name": "FinOps 成本异常监控",
        "description": "每4小时检查一次成本异常，仅在发现异常时输出告警",
        "schedule": {"cron": "0 */4 * * *", "timezone": "Asia/Shanghai"},
        "query": (
            "请执行成本异常快速检查："
            "1. 检测过去24小时的成本异常 "
            "2. 如有日环比超过50%的产品，列出详情 "
            "3. 仅在发现异常时输出告警信息"
        ),
    },

    # === 标签域模板 ===
    "tag_compliance_scan": {
        "name": "标签合规巡检",
        "description": "扫描全量资源标签合规性，检测违规命名、缺失必要标签、值不在白名单等问题",
        "schedule": {"cron": "0 10 * * 1", "timezone": "Asia/Shanghai"},
        "query": (
            "请执行标签合规巡检："
            "1) 调用 taga_execute_rules 执行所有启用的标签自动化规则 "
            "2) 调用 tagf_compliance_check 生成合规报告 "
            "3) 汇总违规数量和修复建议"
        ),
    },
    "tag_auto_propagation": {
        "name": "标签自动传播",
        "description": "基于 tag-automation 规则自动推断和传播标签到未标记资源",
        "schedule": {"cron": "0 8 * * *", "timezone": "Asia/Shanghai"},
        "query": (
            "请执行标签自动传播："
            "1) 调用 taga_execute_rules(dry_run=True) 预览传播结果 "
            "2) 对置信度 >= auto_confirm_threshold 的推断自动应用 "
            "3) 其余标记为待审核"
        ),
    },

    # === 成本域模板 ===
    "cost_daily_anomaly": {
        "name": "成本异常监控",
        "description": "每 4 小时检测成本异常波动，仅在发现异常时告警",
        "schedule": {"cron": "0 */4 * * *", "timezone": "Asia/Shanghai"},
        "query": (
            "请执行成本异常检测："
            "1) 调用 costa_execute_check(rule_ids=['anomaly_alert']) "
            "2) 如发现异常，调用 costi_anomaly_root_cause 进行根因分析 "
            "3) 仅在有异常时输出告警报告"
        ),
    },
    "cost_budget_check": {
        "name": "预算阈值检查",
        "description": "每日检查各预算规则的消耗进度，在达到告警百分比时通知",
        "schedule": {"cron": "0 9 * * *", "timezone": "Asia/Shanghai"},
        "query": (
            "请执行预算检查："
            "1) 调用 costa_execute_check(rule_ids=['budget_threshold']) "
            "2) 对比当前消耗与预算阈值 "
            "3) 达到告警线时输出预警报告"
        ),
    },
    "cost_sp_ri_expiry_check": {
        "name": "SP/RI 到期预警",
        "description": "每月检查节省计划和预留实例的到期情况，提前预警续费",
        "schedule": {"cron": "0 10 1 * *", "timezone": "Asia/Shanghai"},
        "query": (
            "请执行 SP/RI 到期检查："
            "1) 调用 costa_execute_check(rule_ids=['sp_ri_expiry']) "
            "2) 列出即将到期的 SP 和 RI "
            "3) 调用 costi_sp_purchase_recommendation 给出续费建议"
        ),
    },

    # === 资源域模板 ===
    "resource_idle_scan": {
        "name": "闲置资源扫描",
        "description": "每周检测闲置 ECS/RDS/SLB/EIP/NAT 资源，输出清理建议",
        "schedule": {"cron": "0 10 * * 1,4", "timezone": "Asia/Shanghai"},
        "query": (
            "请执行闲置资源扫描："
            "1) 调用 resa_execute_scan 执行所有 idle_* 类型规则 "
            "2) 汇总闲置资源清单和预估节省金额 "
            "3) 按优先级排序输出清理建议"
        ),
    },
    "resource_orphan_cleanup_check": {
        "name": "孤儿资源清理检查",
        "description": "每月检测孤儿快照、未挂载云盘等无主资源",
        "schedule": {"cron": "0 10 15 * *", "timezone": "Asia/Shanghai"},
        "query": (
            "请执行孤儿资源检查："
            "1) 调用 resa_execute_scan(rule_ids=['orphan_snapshot','orphan_disk']) "
            "2) 汇总孤儿资源清单和存储成本 "
            "3) 输出安全清理建议"
        ),
    },
    "resource_lifecycle_enforce": {
        "name": "资源生命周期执行",
        "description": "每周日执行资源生命周期策略，如老代实例升级提醒、存储降冷建议",
        "schedule": {"cron": "0 10 * * 0", "timezone": "Asia/Shanghai"},
        "query": (
            "请执行资源生命周期检查："
            "1) 调用 resa_execute_scan(rule_ids=['old_generation','lifecycle_enforce']) "
            "2) 调用 resi_oss_tiering 检查存储降冷机会 "
            "3) 汇总生命周期优化建议"
        ),
    },
}


# =============================================================================
# 任务持久化（本地 JSON 管理，未来可对接 CoPaw Cron API）
# =============================================================================

_SCHEDULER_DIR = Path.home() / ".copaw" / "data"
_SCHEDULER_FILE = _SCHEDULER_DIR / "finops_scheduler.json"


def _load_jobs() -> dict:
    """读取已注册的定时任务列表。"""
    try:
        return json.loads(_SCHEDULER_FILE.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return {"jobs": []}


def _save_jobs(data: dict) -> None:
    """保存定时任务列表。"""
    _SCHEDULER_DIR.mkdir(parents=True, exist_ok=True)
    data["updated_at"] = datetime.now(timezone.utc).isoformat()
    _SCHEDULER_FILE.write_text(
        json.dumps(data, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


# =============================================================================
# 工具函数（5 个 @ops_tool 装饰的异步函数）
# =============================================================================


async def scheduler_list_templates(**kwargs) -> str:
    """列出所有可用的 FinOps 巡检模板。

    返回各模板的名称、描述、默认 cron 调度和查询内容。

    Args:
        **kwargs: 框架注入的参数

    Returns:
        巡检模板列表
    """
    try:
        templates = []
        for tid, tmpl in FINOPS_JOB_TEMPLATES.items():
            templates.append({
                "template_id": tid,
                "name": tmpl["name"],
                "description": tmpl["description"],
                "default_cron": tmpl["schedule"]["cron"],
                "default_timezone": tmpl["schedule"]["timezone"],
                "query_preview": tmpl["query"][:100] + "..." if len(tmpl["query"]) > 100 else tmpl["query"],
            })

        return json.dumps({
            "success": True,
            "template_count": len(templates),
            "templates": templates,
        }, ensure_ascii=False, indent=2)

    except Exception as e:
        return json.dumps({
            "success": False, "error": str(e),
        }, ensure_ascii=False)


async def scheduler_setup_job(
    template_id: str,
    cron_override: str = "",
    timezone_str: str = "Asia/Shanghai",
    channel: str = "console",
    **kwargs,
) -> str:
    """从模板创建 FinOps 定时巡检任务。

    选择一个预定义模板，可选覆盖 cron 表达式和时区。
    创建的任务会注册到 CoPaw Cron 系统。

    Args:
        template_id: 模板 ID（如 daily_cost_summary / weekly_full_audit）
        cron_override: 可选，覆盖默认 cron 表达式
        timezone_str: 时区，默认 Asia/Shanghai
        channel: 结果发送频道（console / dingtalk）
        **kwargs: 框架注入的参数

    Returns:
        创建结果
    """
    template = FINOPS_JOB_TEMPLATES.get(template_id)
    if not template:
        available = list(FINOPS_JOB_TEMPLATES.keys())
        return json.dumps({
            "success": False,
            "error": f"模板不存在: {template_id}",
            "available_templates": available,
        }, ensure_ascii=False)

    cron_expr = cron_override or template["schedule"]["cron"]

    try:
        job_id = f"finops-{template_id}-{uuid4().hex[:8]}"
        job_spec = {
            "id": job_id,
            "name": template["name"],
            "template_id": template_id,
            "enabled": True,
            "schedule": {
                "type": "cron",
                "cron": cron_expr,
                "timezone": timezone_str,
            },
            "task_type": "agent",
            "request": {
                "input": template["query"],
            },
            "dispatch": {
                "type": "channel",
                "channel": channel,
                "mode": "stream",
            },
            "created_at": datetime.now(timezone.utc).isoformat(),
        }

        # 保存到本地（未来可改为调用 CoPaw Cron API）
        data = _load_jobs()
        data["jobs"].append(job_spec)
        _save_jobs(data)

        return json.dumps({
            "success": True,
            "job_id": job_id,
            "name": template["name"],
            "cron": cron_expr,
            "timezone": timezone_str,
            "channel": channel,
            "message": f"已创建定时任务: {template['name']}（{cron_expr}）",
            "note": "任务将在下次触发时间自动执行。策略变更会自动影响巡检阈值。",
        }, ensure_ascii=False, indent=2)

    except Exception as e:
        return json.dumps({
            "success": False, "error": str(e),
        }, ensure_ascii=False)


async def scheduler_list_jobs(**kwargs) -> str:
    """列出已创建的 FinOps 定时任务。

    返回所有已注册的 FinOps 定时任务及其调度信息。

    Args:
        **kwargs: 框架注入的参数

    Returns:
        定时任务列表
    """
    try:
        data = _load_jobs()
        jobs = data.get("jobs", [])

        summary = {
            "total": len(jobs),
            "enabled": len([j for j in jobs if j.get("enabled", True)]),
            "disabled": len([j for j in jobs if not j.get("enabled", True)]),
        }

        # 补充模板信息
        for job in jobs:
            tid = job.get("template_id", "")
            tmpl = FINOPS_JOB_TEMPLATES.get(tid, {})
            job["template_name"] = tmpl.get("name", "自定义")

        return json.dumps({
            "success": True,
            "summary": summary,
            "jobs": jobs,
            "updated_at": data.get("updated_at"),
        }, ensure_ascii=False, indent=2)

    except Exception as e:
        return json.dumps({
            "success": False, "error": str(e),
        }, ensure_ascii=False)


async def scheduler_toggle_job(
    job_id: str,
    enabled: bool = True,
    **kwargs,
) -> str:
    """启用或暂停指定的 FinOps 定时任务。

    Args:
        job_id: 任务 ID
        enabled: True=启用, False=暂停
        **kwargs: 框架注入的参数

    Returns:
        操作结果
    """
    try:
        data = _load_jobs()
        jobs = data.get("jobs", [])

        found = False
        for job in jobs:
            if job.get("id") == job_id:
                job["enabled"] = enabled
                job["toggled_at"] = datetime.now(timezone.utc).isoformat()
                found = True
                break

        if not found:
            return json.dumps({
                "success": False,
                "error": f"任务不存在: {job_id}",
                "available_jobs": [j.get("id") for j in jobs],
            }, ensure_ascii=False)

        _save_jobs(data)

        status = "启用" if enabled else "暂停"
        return json.dumps({
            "success": True,
            "job_id": job_id,
            "enabled": enabled,
            "message": f"任务 {job_id} 已{status}",
        }, ensure_ascii=False, indent=2)

    except Exception as e:
        return json.dumps({
            "success": False, "error": str(e),
        }, ensure_ascii=False)


async def scheduler_remove_job(
    job_id: str,
    **kwargs,
) -> str:
    """删除指定的 FinOps 定时任务。

    Args:
        job_id: 任务 ID
        **kwargs: 框架注入的参数

    Returns:
        删除结果
    """
    try:
        data = _load_jobs()
        jobs = data.get("jobs", [])

        original_count = len(jobs)
        data["jobs"] = [j for j in jobs if j.get("id") != job_id]

        if len(data["jobs"]) == original_count:
            return json.dumps({
                "success": False,
                "error": f"任务不存在: {job_id}",
                "available_jobs": [j.get("id") for j in jobs],
            }, ensure_ascii=False)

        _save_jobs(data)

        return json.dumps({
            "success": True,
            "job_id": job_id,
            "message": f"任务 {job_id} 已删除",
            "remaining_jobs": len(data["jobs"]),
        }, ensure_ascii=False, indent=2)

    except Exception as e:
        return json.dumps({
            "success": False, "error": str(e),
        }, ensure_ascii=False)

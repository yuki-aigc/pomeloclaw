---
name: aliyun-finops-scheduler
description: "FinOps 定时调度工具。管理成本巡检定时任务，支持每日摘要、每周巡检、每月报告、异常告警、标签合规、资源生命周期等预定义模板。基于 CoPaw Cron 基础设施。触发词：定时巡检、成本巡检、定时任务、每日成本"
metadata:
  copaw:
    emoji: "⏰"
    requires: []
  opsclaw:
    emoji: "⏰"
    os: ["darwin", "linux", "win32"]
    requires:
      env:
        - ALIBABA_CLOUD_ACCESS_KEY_ID
        - ALIBABA_CLOUD_ACCESS_KEY_SECRET
      bins: []
      install:
        - pip install copaw
---

# aliyun-finops-scheduler

FinOps 定时调度工具 — 将巡检变成持续运营。

## 能力

- **模板管理**: 列出预定义的 FinOps 巡检模板
- **任务创建**: 从模板一键创建定时巡检任务，支持自定义 cron 表达式
- **任务管理**: 列出/启停/删除已创建的 FinOps 定时任务

## 巡检模板列表

### 核心巡检

| 模板 ID | 名称 | 默认 Cron | 说明 |
|-------------|------|-------------|------|
| `daily_cost_summary` | 每日成本摘要 | `0 9 * * *` | 查询昨日账单总额和产品分布 |
| `weekly_full_audit` | 每周全面巡检 | `0 10 * * 1` | 覆盖成本/闲置/存储/标签维度 |
| `monthly_storage_review` | 每月存储优化 | `0 10 1 * *` | 分析 OSS/NAS/快照/云盘优化空间 |
| `monthly_rate_review` | 每月费率优化 | `0 10 2 * *` | 分析 SP/RI/付费方式覆盖 |
| `realtime_anomaly_check` | 成本异常监控 | `0 */4 * * *` | 每4小时检查成本异常 |

### 标签域

| 模板 ID | 名称 | 默认 Cron | 说明 |
|-------------|------|-------------|------|
| `tag_compliance_scan` | 标签合规巡检 | `0 10 * * 1` | 扫描资源标签合规性，检测违规问题 |
| `tag_auto_propagation` | 标签自动传播 | `0 8 * * *` | 基于规则自动推断和传播标签 |

### 成本域

| 模板 ID | 名称 | 默认 Cron | 说明 |
|-------------|------|-------------|------|
| `cost_daily_anomaly` | 成本异常监控 | `0 */4 * * *` | 每 4 小时检测成本异常波动 |
| `cost_budget_check` | 预算阈值检查 | `0 9 * * *` | 每日检查预算消耗进度 |
| `cost_sp_ri_expiry_check` | SP/RI 到期预警 | `0 10 1 * *` | 每月检查 SP/RI 到期情况 |

### 资源域

| 模板 ID | 名称 | 默认 Cron | 说明 |
|-------------|------|-------------|------|
| `resource_idle_scan` | 闲置资源扫描 | `0 10 * * 1,4` | 每周检测闲置 ECS/RDS/SLB/EIP/NAT |
| `resource_orphan_cleanup_check` | 孤儿资源清理检查 | `0 10 15 * *` | 每月检测孤儿快照、未挂载云盘 |
| `resource_lifecycle_enforce` | 资源生命周期执行 | `0 10 * * 0` | 每周日执行生命周期策略 |

## 策略联动

定时任务引用“当前激活策略”，只需修改策略即可全局更新所有巡检的检测阈值。

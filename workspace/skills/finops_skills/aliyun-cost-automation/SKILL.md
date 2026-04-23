---
name: aliyun-cost-automation
description: "成本自动化规则引擎 — 基于确定性规则自动检测成本异常和预算超标。触发词：预算告警、成本异常检测、费用监控规则"
metadata:
  copaw:
    emoji: "⚙️"
    requires:
      - alibabacloud-bssopenapi20171214
      - alibabacloud-tea-openapi
  opsclaw:
    emoji: "⚙️"
    os: ["darwin", "linux", "win32"]
    requires:
      env:
        - ALIBABA_CLOUD_ACCESS_KEY_ID
        - ALIBABA_CLOUD_ACCESS_KEY_SECRET
      bins: []
      install:
        - pip install copaw
        - pip install alibabacloud-bssopenapi20171214
        - pip install alibabacloud-tea-openapi
---
# Aliyun Cost Automation - 成本自动化规则引擎

基于确定性规则自动检测成本异常和预算超标。支持异常告警、预算阈值、SP/RI 到期预警、每日摘要等规则类型。

## 功能列表

### 规则管理

| 操作 | 工具函数 | 风险等级 | 说明 |
|------|---------|---------|------|
| 列出规则 | `costa_list_rules` | LOW | 列出所有自动化规则 |
| 创建规则 | `costa_create_rule` | MEDIUM | 创建成本自动化规则 |
| 更新规则 | `costa_update_rule` | MEDIUM | 更新已有规则 |
| 删除规则 | `costa_delete_rule` | MEDIUM | 删除指定规则 |

### 规则执行

| 操作 | 工具函数 | 风险等级 | 说明 |
|------|---------|---------|------|
| 执行检查 | `costa_execute_check` | LOW | 执行指定规则检查 |
| 执行历史 | `costa_execution_history` | LOW | 查看规则执行历史 |

## 规则类型

### anomaly_alert - 异常告警
基于历史数据的统计异常检测
```json
{
  "sigma_threshold": 2.5,
  "lookback_days": 30
}
```

### budget_threshold - 预算阈值
预算超标预警
```json
{
  "budget_cny": 50000,
  "alert_percents": [70, 85, 95]
}
```

### sp_ri_expiry - SP/RI 到期预警
节省计划/预留实例到期提醒
```json
{
  "alert_days_before": [30, 7, 3]
}
```

### daily_summary - 每日摘要
每日成本摘要报告
```json
{
  "include_products": [],
  "top_n": 5
}
```

## 数据存储

规则数据持久化至: `~/.copaw/data/cost_automation_rules.json`

## 使用前提

1. 已通过 `copaw ops credential add` 配置 AKSK 凭证
2. 凭证具有 BSS OpenAPI RAM 权限 (`AliyunBSSReadOnlyAccess`)

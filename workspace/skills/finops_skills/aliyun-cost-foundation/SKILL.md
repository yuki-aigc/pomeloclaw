---
name: aliyun-cost-foundation
description: "成本数据基座 — 账单查询、趋势分析、价格查询与成本分摊。触发词：查账单、费用趋势、成本分摊、按标签看费用、月度账单"
metadata:
  copaw:
    emoji: "📊"
    requires:
      - alibabacloud-bssopenapi20171214
      - alibabacloud-tea-openapi
  opsclaw:
    emoji: "📊"
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
# Aliyun Cost Foundation - 成本数据基座

提供账单查询、趋势分析、价格查询与成本分摊能力。全部 READ 操作，风险等级 LOW。

## 功能列表

### 账单查询

| 操作 | 工具函数 | 风险等级 | 说明 |
|------|---------|---------|------|
| 账户账单 | `costf_account_bill` | LOW | 指定月份账户级账单总览 |
| 实例账单 | `costf_instance_bill` | LOW | 实例级账单明细 |
| 费用汇总 | `costf_bill_overview` | LOW | 按产品分组月度费用 |

### 趋势分析

| 操作 | 工具函数 | 风险等级 | 说明 |
|------|---------|---------|------|
| 月度趋势 | `costf_monthly_trend` | LOW | 最近 N 月趋势+环比 |
| 日级趋势 | `costf_daily_trend` | LOW | 指定月份日级成本曲线 |
| 时段对比 | `costf_compare_periods` | LOW | 两时段成本对比 |

### 分摊分析

| 操作 | 工具函数 | 风险等级 | 说明 |
|------|---------|---------|------|
| 按标签分摊 | `costf_by_tag` | LOW | 按 Tag 分组成本 |
| 按资源组分摊 | `costf_by_resource_group` | LOW | 按资源组分组成本 |
| 产品 Top N | `costf_product_breakdown` | LOW | 产品维度 Top N 及占比 |
| 区域分布 | `costf_region_breakdown` | LOW | 区域维度成本分布 |
| 分摊报告 | `costf_chargeback_report` | LOW | 多维度成本分摊报告 |
| 分摊趋势 | `costf_chargeback_trend` | LOW | 各维度值的月度趋势 |

### 价格查询

| 操作 | 工具函数 | 风险等级 | 说明 |
|------|---------|---------|------|
| 按量价格 | `costf_get_payg_price` | LOW | 查询按量付费价格 |
| 包年包月价格 | `costf_get_subscription_price` | LOW | 查询包年包月价格 |

### 费率覆盖分析

| 操作 | 工具函数 | 风险等级 | 说明 |
|------|---------|---------|------|
| 节省计划分析 | `costf_savings_plan_analysis` | LOW | SP 利用率、覆盖率、到期预警 |
| RI 覆盖分析 | `costf_ri_coverage_analysis` | LOW | 预留实例覆盖率分析 |
| 付费方式分布 | `costf_charge_type_distribution` | LOW | 按量/包年包月/抢占式占比 |

## 技术要点

- BSS OpenAPI endpoint: `business.aliyuncs.com` (全局服务，无需指定 region)
- 账单数据有 T+1 延迟
- 分页保护: page_size=100，最大 50 页

## 使用前提

1. 已通过 `copaw ops credential add` 配置 AKSK 凭证
2. 凭证具有 BSS OpenAPI RAM 权限 (`AliyunBSSReadOnlyAccess`)

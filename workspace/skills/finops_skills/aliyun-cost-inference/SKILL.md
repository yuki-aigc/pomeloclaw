---
name: aliyun-cost-inference
description: "成本智能推断引擎 — 异常根因分析、价格估算、购买推荐与费用分摊。触发词：费用为什么涨了、该不该买SP、预留实例推荐、费用预测"
metadata:
  copaw:
    emoji: "🧠"
    requires:
      - alibabacloud-bssopenapi20171214
      - alibabacloud-ecs20140526
      - alibabacloud-tea-openapi
  opsclaw:
    emoji: "🧠"
    os: ["darwin", "linux", "win32"]
    requires:
      env:
        - ALIBABA_CLOUD_ACCESS_KEY_ID
        - ALIBABA_CLOUD_ACCESS_KEY_SECRET
      bins: []
      install:
        - pip install copaw
        - pip install alibabacloud-bssopenapi20171214
        - pip install alibabacloud-ecs20140526
        - pip install alibabacloud-tea-openapi
---
# Aliyun Cost Inference - 成本智能推断引擎

提供基于分析推断的智能成本优化能力：异常根因分析、价格估算、购买推荐与费用分摊。

## 功能列表

### 异常分析

| 操作 | 工具函数 | 风险等级 | 说明 |
|------|---------|---------|------|
| 异常检测 | `costi_anomaly_detection` | LOW | 成本异常检测（支持 sigma 阈值） |
| 根因分析 | `costi_anomaly_root_cause` | LOW | 异常日成本根因下钻 |

### 预测与估算

| 操作 | 工具函数 | 风险等级 | 说明 |
|------|---------|---------|------|
| 费用预测 | `costi_forecast` | LOW | 预测未来费用（线性/季节性） |
| 价格估算 | `costi_estimate_resource_price` | LOW | 高层级资源价格估算 |

### 购买推荐

| 操作 | 工具函数 | 风险等级 | 说明 |
|------|---------|---------|------|
| SP 推荐 | `costi_sp_purchase_recommendation` | LOW | 节省计划购买推荐 |
| RI 推荐 | `costi_ri_purchase_recommendation` | LOW | 预留实例购买推荐 |
| 付费优化 | `costi_charge_type_optimization` | LOW | 付费方式优化建议 |

### 费用分摊

| 操作 | 工具函数 | 风险等级 | 说明 |
|------|---------|---------|------|
| 共享分摊 | `costi_shared_cost_allocation` | LOW | 共享资源费用分摊 |

## 技术要点

- 异常检测使用均值+标准差方法
- 费用预测支持线性回归和季节性调整
- 价格估算支持 API 查询和静态单价表回退
- 共享资源分摊支持自动检测和规则配置

## 使用前提

1. 已通过 `copaw ops credential add` 配置 AKSK 凭证
2. 凭证具有 BSS OpenAPI RAM 权限 (`AliyunBSSReadOnlyAccess`)
3. 凭证具有 ECS 查询权限 (`AliyunECSReadOnlyAccess`)

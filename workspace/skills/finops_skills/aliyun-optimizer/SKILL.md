---
name: aliyun-optimizer
description: "阿里云资源优化工具。多产品成本优化分析（ECS/RDS/EBS/EIP/SLB/CDN），查询 CPU/内存/连接数水位，提供升降配建议。直接调用即可，无需创建脚本。触发词：资源优化、闲置检测、降配建议、ECS优化、RDS优化、利用率分析"
metadata:
  copaw:
    emoji: "🛠️"
    requires:
      - alibabacloud-ecs20140526
      - alibabacloud-rds20140815
      - alibabacloud-slb20140515
      - alibabacloud-cms20190101
      - alibabacloud-tea-openapi
      - alibabacloud-r-kvstore20150101
      - alibabacloud-vpc20160428
      - alibabacloud-dds20151201
      - alibabacloud-bssopenapi20171214
      - alibabacloud-cdn20180510
      - alibabacloud-nas20170626
      - alibabacloud-sls20201230
      - alibabacloud-polardbx20200202
      - alibabacloud-mse20190531
      - alibabacloud-elasticsearch20170613
      - alibabacloud-rocketmq20220801
      - alibabacloud-hologram20220601
  opsclaw:
    emoji: "🛠️"
    os: ["darwin", "linux", "win32"]
    requires:
      env:
        - ALIBABA_CLOUD_ACCESS_KEY_ID
        - ALIBABA_CLOUD_ACCESS_KEY_SECRET
      bins: []
      install:
        - pip install copaw
        - pip install alibabacloud-ecs20140526
        - pip install alibabacloud-rds20140815
        - pip install alibabacloud-slb20140515
        - pip install alibabacloud-cms20190101
        - pip install alibabacloud-tea-openapi
        - pip install alibabacloud-r-kvstore20150101
        - pip install alibabacloud-vpc20160428
        - pip install alibabacloud-dds20151201
        - pip install alibabacloud-bssopenapi20171214
        - pip install alibabacloud-cdn20180510
        - pip install alibabacloud-nas20170626
        - pip install alibabacloud-sls20201230
        - pip install alibabacloud-polardbx20200202
        - pip install alibabacloud-mse20190531
        - pip install alibabacloud-elasticsearch20170613
        - pip install alibabacloud-rocketmq20220801
        - pip install alibabacloud-hologram20220601
---

# aliyun-optimizer

阿里云资源优化工具 — 多产品成本优化分析 + 云资源水位查询 + 升降配建议。

## 重要提示

❗ **请直接调用以下工具，无需创建脚本**：

| 用户意图 | 应调用的工具 |
|----------|---------------|
| **按标签成本优化分析（推荐）** | `opt_cost_by_tag` ⭐ 新 |
| **多产品成本优化分析** | `opt_cost_optimization` |
| **CDN 成本优化分析** | `opt_cdn_cost_optimization` ⭐ 新 |
| **Redis 成本优化分析** | `opt_redis_cost_optimization` ⭐ 新 |
| **NAT 闲置检测** | `opt_nat_idle_check` ⭐ 新 |
| **NAS 成本优化分析** | `opt_nas_cost_optimization` ⭐ 新 |
| **SLS 成本优化分析** | `opt_sls_cost_optimization` ⭐ 新 |
| **PolarDB-X 成本优化** | `opt_drds_cost_optimization` ⭐ 新 |
| **MSE注册中心成本优化** | `opt_mse_cost_optimization` ⭐ 新 |
| **Elasticsearch成本优化** | `opt_elasticsearch_cost_optimization` ⭐ 新 |
| **RocketMQ成本优化** | `opt_rocketmq_cost_optimization` ⭐ 新 |
| **ARMS资源包推荐** | `opt_arms_cost_optimization` ⭐ 新 |
| **MaxCompute CU资源包推荐** | `opt_maxcompute_cost_optimization` ⭐ 新 |
| **WAF SeCU资源包推荐** | `opt_waf_cost_optimization` ⭐ 新 |
| **Redis资源包推荐** | `opt_redis_package_recommendation` ⭐ 新 |
| **ECS 成本优化分析** | `opt_ecs_cost_optimization` |
| **分析所有资源水位+升降配建议** | `opt_all_resources_analysis` |
| 查询 ECS 水位/利用率 | `opt_ecs_utilization_report` |
| 查询 RDS 水位/利用率 | `opt_rds_utilization_report` |
| 查询 Redis 水位 | `opt_redis_utilization_report` |
| 查询 EIP 带宽使用率 | `opt_eip_utilization_report` |
| 查询 CLB 水位 | `opt_clb_utilization_report` |
| 查询 MongoDB 水位 | `opt_mongodb_utilization_report` |
| **查询 CDN 利用率** | `opt_cdn_utilization_report` ⭐ 新 |
| **查询 CDN 域名配置** | `opt_cdn_config_check` ⭐ 新 |
| ECS 升降配建议 | `opt_ecs_spec_recommend` |
| RDS 升降配建议 | `opt_rds_spec_recommend` |
| 云监控通用查询 | `opt_cloudmonitor_query` |

## 按标签成本优化分析

### 🌟 `opt_cost_by_tag` - 按标签查询资源并进行成本优化分析

一站式工具，支持：
1. 按指定标签查询资源（如 `TAM-Group-Name:Default`）
2. 对这些资源进行成本优化分析
3. 返回统一格式的 Markdown 报告

**支持的产品**：ECS / SLB

**使用示例**：
```
opt_cost_by_tag(tag_key="TAM-Group-Name", tag_value="Default", region_id="cn-hangzhou", products="ecs,slb")
```

## 通用成本优化框架

### 🌟 `opt_cost_optimization` - 多产品成本优化分析

**支持的产品**：ECS / RDS / EBS(云盘) / EIP / SLB

**责任链模式**：每个资源依次经过 3 个检测规则，命中即跳过后续：

| 优先级 | 规则 ID | 策略 | 判定逻辑 |
|:---:|---|---|---|
| 1 | IdleResourceCheck | Release (释放) | 所有监控指标 Maximum < 1% 或资源未绑定 |
| 2 | LowUtilizationCheck | DownScaling (降配) | P95 利用率 < 20% |
| 3 | PostPaidLongTermCheck | ConvertToPrePaid (转包月) | 按量持有 > 30 天 |

**后处理流水线**（通用）：
1. 推荐优化规格
2. 价格查询（见下方详细说明）
3. 无效数据剔除

### 价格查询链路（极其重要）

❗ **必须严格遵循以下优先级，禁止跳过前级直接估算**：

#### costBefore（当前费用）

| 优先级 | 数据源 | 说明 |
|:---:|---|---|
| 1 | **账单查询** | 调用 `DescribeInstanceBill` 获取真实历史费用，最准确 |
| 2 | BSS 询价 | 账单无数据时，调用 `GetPayAsYouGoPrice` 查询当前规格价格 |
| 3 | OpenAPI 询价 | BSS 失败时，调用产品 `DescribePrice` API |
| 4 | 估算 | 仅当上述全部失败时，必须标注 `estimate` 并说明原因 |

#### costAfter（目标费用）

| 优先级 | 数据源 | 说明 |
|:---:|---|---|
| 1 | **BSS 询价** | 调用 `GetPayAsYouGoPrice` 查询目标规格价格 |
| 2 | OpenAPI 询价 | BSS 失败时，调用产品 `DescribePrice` API |
| 3 | 估算 | 仅当上述全部失败时，必须标注 `estimate` 并说明原因 |

> 注意：costAfter 不查账单，因为目标规格还没有实例，无账单数据。

#### 各产品 BSS/OpenAPI 支持情况

| 产品 | BSS 询价 | OpenAPI 询价 | 备注 |
|---|:---:|:---:|---|
| ECS | ✅ | ✅ `ecs.DescribePrice` | - |
| RDS | ✅ | ✅ `rds.DescribePrice` | BSS 需拆分 Engine/EngineVersion 等独立 Module |
| SLB | ✅ | ❌ | - |
| EBS | ✅ | ✅ `ecs.DescribePrice` | BSS 失败时 fallback 到 ECS OpenAPI |
| EIP | ❌ 按量不支持 | ❌ | 只能查账单或估算，说明见下方 |

#### EIP 价格查询特殊说明

阿里云 EIP 按量付费不支持 BSS 询价（返回 MissingParameter），因此：
- **优先查账单** 获取真实费用
- 账单无数据时，根据计费方式估算：
  - 按流量计费：无法估算，请以账单为准
  - 按固定带宽计费：1-5Mbps=28.8元/月/Mbps，>5Mbps=100.8元/月/Mbps
- 必须标注 `estimate(按带宽)` 并说明计费方式不确定

#### 价格来源标注规范

报告中必须标注价格来源：
- `bill` = 真实账单数据（最准确）
- `bss` = BSS 官方询价 API
- `openapi` = 产品 OpenAPI 询价
- `estimate` = 估算值（必须说明原因）

**使用示例**：
```
opt_cost_optimization(region_id="cn-hangzhou", products="ecs,rds,disk")
```

### 产品配置清单

| 产品 | ProductCode | 闲置判定方式 | 规则链 |
|---|---|---|---|
| 云服务器 ECS | ecs | 监控指标 (CPU/内存) | 闲置 → 低利用率 → 按量转包月 |
| 云数据库 RDS | rds | 监控指标 (CPU/内存) | 闲置 → 低利用率 → 按量转包月 |
| 云盘 EBS | disk | 状态 (是否挂载) | 闲置 → 按量转包月 |
| 弹性公网 IP | eip | 状态 (是否绑定) | 仅闲置检测 |
| 负载均衡 SLB | slb | 状态 (后端是否为空) | 闲置 → 低利用率 |

## CDN 成本优化

### 🌟 `opt_cdn_cost_optimization` - CDN 成本优化分析

一站式 CDN 成本优化工具，检测 5 项优化规则：

| 检测项 | 规则 | 严重程度 | 预期效果 |
|--------|------|---------|----------|
| 计费方式 | 带宽利用率 < 30% 推荐流量计费 | 中 | 视用量而定 |
| Range 回源 | 大文件/视频/OSS 场景必开 | 高 | 减少 30%-50% 回源流量 |
| 智能压缩 | 网页场景应开启 Gzip/Brotli | 中 | 减少 50%-70% 传输流量 |
| 缓存规则 | 必须配置缓存规则 | 高 | 减少 80%+ 回源流量 |
| 共享缓存 | 同源站多域名建议共享 | 中 | 提升缓存命中率 |

**使用示例**：
```
opt_cdn_cost_optimization()
opt_cdn_cost_optimization(domain_filter="example.com")
```

### `opt_cdn_utilization_report` - CDN 利用率报告

查询域名带宽使用情况，计算利用率，给出计费方式建议。

**计费建议规则**：
- 带宽利用率 = 平均带宽 / 峰值带宽 × 100%
- 利用率 < 30%: 推荐按流量计费
- 利用率 ≥ 30%: 推荐按带宽峰值计费

**使用示例**：
```
opt_cdn_utilization_report(days=7)
opt_cdn_utilization_report(domain_filter="alivetest", days=14)
```

### `opt_cdn_config_check` - CDN 配置检测

查询单个域名的配置状态（Range/压缩/缓存）。

**使用示例**：
```
opt_cdn_config_check(domain_name="example.alivetest.asia")
```

## 其他能力

### P0：闲置检测
- **闲置 ECS 检测**: 基于 CPU 利用率 + 持续天数，按 env 标签过滤目标环境
- **闲置 RDS 检测**: 基于连接数和 CPU 利用率
- **闲置 SLB 检测**: 基于流量和连接数
- **闲置 NAT 检测**: 无绑定EIP/无DNAT/无SNAT
- **智能顾问建议**: 查询阿里云 Advisor 推荐

### P0：存储成本优化
- **NAS 生命周期管理**: 检测通用型 NAS 是否开启生命周期管理（降低 92% 存储成本）
- **SLS 智能存储分层**: 检测未开启智能分层的 Logstore（降低 70% 存储成本）

### P1：利用率分析与 Rightsizing
- ECS 利用率报告、规格调整建议、老代实例检测
- **ECS 具体规格推荐**: 实时查询可用规格 + 库存 + 价格，给出升降配建议
- **RDS 具体规格推荐**: 实时查询可用规格，给出降配建议
- RDS 利用率报告
- **Redis 利用率报告**: CPU/内存/连接数/QPS 水位
- **EIP 利用率报告**: 带宽使用率/闲置检测
- **CLB 利用率报告**: 连接数/流量/QPS 水位
- **MongoDB 利用率报告**: CPU/内存/磁盘/连接数水位
- 可定时关停资源检测

### P2：综合节省报告
- 汇总所有检测结果，生成优先级排序的 action items

### 通用云监控查询
- **任意产品水位查询**: 支持 ECS/RDS/Redis/SLB/NAS 等产品的任意指标
- **自定义时间范围**: 支持 1~30 天历史数据查询
- **聚合统计输出**: 返回 avg、max、min、p95、p99

## 策略感知

所有检测函数支持 `strategy` 参数。自动化级别：
- `report_only`: 仅输出报告
- `recommend`: 报告 + 建议操作
- `auto_with_approval`: 报告 + 建议 Agent 调用操作函数（经 OpsClaw 审批流）

## 存储产品成本优化

### `opt_nas_cost_optimization` - NAS 成本优化

检测通用型 NAS 是否开启生命周期管理。

| 检测项 | 规则 | 预期效果 |
|--------|------|----------|
| 生命周期管理 | 通用型 NAS 应开启生命周期管理 | 低频存储成本降低 92% |

**使用示例**：
```
opt_nas_cost_optimization(region_id="cn-hangzhou")
```

### `opt_sls_cost_optimization` - SLS 成本优化

检测 SLS Logstore 是否开启智能存储分层。

| 检测项 | 规则 | 预期效果 |
|--------|------|----------|
| 智能存储分层 | 保留期 > 7 天应开启智能分层 | 冷存储成本降低 70% |

**使用示例**：
```
opt_sls_cost_optimization(region_id="cn-hangzhou")
```

## 中间件成本优化

### `opt_drds_cost_optimization` - PolarDB-X 成本优化

检测 PolarDB-X 分布式版实例的闲置/低利用率/计费方式。

| 检测项 | 规则 | 严重程度 |
|--------|------|----------|
| 闲置检测 | CPU峰值≤1% 且 均值≤1%, 内存峰值≤30% 且 均值≤15%, 连接数峰值≤50 且 均值≤25, QPS峰值≤50 且 均值≤25 | 高 |
| 低利用率 | 所有指标峰值≤30% 且 均值≤15% | 中 |
| 计费优化 | 按量付费超过 30 天 | 中 |

**使用示例**：
```
opt_drds_cost_optimization(region_id="cn-hangzhou")
```

### `opt_mse_cost_optimization` - MSE 注册中心成本优化

检测 MSE 注册中心实例的闲置/低利用率/计费方式。

| 检测项 | 规则 | 严重程度 |
|--------|------|----------|
| Eureka/Nacos 闲置 | 健康实例数为 0（超过 7 天） | 高 |
| Zookeeper 闲置 | TPS 为 0（超过 7 天） | 高 |
| 计费优化 | 按量付费超过 30 天 | 中 |

**使用示例**：
```
opt_mse_cost_optimization(region_id="cn-hangzhou")
```

### `opt_elasticsearch_cost_optimization` - Elasticsearch 成本优化

检测 Elasticsearch 实例的低利用率和计费方式。

| 检测项 | 规则 | 严重程度 |
|--------|------|----------|
| 低利用率 | CPU峰值<30% 且 HeapMemory峰值<30% | 中 |
| 计费优化 | 按量付费超过 30 天 | 中 |

**使用示例**：
```
opt_elasticsearch_cost_optimization(region_id="cn-hangzhou")
```

### `opt_rocketmq_cost_optimization` - RocketMQ 成本优化

检测 RocketMQ Serverless 实例的闲置 Topic。

| 检测项 | 规则 | 严重程度 |
|--------|------|----------|
| Topic 闲置 | 过去 7 天无监控数据 | 高 |

**使用示例**：
```
opt_rocketmq_cost_optimization(region_id="cn-hangzhou")
```

## 资源包推荐

通过账单查询按量消费，分析用量并推荐合适的资源包规格。

### `opt_arms_cost_optimization` - ARMS 资源包推荐

分析 ARMS 调用量和 Span 存储用量，推荐资源包。

| 资源包类型 | 规格范围 | 节省效果 |
|----------|----------|----------|
| 调用量资源包 | 1000万次 ~ 10亿次/月 | 按量 vs 资源包对比节省 |
| Span存储资源包 | 100GB ~ 10TB | 按量 vs 资源包对比节省 |

**使用示例**：
```
opt_arms_cost_optimization(region_id="cn-hangzhou", days=30)
```

### `opt_maxcompute_cost_optimization` - MaxCompute CU资源包推荐

分析 MaxCompute CU 和存储用量，推荐资源包。

| 资源包类型 | 规格范围 | 节省效果 |
|----------|----------|----------|
| CU资源包 | 100 ~ 50000 CU*小时/月 | 按量 vs 资源包对比节省 |
| 存储资源包 | 100GB ~ 10TB | 按量 vs 资源包对比节省 |

**使用示例**：
```
opt_maxcompute_cost_optimization(region_id="cn-hangzhou", days=30)
```

### `opt_waf_cost_optimization` - WAF SeCU资源包推荐

分析 WAF SeCU 用量，推荐 SeCU 资源包。

| 资源包类型 | 规格范围 | 节省效果 |
|----------|----------|----------|
| SeCU资源包 | 100 ~ 50000 SeCU/月 | 按量 vs 资源包对比节省 |

**使用示例**：
```
opt_waf_cost_optimization(region_id="cn-hangzhou", days=30)
```

### `opt_redis_package_recommendation` - Redis 存储资源包推荐

分析 Redis 存储用量，推荐存储资源包。

| 资源包类型 | 规格范围 | 节省效果 |
|----------|----------|----------|
| 存储资源包 | 100 ~ 10000 GB*小时/月 | 按量 vs 资源包对比节省 |

**使用示例**：
```
opt_redis_package_recommendation(region_id="cn-hangzhou", days=30)
```

## 框架架构

```
aliyun-optimizer/
├── SKILL.md                 # 技能说明文件
├── scripts/                 # 脚本目录
│   ├── tools.py             # 对外工具函数
│   ├── core/                # 通用框架层
│   │   ├── base.py          # 枚举、数据结构
│   │   ├── rules.py         # 3条通用检测规则
│   │   ├── pipeline.py      # 后处理流水线
│   │   └── bss.py           # BSS 询价/账单
│   └── products/            # 产品配置层
│       ├── ecs.py
│       ├── rds.py
│       ├── ebs.py
│       ├── eip.py
│       ├── slb.py
│       ├── cdn.py           # CDN 成本优化
│       ├── redis.py         # Redis 成本优化 + 资源包推荐
│       ├── nat.py           # NAT 闲置检测
│       ├── nas.py           # NAS 生命周期管理
│       ├── sls.py           # SLS 智能存储分层
│       ├── drds.py          # PolarDB-X 成本优化
│       ├── mse.py           # MSE 注册中心成本优化
│       ├── elasticsearch.py # Elasticsearch 成本优化
│       ├── rocketmq.py      # RocketMQ 成本优化
│       ├── arms.py          # ARMS 资源包推荐
│       ├── maxcompute.py    # MaxCompute 资源包推荐
│       └── waf.py           # WAF 资源包推荐
└── references/              # 参考文档目录
    └── .gitkeep
```

---
name: aliyun-tag-foundation
description: "标签治理数据基座 — 资源发现、覆盖率分析、合规检查与批量打标。触发词：标签覆盖率、资源盘点、批量打标、标签合规"
metadata:
  copaw:
    emoji: "🏷️"
    requires:
      - alibabacloud-resourcecenter20221201
      - alibabacloud-tag20180828
      - alibabacloud-tea-openapi
  opsclaw:
    emoji: "🏷️"
    os: ["darwin", "linux", "win32"]
    requires:
      env:
        - ALIBABA_CLOUD_ACCESS_KEY_ID
        - ALIBABA_CLOUD_ACCESS_KEY_SECRET
      bins: []
      install:
        - pip install copaw
        - pip install alibabacloud-resourcecenter20221201
        - pip install alibabacloud-tag20180828
        - pip install alibabacloud-tea-openapi
---

# aliyun-tag-foundation — 标签治理数据基座

标签治理的**数据基座**技能，提供资源发现、标签规则管理、覆盖率分析、合规检查和批量打标等核心能力。基于资源中心（Resource Center）和统一标签 API，2 个全局 SDK 覆盖 200+ 资源类型。

## 核心能力

1. **标签规则管理** — 加载/保存标签治理规则（必选 Key、值白名单、命名规范）
2. **资源发现** — 跨产品跨区域盘点云资源，支持聚合统计模式
3. **标签能力发现** — 查询各资源类型支持的标签能力项
4. **覆盖率报告** — 按产品/按 Key 分析必选标签的覆盖情况
5. **差距分析** — 交叉比对资源与标签能力，输出治理优先级
6. **合规检查** — 综合检查覆盖率和值一致性
7. **批量打标** — 使用统一 Tag API 为资源添加标签

## 功能列表

| 操作 | 工具函数 | 风险等级 | 说明 |
|------|---------|---------|------|
| 加载标签规则 | `tagf_load_rules` | LOW | 查看当前生效的标签治理规则 |
| 保存标签规则 | `tagf_save_rules` | MEDIUM | 将用户确认的规则持久化到本地 |
| 资源发现 | `tagf_discover_resources` | LOW | 跨产品跨区域盘点，支持聚合统计模式 |
| 标签能力发现 | `tagf_discover_capabilities` | LOW | 查询各资源类型的标签能力项 |
| 覆盖率报告 | `tagf_coverage_report` | LOW | 按产品/按 Key 分析覆盖率 |
| 差距分析 | `tagf_gap_analysis` | LOW | 交叉比对资源与标签能力，输出治理计划 |
| 合规检查 | `tagf_compliance_check` | LOW | 综合检查覆盖率和值一致性 |
| 批量打标 | `tagf_batch_tag` | MEDIUM | 统一 Tag API 批量打标，支持 dry_run |

## 使用前提

- 阿里云账号已开通**资源中心**服务
- RAM 权限需包含：
  - `resourcecenter:SearchResources`（资源发现）
  - `resourcecenter:GetResourceCounts`（聚合统计）
  - `tag:ListSupportResourceTypes`（标签能力查询）
  - `tag:TagResources`（打标操作）

## 典型使用流程

### 1. 制定标签规则

```
→ tagf_load_rules()
  查看当前规则

→ tagf_save_rules(
    required_keys=["env", "team", "owner"],
    key_whitelist={"env": ["dev", "test", "staging", "prod"]}
  )
  保存确认后的规则
```

### 2. 存量资源盘点

```
→ tagf_discover_resources(aggregate_mode=True)
  服务端聚合统计（适合大规模资源）

→ tagf_discover_resources(
    resource_types=["ACS::ECS::Instance"],
    regions=["cn-hangzhou"]
  )
  获取资源明细
```

### 3. 覆盖率分析与合规检查

```
→ tagf_coverage_report()
  按产品/按 Key 分析覆盖率

→ tagf_compliance_check(required_keys=["env", "team"])
  综合检查覆盖率和值一致性
```

### 4. 差距分析与批量治理

```
→ tagf_gap_analysis()
  输出可治理/不可治理分类和优先级

→ tagf_batch_tag(resources=[...], tags={"env":"prod"}, dry_run=True)
  预览打标计划

→ tagf_batch_tag(resources=[...], tags={"env":"prod"}, dry_run=False)
  执行打标
```

## 规则配置文件

路径：`~/.copaw/data/tag_pipeline_rules.json`

```json
{
  "required_keys": ["env", "team", "owner"],
  "key_whitelist": {
    "env": ["dev", "test", "staging", "prod"]
  },
  "key_naming_pattern": "^[a-z][a-z0-9_-]*$",
  "description": "标签治理规则"
}
```

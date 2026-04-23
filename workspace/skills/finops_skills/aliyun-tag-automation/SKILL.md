---
name: aliyun-tag-automation
description: "标签自动化规则引擎 — 基于确定性规则自动推断和传播标签。触发词：标签自动化、自动打标、规则打标、标签传播"
metadata:
  copaw:
    emoji: "⚙️"
    requires:
      - alibabacloud-resourcecenter20221201
      - alibabacloud-tag20180828
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
        - pip install alibabacloud-resourcecenter20221201
        - pip install alibabacloud-tag20180828
        - pip install alibabacloud-tea-openapi
---

# aliyun-tag-automation — 标签自动化规则引擎

标签**自动化规则引擎**技能，支持基于确定性规则自动推断和传播标签。通过预定义规则类型，实现标签的自动化治理。

## 核心能力

1. **规则管理** — 创建、更新、删除自动化规则
2. **多种规则类型** — 支持创建者映射、名称前缀推断、资源组映射、VPC 归属等
3. **规则执行** — 支持 dry_run 预览和实际执行
4. **执行历史** — 查询规则执行历史

## 支持的规则类型

| 规则类型 | 说明 | 配置示例 |
|---------|------|---------|
| `creator_to_team` | 根据资源创建者映射到 team 标签 | `{"creator_team_map": {"user1": "sre"}}` |
| `name_prefix_to_env` | 根据资源名称前缀推断 env 标签 | `{"prefix_env_map": {"dev-": "dev"}}` |
| `resource_group_mapping` | 根据资源组映射标签 | `{"rg_tag_map": {"rg-dev": {"env": "dev"}}}` |
| `vpc_to_team` | 根据 VPC 归属推断 team 标签 | `{"vpc_team_map": {"vpc-xxx": "sre"}}` |

## 功能列表

| 操作 | 工具函数 | 风险等级 | 说明 |
|------|---------|---------|------|
| 列出规则 | `taga_list_rules` | LOW | 列出所有自动化规则 |
| 创建规则 | `taga_create_rule` | MEDIUM | 创建新的自动化规则 |
| 更新规则 | `taga_update_rule` | MEDIUM | 更新现有规则 |
| 删除规则 | `taga_delete_rule` | MEDIUM | 删除规则 |
| 执行规则 | `taga_execute_rules` | MEDIUM | 执行规则（支持 dry_run） |
| 查询历史 | `taga_execution_history` | LOW | 查询规则执行历史 |

## 典型使用流程

### 1. 创建自动化规则

```
→ taga_create_rule(
    name="创建者到团队映射",
    rule_type="creator_to_team",
    config={"creator_team_map": {"alice": "sre", "bob": "data"}},
    scope={"resource_types": ["ACS::ECS::Instance"], "regions": ["cn-hangzhou"]}
  )
```

### 2. 预览执行效果

```
→ taga_execute_rules(rule_ids=["rule-xxx"], dry_run=True)
  预览规则匹配结果和标签建议
```

### 3. 执行规则

```
→ taga_execute_rules(rule_ids=["rule-xxx"], dry_run=False)
  实际执行规则，应用标签
```

### 4. 查询执行历史

```
→ taga_execution_history(rule_id="rule-xxx", limit=10)
```

## 规则配置文件

路径：`~/.copaw/data/tag_automation_rules.json`

```json
{
  "rules": [
    {
      "rule_id": "rule-xxx",
      "name": "创建者到团队映射",
      "enabled": true,
      "rule_type": "creator_to_team",
      "priority": 1,
      "config": {
        "creator_team_map": {"alice": "sre", "bob": "data"}
      },
      "scope": {
        "resource_types": ["ACS::ECS::Instance"],
        "regions": ["cn-hangzhou"]
      },
      "alert_channels": [],
      "last_execution": null
    }
  ]
}
```

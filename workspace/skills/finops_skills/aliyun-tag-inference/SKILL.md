---
name: aliyun-tag-inference
description: "标签智能推断引擎 — 基于启发式规则和拓扑分析推断标签归属。触发词：智能推断标签、自动识别标签、标签建议"
metadata:
  copaw:
    emoji: "🔮"
    requires:
      - alibabacloud-ecs20140526
      - alibabacloud-vpc20160428
      - alibabacloud-resourcecenter20221201
      - alibabacloud-tag20180828
      - alibabacloud-tea-openapi
  opsclaw:
    emoji: "🔮"
    os: ["darwin", "linux", "win32"]
    requires:
      env:
        - ALIBABA_CLOUD_ACCESS_KEY_ID
        - ALIBABA_CLOUD_ACCESS_KEY_SECRET
      bins: []
      install:
        - pip install copaw
        - pip install alibabacloud-ecs20140526
        - pip install alibabacloud-vpc20160428
        - pip install alibabacloud-resourcecenter20221201
        - pip install alibabacloud-tag20180828
        - pip install alibabacloud-tea-openapi
---

# aliyun-tag-inference — 标签智能推断引擎

标签**智能推断引擎**技能，基于启发式规则和拓扑分析推断标签归属。通过正则模式匹配、VPC 拓扑继承、创建者信息等方式智能推断资源应该具有的标签。

## 核心能力

1. **名称模式推断** — 根据资源名称正则匹配推断 env 标签
2. **VPC 拓扑推断** — 根据 VPC 归属关系推断 team 标签
3. **创建者推断** — 根据资源创建者推断 owner 标签
4. **批量推断** — 对给定资源执行所有适用的推断方法
5. **推断审核** — 人工审核推断结果后应用

## 推断方法和置信度

| 推断方法 | 标签键 | 置信度范围 | 说明 |
|---------|--------|-----------|------|
| 名称模式匹配 | env | 0.8-0.9 | `prod|production|prd` → prod |
| VPC 自身标签继承 | team | 0.9 | VPC 有 team 标签，子资源继承 |
| VPC 安全组关联 | team | 0.75 | 通过安全组间接推断 |
| 创建者映射 | owner | 0.8 | 创建者用户名映射 |

## 功能列表

| 操作 | 工具函数 | 风险等级 | 说明 |
|------|---------|---------|------|
| 名称推断 env | `tagi_infer_env_from_name` | LOW | 正则模式矩阵推断 env 标签 |
| VPC 推断 team | `tagi_infer_team_from_vpc` | LOW | VPC 拓扑推断 team 标签 |
| 创建者推断 owner | `tagi_infer_owner_from_creator` | LOW | 创建者映射推断 owner 标签 |
| 批量推断 | `tagi_batch_infer` | LOW | 对给定资源执行所有推断方法 |
| 查询推断 | `tagi_review_inferences` | LOW | 查询待审核推断列表 |
| 应用推断 | `tagi_apply_inferences` | MEDIUM | 确认或拒绝推断结果 |

## 典型使用流程

### 1. 执行智能推断

```
→ tagi_infer_env_from_name(
    resource_types=["ACS::ECS::Instance"],
    regions=["cn-hangzhou"]
  )
  根据名称模式推断 env 标签

→ tagi_infer_team_from_vpc(
    vpc_ids=["vpc-xxx", "vpc-yyy"],
    region="cn-hangzhou"
  )
  根据 VPC 拓扑推断 team 标签
```

### 2. 审核推断结果

```
→ tagi_review_inferences(min_confidence=0.8, status="pending")
  查询高置信度的待审核推断

→ tagi_apply_inferences(
    inference_ids=["inf-xxx", "inf-yyy"],
    action="approve"
  )
  确认并应用推断结果
```

### 3. 批量推断

```
→ tagi_batch_infer(
    resource_arns=["arn:acs:ecs:..."],
    tag_keys=["env", "team", "owner"]
  )
  对指定资源执行所有适用的推断方法
```

## 推断结果数据模型

```json
{
  "inference_id": "inf-xxx",
  "resource_arn": "arn:acs:ecs:cn-hangzhou:123456:instance/i-xxx",
  "resource_name": "prod-web-server-01",
  "inferred_tags": {
    "env": "prod"
  },
  "confidence": 0.9,
  "method": "name_pattern_match",
  "evidence": "名称匹配模式: prod|production|prd",
  "status": "pending",
  "created_at": "2024-01-01T00:00:00"
}
```

## 持久化文件

推断结果存储：`~/.copaw/data/tag_inferences.json`

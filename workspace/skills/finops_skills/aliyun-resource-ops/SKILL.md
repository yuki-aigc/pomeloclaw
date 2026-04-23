---
name: aliyun-resource-ops
description: "阿里云资源运维管理工具。支持 ECS/RDS 等多产品的资源创建、删除、启动、停止、重启、释放等运维操作。支持与 optimizer 联动执行优化建议。所有操作都经过 OpsClaw 框架的权限控制和审计。触发词：启动实例、停止实例、重启实例、释放实例、创建 ECS、执行优化动作"
metadata:
  copaw:
    emoji: "⚙️"
    requires:
      - alibabacloud-ecs20140526
      - alibabacloud-rds20140815
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
        - pip install alibabacloud-ecs20140526
        - pip install alibabacloud-rds20140815
        - pip install alibabacloud-tea-openapi
---
# Aliyun Resource Ops - 云资源运维管理

多产品云资源的运维管理工具，提供资源的生命周期管理能力。

## 核心特性

### 1. 基础运维操作
- ECS 云服务器：创建、删除、启动、停止、重启、批量操作
- RDS 数据库：启动、停止、重启、释放

### 2. optimizer 联动执行
- 从 optimizer 导入优化建议到 Action Store
- 查询待执行的优化动作
- 执行优化动作（释放/降配）
- 跳过不需要的优化建议

## 何时使用此 Skill

当用户表达以下意图时，应该调用此 skill：

### 基础运维场景
- **查询资源**："查看 ECS 实例"、"列出 RDS"、"有哪些服务器"
- **启动资源**："启动实例"、"开机"、"启动服务器"
- **停止资源**："停止实例"、"关机"、"停止服务器"
- **重启资源**："重启实例"、"重启服务器"、"reboot"
- **创建资源**："创建 ECS"、"新建实例"、"开一台服务器"
- **删除/释放资源**："释放实例"、"删除 ECS"、"销毁服务器"

### 成本优化联动场景
- **导入优化建议**："把 optimizer 的分析建议保存到 Action Store"
- **查询待执行动作**："有哪些待执行的优化动作"、"列出可以优化的资源"
- **执行优化动作**："执行这个优化建议"、"释放这台闲置机器"
- **跳过优化建议**："跳过这条建议"、"这个资源需要保留"

**注意**：标签相关操作（打标签、查标签）请使用 `aliyun-tag-foundation` / `aliyun-tag-automation` skill。

## 功能列表

### ECS 实例

| 操作 | 工具函数 | 风险等级 | 说明 |
|------|---------|---------|------|
| 查询实例列表 | `ops_ecs_list_instances` | LOW | 列出 ECS 实例 |
| 查询实例详情 | `ops_ecs_describe_instance` | LOW | 获取实例详细信息 |
| 启动实例 | `ops_ecs_start_instance` | MEDIUM | 启动已停止的实例 |
| 停止实例 | `ops_ecs_stop_instance` | MEDIUM | 停止运行中的实例 |
| 重启实例 | `ops_ecs_restart_instance` | MEDIUM | 重启实例 |
| 创建实例 | `ops_ecs_create_instance` | HIGH | 创建新的 ECS 实例（产生费用） |
| 释放实例 | `ops_ecs_release_instance` | CRITICAL | 释放按量付费实例（不可恢复） |
| 批量启动 | `ops_ecs_batch_start_instances` | HIGH | 批量启动多个实例 |

### RDS 实例

| 操作 | 工具函数 | 风险等级 | 说明 |
|------|---------|---------|------|
| 查询实例列表 | `ops_rds_list_instances` | LOW | 列出 RDS 实例 |
| 启动实例 | `ops_rds_start_instance` | MEDIUM | 启动 RDS 实例 |
| 停止实例 | `ops_rds_stop_instance` | MEDIUM | 停止 RDS 实例 |
| 重启实例 | `ops_rds_restart_instance` | MEDIUM | 重启 RDS 实例 |
| 释放实例 | `ops_rds_release_instance` | CRITICAL | 释放按量付费实例（不可恢复） |

### optimizer 联动

| 操作 | 工具函数 | 风险等级 | 说明 |
|------|---------|---------|------|
| 导入优化建议 | `ops_import_optimizer_actions` | LOW | 从 optimizer 结果导入可执行动作 |
| 查询待执行动作 | `ops_list_pending_actions` | LOW | 列出待执行的优化动作 |
| 执行优化动作 | `ops_execute_action` | MEDIUM | 执行单条优化动作（需确认） |
| 跳过优化动作 | `ops_skip_action` | LOW | 标记动作为已跳过 |
| 获取统计信息 | `ops_get_action_stats` | LOW | 获取 Action Store 统计 |

## 支持的资源类型

- `ecs:instance` - ECS 云服务器
- `rds:instance` - RDS 数据库
- `optimizer:action-store` - 优化动作存储（联动用）

## 使用前提

1. 已通过 `copaw ops credential add` 配置 AKSK 凭证
2. 在 config.json 中启用 `ops.enabled = true`
3. 凭证具有相应的 RAM 权限

## 区域参数

所有工具都支持 `region_id` 参数，默认为 `cn-hangzhou`。

常用区域 ID：
- `cn-hangzhou` - 华东 1（杭州）
- `cn-shanghai` - 华东 2（上海）
- `cn-beijing` - 华北 2（北京）
- `cn-shenzhen` - 华南 1（深圳）
- `cn-hongkong` - 香港

## 安全说明

- 所有操作都会被审计记录
- 高风险操作（如释放实例）需要审批
- 敏感信息（如 AccessKey）会被自动脱敏

## 典型使用场景

### 基础运维场景

#### 场景 1：用户要求"查看 ECS 实例"

```python
ops_ecs_list_instances(region_id="cn-hangzhou")
```

#### 场景 2：用户要求"重启实例 i-xxx"

```python
ops_ecs_restart_instance(instance_id="i-xxx", region_id="cn-hangzhou")
```

#### 场景 3：用户要求"创建一台测试服务器"

```python
ops_ecs_create_instance(
    region_id="cn-hangzhou",
    instance_name="test-server",
    instance_type="ecs.t5-lc1m2.small"
)
```

### optimizer 联动场景

> **重要执行流程**：当用户要求"执行优化动作"、"执行优化建议"、"释放/降配上面分析出的资源"时，**必须按以下流程执行**：
> 1. **先调用 `ops_list_pending_actions`** 从 Action Store 查询待执行动作
> 2. 向用户展示待执行动作列表（包含 action_id、resource_id、策略、预计节省等）
> 3. 用户确认后，使用查询到的 **action_id** 调用 `ops_execute_action` 执行
>
> **禁止**：直接从上下文或历史报告中提取资源 ID 执行操作，必须从 JSON 文件查询。

#### 场景 4：从 optimizer 导入优化建议

```python
# 假设 optimizer_results 是 optimizer 分析返回的 JSON 字符串
ops_import_optimizer_actions(
    optimizer_results_json=optimizer_results,
    region_id="cn-hangzhou",
    analysis_id="report_20260321",
    supported_products=["ECS", "RDS"],
    replace_pending=False  # 不替换现有的 pending 动作
)
```

#### 场景 5：查询待执行的优化动作

```python
# 列出所有待执行动作
ops_list_pending_actions(limit=50)

# 过滤 ECS 的释放动作
ops_list_pending_actions(product="ECS", strategy="Release", min_saving=100)
```

#### 场景 6：执行优化动作

```python
# 干运行模式（只验证不执行）
ops_execute_action(action_id="act_xxx", confirm=True, dry_run=True)

# 实际执行（需要审批）
ops_execute_action(action_id="act_xxx", confirm=True, dry_run=False)
```

#### 场景 7：跳过优化建议

```python
# 标记为已跳过
ops_skip_action(action_id="act_xxx", reason="业务高峰期需要保留")
```

## Action Store 数据流转

```
optimizer 分析 → 提取可执行动作 → Action Store → resource-ops 执行
     ↓                                    ↑
  生成报告                          查询/执行/跳过
```

**Action Store 存储路径**: `~/.copaw/data/optimization_actions.json`

**动作有效期**: 默认 7 天（过期后自动标记为 expired）

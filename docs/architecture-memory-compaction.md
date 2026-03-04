# Memory + Compaction 流程图（Pomelobot）

本文提供端到端流程图，覆盖：
- 在线消息处理路径（含 memory flush 与 compaction）
- 启动保障路径（含 04:00 自动记忆归档任务）
- 退出/重启路径（含 K8s preStop + SIGTERM 的关机保护）

---

## 1. 在线处理主流程

```mermaid
flowchart TD
    A["用户消息 (CLI / DingTalk)"] --> B["解析会话 Scope (main / group / direct)"]
    B --> C["加载或创建 Session"]
    C --> C1{"会话首轮? (无历史且未hydrated)"}
    C1 -- "Yes" --> C2["注入今昨 Markdown 摘要 (限额裁剪)"]
    C1 -- "No" --> D
    C2 --> D
    D["更新 Token 计数器"]

    D --> E{"达到 flush 阈值? (>= 90%)"}
    E -- "Yes" --> F["Memory Flush (强制 memory_save)"]
    E -- "No" --> G
    F --> G{"达到 compaction 阈值? (>= auto_compact_threshold)"}
    D --> G

    G -- "Yes" --> H["Compaction (摘要旧消息 + 保留最近消息)"]
    G -- "No" --> I["执行 Agent 推理"]
    H --> I

    I --> J["按需调用 memory_search"]
    J --> K["检索 memory_chunks (FTS / Vector / Hybrid)"]
    J --> L["检索 session_events (会话热日志)"]
    J --> T["回溯意图触发时间窗口检索 (昨天/上次/之前)"]
    J --> M["PG 不可用时回退文件 keyword 检索"]
    K --> J2["需要精确引用时调用 memory_get(path/from/lines)"]
    L --> J2
    T --> J2
    M --> J2

    I --> N["持久化会话事件 (user / assistant / summary)"]
    N --> L
    N --> N1["异步补齐 session event embedding (batch worker)"]
    N1 --> L
    N --> N2["TTL 后台清理过期 session events"]

    I --> O["持久化会话状态 (messageHistory + token 计数)"]
    O --> P["PG dingtalk_sessions"]

    F --> Q["写入记忆文件 (daily / long-term)"]
    Q --> R["增量索引同步"]
    R --> K

    O --> S["返回回复给用户"]
```

---

## 2. 启动保障流程（每日 04:00 归档）

```mermaid
flowchart TD
    A["DingTalk 进程启动"] --> B["CronService 启动并加载 jobs"]
    B --> C["幂等检查 auto-memory-save 任务"]
    C --> D{"任务存在?"}
    D -- "No" --> E["创建 0 4 * * * 任务"]
    D -- "Yes" --> F["校验并修正漂移配置"]
    F --> G{"发现重复任务?"}
    G -- "Yes" --> H["删除重复项，仅保留1个"]
    G -- "No" --> I["完成"]
    E --> I
    H --> I
```

---

## 3. 退出/重启保护流程

```mermaid
flowchart TD
    A["Pod 终止 / Ctrl+C"] --> B["K8s preStop 或系统信号触发 SIGTERM"]
    B --> C["DingTalk shutdown handler"]
    C --> D["等待会话处理队列清空 (drain + timeout)"]
    D --> E["对活跃 Session 执行 shutdown memory flush"]
    E --> F["持久化 Session 到 dingtalk_sessions"]
    F --> G["关闭 SessionStore / MCP 等资源"]
    G --> H["进程退出"]
```

补充说明：
- `SIGINT/SIGTERM` 可以触发上述保护流程。
- `SIGKILL` 无法被进程捕获，无法执行 flush（系统行为）。

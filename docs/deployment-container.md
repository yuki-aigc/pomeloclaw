# 容器部署说明

## 1. 当前 Dockerfile 设计

文件：`deploy/Dockerfile`

目标：

- 保留原有 Ubuntu 基础镜像与预装工具（curl/git/vim/python/node/pnpm）
- 使用多阶段构建减少运行时无关内容
- 运行镜像仅保留必要运行文件

## 2. 运行镜像包含内容

最终镜像中只包含：

- `dist/`
- `node_modules/`（生产依赖）
- `package.json`
- `exec-commands.json`
- `config-example.json`
- 运行目录：`workspace/`、`logs/`

说明：

- `config.json` 建议通过 K8s Secret / 挂载文件注入，不建议固化进镜像
- 若运行时需要自定义模板/静态资源，按需增加 COPY

## 3. 构建与启动

### 3.1 构建镜像

```bash
docker build -f deploy/Dockerfile -t your-registry/pomelobot:latest .
```

Mac 若要构建 linux/amd64：

```bash
docker build --platform linux/amd64 -f deploy/Dockerfile -t your-registry/pomelobot:latest .
```

### 3.2 默认启动命令

Dockerfile 默认：

```bash
pnpm start:server
```

即运行多渠道统一入口（当前已实现 dingtalk）。

## 4. K8s 部署要点

### 4.1 清单路径

- `deploy/k8s/deploy-all.yaml`：应用部署清单（Deployment + Secret + PVC）
- `deploy/k8s/sts.yaml`：PostgreSQL StatefulSet 示例

### 4.2 Secret 名称

`deploy/k8s/deploy-all.yaml` 默认引用：

```yaml
secretName: deepagents-srebot-config
```

创建命令示例：

```bash
kubectl create secret generic deepagents-srebot-config \
  --from-file=config.json=./config.json
```

### 4.3 容器启动命令

当前清单默认：

```yaml
command: ["pnpm", "start:server"]
```

## 5. 运行建议

1. `workspace` 必须持久化（记忆、技能、cron 都依赖）
2. `logs` 可挂载或交由 stdout + 日志系统采集
3. PG 可用性直接影响 `backend=pgsql` 模式，建议配置健康检查与资源预留

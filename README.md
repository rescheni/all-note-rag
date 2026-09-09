# 笔记中枢（Note Hub）

**个人只读笔记中枢**。写作仍在思源、Notion、飞书、Obsidian；中枢负责接入、书架浏览、预览、搜索与问答。**永不写回**任何源。

中文界面。预览只读本地缓存 / S3 规范对象。

**License: [AGPL-3.0](LICENSE)** — SPDX: `AGPL-3.0-only`

主导航：首页 / 笔记 / 搜索 / 问答 / 接入 / 设置 / 账号（「成长」已不在主导航）。

## 它是什么

| 能力 | 说明 |
|------|------|
| 四源接入 | 思源、Notion、飞书、Obsidian |
| 同步 | 手动 + 对象存储唤醒；约每小时巡检 |
| 书架 / 树 / 预览 | 只读预览，不回源 |
| 搜索与问答 | FTS + 向量；可选上游 Chat |
| API / MCP | JWT、hub_ Token、Basic；见 docs/MCP.md |
| 本地嵌入 | ONNX；Compose 挂载 ./DATA/models |

架构：web (Next) → api (Hono) → Postgres/pgvector + Redis + MinIO；worker 做同步与抽取。

安全审计：[docs/SECURITY-AUDIT.md](docs/SECURITY-AUDIT.md)

## 快速启动（Docker Compose）

持久化一律使用仓库旁的 `./DATA`：

| 路径 | 用途 |
|------|------|
| `./DATA/postgres` | Postgres |
| `./DATA/redis` | Redis AOF |
| `./DATA/minio` | MinIO |
| `./DATA/models` | 本地嵌入模型（api/worker 共享） |

先准备环境文件并设置强随机签名密钥（见 docker-compose.yml 顶部注释与环境样例），再执行 `docker compose up --build`。
浏览器：http://localhost:3000 （API :3001）。基础设施端口只绑环回。不要提交环境文件或 `DATA/`。

## Environment

See the dotenv example at repo root. Change the hub signing secret before any shared deploy.
Optional: OpenAI-compatible chat endpoint, Notion/Feishu OAuth, local embed provider.

## Agent / MCP

Auth: login JWT, hub_ token, or HTTP Basic. MCP at /v1/mcp (Bearer hub_…). Details: docs/MCP.md.
Self-host: point MCP URL at your own host (any public hostname in docs is an example only).

## CI images

Workflow: .github/workflows/docker.yml — builds note-hub-api/worker/web to ghcr.io/<owner>/… on master/main and v* tags; PRs build-only.

## Docs

- docs/用户指南.md
- docs/开发文档.md
- docs/MCP.md
- docs/SECURITY-AUDIT.md
- docs/CHANGELOG.md

## License

GNU Affero General Public License v3. See LICENSE. SPDX-License-Identifier: AGPL-3.0-only.

## Boundaries

- Never write back to sources; preview stays on hub cache/S3.
- Answers should be attributable (source cards).

# 笔记中枢（Note Hub）P0

个人笔记只读聚合层。P0 只做 **Obsidian 明文 S3 前缀** + 预览 + Postgres FTS。不写回源库。预览不回源。

## 本机依赖

- Node.js 20+（文档目标为 22；20 可用）
- pnpm 9
- Docker Compose **或** 本机 Postgres / Redis / MinIO

`docker-compose.yml` 使用 **Postgres 16**、Redis、MinIO。若当前环境没有 Docker，可用系统包安装 Postgres（本仓库在 Debian 上用 17 验证过，FTS 行为一致）+ Redis + MinIO 二进制。

## 环境变量

复制 `.env.example` 为 `.env`：

| 变量 | 含义 |
|------|------|
| DATABASE_URL | Postgres 连接串 |
| REDIS_URL | Redis |
| S3_ENDPOINT / S3_REGION / S3_BUCKET | 中枢桶（默认 hub-dev） |
| S3_ACCESS_KEY / S3_SECRET_KEY | 对象存储密钥 |
| HUB_SECRET | 用于加密 Connection secrets、签发会话 |
| VAULT_BUCKET | 夹具 vault 所在桶（默认 obsidian-src） |
| API_PORT / WEB_ORIGIN / NEXT_PUBLIC_API_URL | API 与前端 |
| OPENAI_BASE_URL / OPENAI_API_KEY / CHAT_MODEL | 可选。不设则问答走抽取式作答 |
| EMBEDDING_MODEL | 可选，默认 `text-embedding-3-small`。未配 OpenAI 时用本地 hashed n-gram 投影（1536 维），不打外网 |

密钥**永远不会**出现在 API 响应里。

## 启动（Docker）

```bash
docker compose up -d
cp .env.example .env
pnpm install
pnpm migrate
pnpm seed
pnpm --filter @note-hub/api dev
# 另开终端
pnpm --filter @note-hub/worker dev
pnpm --filter @note-hub/web dev
```

## 启动（无 Docker，本机服务）

1. 启动 Postgres，创建库 `notehub` 用户 `notehub`。
2. 启动 Redis：`redis-server --daemonize yes`。
3. 启动 MinIO：`minio server /data --address 127.0.0.1:9000`（账号 minioadmin / minioadmin）。
4. 然后同样：`pnpm install && pnpm migrate && pnpm seed`，再跑 api / worker / web。

也可用 `scripts/boot-local.sh`（会尝试拉起本机 Postgres/Redis/MinIO 并 migrate+seed）。


## 接入

中枢只读，**不写回**任何源。首页四个源卡片与导航「接入」都指向 `/connections/new?source=...`，不再只有「新建 Obsidian 连接」。

| 源 | 方式 | v1 |
|----|------|----|
| **Obsidian** | 明文 S3 / Remotely Save 前缀 | 完整摄入 Markdown + 引用附件 |
| **思源** | 模式 A：内核 HTTP（`lsNotebooks` / SQL / `exportMdContent`）；模式 B：明文 `data/` 前缀 | **官方 S3 `repo/` dejavu 快照不受支持**，返回 `siyuan_official_s3_unsupported`（「v1 不解包官方加密快照，请用内核 API 或明文 data/ 前缀。」） |
| **Notion** | Integration token，探活 `GET /v1/users/me`，search 页面与数据库行，blocks → markdown | 会摄入笔记；需要真实 token。单元测试使用 mock fetch，不打外网 |
| **飞书** | `tenant_access_token` + 知识库 `wiki_space_id` 下 docx | 会摄入笔记；需要真实应用凭证。未填 wiki_space_id 时列表为空。测试使用 mock |

密钥永远不会出现在 API 响应里。夹具：`fixtures/obsidian-vault` → 桶 `obsidian-src`；`fixtures/siyuan-data` → 桶 `siyuan-src`。

## 验收路径

1. 打开 http://127.0.0.1:3000 注册账号（自动创建个人空间）。
2. 「接入」→ Obsidian：Endpoint `http://127.0.0.1:9000`，Bucket `obsidian-src`，prefix `vault1`，密钥 minioadmin。也可接入思源明文 `siyuan-src` / `workspace` 前缀。
3. 保存并同步。
4. 打开笔记列表，预览 `Welcome.md`，应看到「欢迎来到笔记中枢夹具库」。
5. 搜索 `紫铜灯笼检索词` 或 `PINEAPPLE_LANTERN_ZHONGSHU`，应命中 `Daily/2026-08-29.md`。
6. `.obsidian/` 与 `.trash/` 中的文件不得出现在笔记列表。

自动化：`bash scripts/p0-acceptance.sh`（需 api+worker 已启动，脚本会 seed / 注册 / 连接 / 同步 / 断言）。

测试：`pnpm test`。

## 文件级同步

全量 `POST /v1/connections/:id/sync`（无 `keys` 或空数组）仍会 ListObjects 整个前缀。传入 `keys` 则**只拉这些对象**，不列举前缀：

```bash
# 编辑者角色。keys 可以是完整对象键或 vault 相对路径
curl -X POST "http://127.0.0.1:3001/v1/connections/$CONNECTION_ID/sync" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"keys":["vault1/Daily/2026-08-29.md"]}'
```

MinIO / S3 事件通知（无用户会话，共享 `HUB_SECRET`，请求头 `x-hub-secret`）：

```bash
curl -X POST "http://127.0.0.1:3001/v1/hooks/s3" \
  -H "x-hub-secret: $HUB_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"bucket":"obsidian-src","key":"vault1/Daily/x.md","eventName":"s3:ObjectCreated:Put"}'
```

也接受 S3 通知 JSON（`Records[].s3.bucket.name` + `Records[].s3.object.key`）。按 bucket+prefix 匹配 Connection：Obsidian `remote_prefix`、思源 workspace `workspace_prefix`、中枢桶 `source/{space}/{conn}/` 镜像。没有匹配返回 404。不同文件并行（jobId `syncfile-{connectionId}-{shortHash}`），同一文件合并。永不写回源。

可选：`bash scripts/minio-notify.sh`（有 `mc` 时把桶事件指到 `http://127.0.0.1:3001/v1/hooks/s3`；没有 `mc` 则跳过且不失败）。

## 中文 FTS

P0 使用 `simple` 配置 + **双 gram** 写入 `chunks.fts`（应用层把 CJK 切成重叠二字再 `to_tsvector('simple', ...)`）。
搜索同时走 `ILIKE` 子串，保证中文短词可命中。
Ask 另走向量通道（`chunks.embedding vector(1536)`）再与 FTS **RRF** 融合；无 embedding 的块仍可通过 FTS 召回。未配 OpenAI 时用本地 hashed n-gram 投影，测试不打外网。
若镜像安装了 zhparser / pg_jieba，可在后续阶段切换配置；当前默认不依赖它们。

## 硬性边界（P0）

- 永不写回源 vault
- GET preview 只读 `preview/` 与 `canonical/` + DB，不打源 S3
- 问答为抽取式（可选 Chat Completions）。Growth 仅个人空间。
- e2ee=true → 连接状态 `encrypted_unreadable`，跳过正文
- 忽略 `.obsidian/` 与 `.trash/`

## 仓库结构

```
apps/api        Hono /v1
apps/worker     BullMQ 同步管道
apps/web        Next.js App Router
packages/core
packages/adapters   Obsidian S3
packages/normalize
packages/preview
packages/retrieve        FTS 召回 + 抽取式问答
packages/skills-runtime  解析 SKILL.md，P1 进程内执行
apps/skill-runner        薄 CLI（parse / hooks）
skills/growth-weekly     官方成长周报 Skill
```

P1 在 worker 成功 upsert 后对个人空间跑 `post-sync` 抽取；`/v1/spaces/:id/growth/report` 走 `weekly-report`。Skill 看不到 Connection 密钥，不写回编辑器。

## 实现备注

- 规格中的同步 jobId 为 `sync:{connection_id}`。BullMQ 自定义 id 不允许冒号，实现使用 `sync-{connection_id}`，仍然按连接去重串行。

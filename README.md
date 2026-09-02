# 笔记中枢（Note Hub）P0

个人笔记只读聚合层。P0 只做 **Obsidian 明文 S3 前缀** + 预览 + Postgres FTS。不写回源库。预览不回源。

## 本机依赖

- **推荐（新机器）**：只需 Docker Compose。一次 `docker compose up --build` 即可。
- Worker 镜像已包含 tesseract-ocr（chi_sim + eng）、poppler-utils、antiword。**不要**在宿主机用系统包安装 tesseract。
- 本机 Node 开发：Compose 只起 postgres/redis/minio，再跑 dev:api / dev:worker / dev:web（.env 用 127.0.0.1）。
- 无 Docker：系统包 Postgres（必须有 vector 扩展）+ Redis + MinIO。

## OCR

Native tesseract / pdftotext / antiword 来自 worker 镜像。宿主机跑 worker 时若没有这些二进制，会走 tesseract.js fallback。迁移路径以镜像内原生 OCR 为准。

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
| NOTION_CLIENT_ID / NOTION_CLIENT_SECRET / NOTION_REDIRECT_URI | 可选。Notion 公开集成 OAuth。未配置时连接页仍可用 Integration Token。回调默认 `http://127.0.0.1:3000/v1/connections/oauth/notion/callback` |

密钥**永远不会**出现在 API 响应里。

## 启动（Docker，新机器）

全程容器，无需本机 Node / tesseract：

```bash
docker compose up --build
```

浏览器打开 http://localhost:3000（API 在 :3001；Web 同域 /v1 rewrite 到 http://api:3001）。
migrate 以一次性容器跑完；minio-init 会创建 hub-dev / obsidian-src / siyuan-src。

可选夹具种子（API 镜像内含 fixtures/）：

```bash
docker compose run --rm api pnpm --filter @note-hub/api seed
```

请复制 .env.example 为 .env 后修改 HUB_SECRET。

Compose 已用服务名覆盖 DATABASE_URL / REDIS_URL / S3_ENDPOINT，不要把 127.0.0.1 写进容器。

## 启动（Docker 基础设施 + 本机 pnpm）

只起依赖，应用仍用本机 dev 脚本：

```bash
docker compose up -d postgres redis minio minio-init
cp .env.example .env
pnpm install
pnpm migrate
pnpm seed
pnpm dev:api
# 另开终端
pnpm dev:worker
pnpm dev:web
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
| **思源** | 模式 A：内核 HTTP（`lsNotebooks` / SQL / `exportMdContent`）；模式 B：明文 `data/` 前缀 | 官方 S3 `repo/` dejavu 快照：填写**数据仓库密码**（`repo_password`）后只读摄入最新快照中的 `.sy`。无密码返回 `siyuan_repo_password_required`；密码错误返回 `siyuan_repo_password_incorrect` |
| **Notion** | OAuth（公开集成）为主，Integration Token 为后备。探活 `GET /v1/users/me`，search 页面与数据库行，blocks → markdown | 会摄入笔记。OAuth 需在 Notion 登记集成并设置 `NOTION_CLIENT_ID` / `NOTION_CLIENT_SECRET`。单元测试 mock fetch，不打外网 |
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

MinIO / S3 事件通知（无用户会话，共享 `HUB_SECRET`，请求头 `x-hub-secret` 或 `Authorization: Bearer`）：

```bash
curl -X POST "http://127.0.0.1:3001/v1/hooks/s3" \
  -H "x-hub-secret: $HUB_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"bucket":"obsidian-src","key":"vault1/Daily/x.md","eventName":"s3:ObjectCreated:Put"}'
```

也接受 S3 通知 JSON（`Records[].s3.bucket.name` + `Records[].s3.object.key`）以及 MinIO 的 `EventName` / `Key`。按 **源桶** + prefix 匹配 Connection（Obsidian `remote_prefix`、思源 workspace `workspace_prefix`）。中枢桶 `hub-dev` 的 canonical/preview 写入不会唤醒同步，避免环路。没有匹配返回 404。同一连接上的对象事件会 **debounce**（约 1.5s）合并成一条 `sync.file`（jobId `syncfile-{connectionId}`），而不是 N 次全量 checkout。永不写回源。

API 启动时对**本地**源桶（Obsidian / 思源 workspace，endpoint 为本机 MinIO）注册 bucket notification → `POST /v1/hooks/s3`。也可用 `bash scripts/minio-notify.sh`（会在需要时下载 `mc`）。远程源（例如 `http://reschen.cn:9000/` 的思源桶）若无管理权限则跳过，仍靠 30 秒 poll。

## 自动同步与搜索

- **主路径**：源桶对象 PUT/DELETE → webhook → debounce 后 `sync.file`。
- **保底**：API 每 **30 秒**（启动时立即一次）对所有 `active` 连接 `enqueueSync`（`TICK_MS`）。增量 `listChanges` 按 etag / last_edited_time / obj_edit_time 跳过未改文件。
- 搜索 `GET /v1/spaces/:id/search` 返回 **源文件** `results`（keyword / path / FTS）和 **相似文件** `similar`（向量近邻，排除已命中 id）。`GET /v1/notes/:id/similar` 用于预览页。
- 嵌入随同步写入 `chunks.embedding`；hash 未变但向量为空时下次同步会补齐。永不写回源。

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

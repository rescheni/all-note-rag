# 笔记中枢（Note Hub）

**个人只读笔记中枢**，无团队协作。写作仍在思源、Notion、飞书、Obsidian 完成；中枢负责接入、书架浏览、预览、搜索与问答。**永不写回**任何源。

中文界面。预览只读本地缓存 / S3 规范对象，不在预览路径上打源站实时 API。

主导航：首页 / 笔记 / 搜索 / 问答 / 成长 / 接入 / 设置。**会议、写作、Skills 已从主导航下线**（路由仍保留说明页）。写作仍在思源 / Notion / 飞书 / Obsidian。

## 产品一览

- **四源接入**：思源、Notion、飞书、Obsidian（Obsidian 可用，非优先推荐）
- **同步**：手动「同步」+ 对象存储变更唤醒；自动巡检约每小时（仅当距上次同步已超过约 1 小时）
- **书架 + 树 + 预览**：连接像书立在书架上；点开后是文件夹树与笔记预览
- **搜索与问答**：关键词 / 路径 / FTS + 向量近邻；**问答**在配置 AI 后走 Chat Completions（未配置则本地抽取）；带来源卡片
- **双链 / 块引用**：Wiki 链、思源块引用、Notion / 飞书页面提及等会解析成站内链接与反向链接
- **主题**：抹茶纸色（默认）、墨夜、素白
- **PWA**：可安装到桌面 / 主屏（manifest + Service Worker）
- **热力图**：首页写作活动（字数 / 块 / 篇）
- **账号**：注册登录、个人空间 **子账号**（账号页）、长效 **API Token**（`hub_…`）
- **Agent 调用**：登录 JWT / `hub_` Token / HTTP Basic（邮箱+密码）
- **MCP**：`/v1/mcp`（Bearer `hub_`），供 Cursor 等外部 AI 只读检索；见 [docs/MCP.md](docs/MCP.md)
- **设置**（导航「设置」）：AI 端点、主题、氛围；配置 OpenAI 兼容 Base URL / Key，「刷新模型列表」从上游拉取可选模型
- **文档可见性**：私人笔记默认仅自己可见
- **OCR / Docker**：Worker 镜像含 tesseract（chi_sim + eng）、poppler、antiword；图片与 pdf/docx 可进检索

## 能力清单

| 能力 | 说明 |
|------|------|
| 思源 | 内核 HTTP，或明文 `data/` 前缀；官方 S3 `repo/` dejavu 快照（需数据仓库密码） |
| Notion | OAuth 或 Integration Token；**只能同步已分享给 Integration 的页**（见下） |
| 飞书 | **用户扫码 OAuth**（推荐）；知识库按用户身份可见范围同步；也可后备租户 token |
| Obsidian | 明文 S3 / Remotely Save 前缀；支持但非优先 |
| 3D 书架 | 首页连接书脊 + 笔记页书架视图 |
| 双链 / 块引用 | 预览可点；页脚反向链接 |
| 主题 | 抹茶 / 墨夜 / 素白（设置页） |
| PWA | 独立窗口安装 |
| 热力图 | 首页活动图 |
| 账号 / 子账号 | 个人空间可在账号页创建子账号；无团队成员协作 |
| API Token | 账号页创建 `hub_…`，Bearer 调用 `/v1` |
| Agent | JWT、`hub_`、Basic 三种鉴权 |
| MCP | `/v1/mcp` + `hub_` 令牌；search_notes / get_note 等 |
| AI | 设置里刷新模型列表并选择 chat / embedding 模型 |
| 文档可见性 | 私人笔记 · 仅自己 |
| OCR / Docker | Compose 一键；宿主机无二进制时 tesseract.js fallback |

### Notion：分享范围

Notion API **只能看到已分享给该 Integration 的页面与数据库**。OAuth 授权时勾选的内容、或在 Notion 里对页面点 **Share → 邀请你的 Integration**，才会进入中枢。要更多页就继续 Share；未分享的不会出现在同步结果里。

### 飞书：扫码与知识库

优先「用飞书扫码登录」，拿到 **用户身份**（`user_access_token`），按该用户可见的知识库与「我的文档库」同步。仅填 App ID/Secret 时，应用必须是知识库成员，否则列举节点会权限失败。可在连接里粘贴知识库 / 页面链接收窄范围。

### Obsidian

完整支持明文 vault 前缀摄入与附件，但产品优先打磨思源 / Notion / 飞书；Obsidian 作为可选源保留。

## 快速启动

默认端口：**Web 3000**，**API 3001**。

### Docker Compose（推荐新机器）

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

### 本机 pnmp+ Compose 基础设施

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


### 无容器本机服务


1. 启动 Postgres，创建库 `notehub` 用户 `notehub`。
2. 启动 Redis：`redis-server --daemonize yes`。
3. 启动 MinIO：`minio server /data --address 127.0.0.1:9000`（账号 minioadmin / minioadmin）。
4. 然后同样：`pnpm install && pnpm migrate && pnpm seed`，再跑 api / worker / web。

也可用 `scripts/boot-local.sh`（会尝试拉起本机 Postgres/Redis/MinIO 并 migrate+seed）。


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
| FEISHU_APP_ID / FEISHU_APP_SECRET / FEISHU_REDIRECT_URI | 可选。飞书扫码 OAuth 后备凭证（连接内 App 凭证优先）。须在开放平台登记重定向 URL。 |

密钥**永远不会**出现在 API 响应里。


## Agent API 简要示例

Base URL：本机 `http://127.0.0.1:3001/v1`，或经 Web 同域 `/v1`。

三种鉴权：

1. `POST /v1/auth/login` 取 JWT，请求头 Bearer token
2. 账号页长效令牌 `hub_…`，同样 Bearer
3. HTTP Basic（邮箱与密码）

探测：`GET /v1/me`。账号页有可复制示例。详见用户指南。

示例：

```
# JWT / hub_ token
curl -H "Authorization: Bearer <token>" http://127.0.0.1:3001/v1/me

# Basic
curl -u "you@example.com:password" http://127.0.0.1:3001/v1/me
```


## 文档

| 文档 | 读者 |
|------|------|
| [docs/用户指南.md](docs/用户指南.md) | 使用者 |
| [docs/开发文档.md](docs/开发文档.md) | 开发者 |
| [docs/CHANGELOG.md](docs/CHANGELOG.md) | 近期变更 |
| [docs/P0.md](docs/P0.md) | 早期 P0 存档 |

## 仓库结构

见 monorepo：apps/api、apps/worker、apps/web、packages/*、skills/。

## 硬性边界

- 永不写回源
- 预览不回源
- 问答必须可溯源（来源卡片到预览锚点）
- Growth 事件仅个人空间
- Obsidian e2ee=true 时跳过正文
- 忽略 .obsidian/ 与 .trash/

测试：根目录执行 test 脚本（package.json scripts.test）。

# 笔记中枢 · MCP

把中枢接到 **Cursor / Claude Desktop** 等外部 AI：只读检索与读笔记，**不会写回**任何源。

写作仍在思源 / Notion / 飞书 / Obsidian；中枢只读聚合与问答。

## 1. 创建密钥

1. 登录中枢 → **账号**
2. **创建令牌**（例如「Cursor MCP」）
3. 复制明文（仅显示一次），格式 `hub_…`

## 2. 端点

| 环境 | URL |
|------|-----|
| 公网 | `https://notes.rei0.cn/v1/mcp` |
| 本机 API | `http://127.0.0.1:3001/v1/mcp` |

鉴权（必备）：

```http
Authorization: Bearer hub_<你的令牌>
Content-Type: application/json
```

`GET /v1/mcp` 返回服务发现（工具名列表）；`POST /v1/mcp` 为 JSON-RPC / 便捷调用。

## 3. Cursor 配置

`~/.cursor/mcp.json`（或项目 `.cursor/mcp.json`）：

```json
{
  "mcpServers": {
    "note-hub": {
      "url": "https://notes.rei0.cn/v1/mcp",
      "headers": {
        "Authorization": "Bearer hub_你的令牌"
      }
    }
  }
}
```

重启 Cursor 后，在 MCP 面板应看到 `note-hub` 与下列工具。

## 4. 工具

| 工具 | 参数 | 说明 |
|------|------|------|
| `search_notes` | `query`（必填）, `space?`, `limit?` | 标题 / 路径 / 全文搜索 |
| `get_note` | `id` 或 `path`, `space?` | 读 Markdown 正文（过长会截断） |
| `list_connections` | `space?` | 已接入的源连接 |
| `list_spaces` | — | 当前用户可见空间 |

`space` 省略时使用第一个个人空间。

## 5. 协议与调试

兼容 **MCP HTTP JSON-RPC**（`initialize` / `tools/list` / `tools/call` / `ping`）。

示例：列出工具

```bash
curl -s https://notes.rei0.cn/v1/mcp \
  -H "Authorization: Bearer hub_…" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

便捷调用（非 JSON-RPC 信封）：

```bash
curl -s https://notes.rei0.cn/v1/mcp \
  -H "Authorization: Bearer hub_…" \
  -H "Content-Type: application/json" \
  -d '{"tool":"search_notes","arguments":{"query":"睡眠"}}'
```

## 6. 安全

- 令牌等同登录态：可读写你权限内的只读数据（中枢本身不写源）。
- 泄露后请立刻在账号页 **撤销**。
- 不要把 `hub_` 令牌提交进 Git。

## 7. 与站内问答的关系

- **站内问答**（导航「问答」）：用设置里的 AI 端点做 Chat Completions + 引用。
- **MCP**：外部模型自己推理；中枢只提供检索 / 读笔记工具。

两者都需要你在账号页持有有效身份（会话或 `hub_` 令牌）。

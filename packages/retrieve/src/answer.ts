import { UNKNOWN_ANSWER, type RetrieveHit } from "./hybrid.ts";

export type AskCitation = {
  note_id: string;
  block_id: string;
  source_block_id: string;
  title: string;
  quote: string;
  preview_url: string;
  path: string;
  connection_id: string;
};

export type AskResponse = {
  answer_markdown: string;
  citations: AskCitation[];
  unknown?: true;
  /** How the answer was produced. */
  mode?: "ai" | "extractive";
  /** True when chat was attempted but failed; answer is extractive fallback. */
  ai_failed?: boolean;
  /** Short Chinese reason for AI failure (safe to show in UI). */
  ai_error?: string;
};

export type ChatConfig = {
  baseUrl: string;
  apiKey: string;
  model?: string;
  fetch?: typeof fetch;
};

/** Thrown when a configured chat upstream fails (quota, auth, network, empty). */
export class ChatUpstreamError extends Error {
  readonly code: string;
  readonly status?: number;
  constructor(message: string, code = "ai_upstream_failed", status?: number) {
    super(message);
    this.name = "ChatUpstreamError";
    this.code = code;
    this.status = status;
  }
}

export function citationsFromHits(hits: RetrieveHit[]): AskCitation[] {
  const seen = new Set<string>();
  const out: AskCitation[] = [];
  for (const h of hits) {
    const key = `${h.note_id}#${h.source_block_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      note_id: h.note_id,
      block_id: h.block_id || h.source_block_id,
      source_block_id: h.source_block_id,
      title: h.title,
      quote: h.quote,
      preview_url: h.preview_url,
      path: h.path || "",
      connection_id: h.connection_id || "",
    });
  }
  return out;
}

export function composeExtractiveAnswer(query: string, hits: RetrieveHit[]): AskResponse {
  if (!hits.length) {
    return { unknown: true, answer_markdown: UNKNOWN_ANSWER, citations: [], mode: "extractive" };
  }
  const used = hits.slice(0, 5);
  const lines: string[] = [`根据当前空间笔记，与「${query.trim()}」相关的依据如下：`, ""];
  for (const h of used) {
    lines.push(`**${h.title}**`);
    lines.push(`> ${h.quote}`);
    lines.push("");
  }
  return {
    answer_markdown: lines.join("\n").trim(),
    citations: citationsFromHits(used),
    mode: "extractive",
  };
}

/** Short Chinese label for UI when chat upstream fails. */
export function shortAiError(err: ChatUpstreamError): string {
  switch (err.code) {
    case "ai_quota_exceeded":
      return "大模型额度不足";
    case "ai_auth_failed":
      return "AI 鉴权失败";
    case "ai_timeout":
      return "大模型请求超时";
    case "ai_network_failed":
      return "无法连接大模型";
    case "ai_bad_response":
      return "大模型返回异常";
    default:
      return err.message?.slice(0, 48) || "AI 未能生成";
  }
}

/**
 * Compose an Ask answer.
 * - No chat config → extractive (mode: extractive).
 * - Chat configured → call chat completions; on failure return extractive with
 *   ai_failed/ai_error (does not throw for quota/upstream when retrieval has hits).
 */
export async function composeAskAnswer(
  query: string,
  hits: RetrieveHit[],
  chat?: ChatConfig,
): Promise<AskResponse> {
  const extractive = composeExtractiveAnswer(query, hits);
  if (extractive.unknown) return extractive;
  if (!chat?.baseUrl || !chat?.apiKey) return extractive;
  try {
    const md = await callChat(query, hits, chat);
    const trimmed = md.trim();
    if (!trimmed || trimmed === UNKNOWN_ANSWER) {
      return { answer_markdown: UNKNOWN_ANSWER, citations: [], unknown: true, mode: "ai" };
    }
    return { answer_markdown: trimmed, citations: extractive.citations, mode: "ai" };
  } catch (e) {
    if (e instanceof ChatUpstreamError) {
      return {
        ...extractive,
        mode: "extractive",
        ai_failed: true,
        ai_error: shortAiError(e),
      };
    }
    throw e;
  }
}

function friendlyUpstreamMessage(status: number, raw: string): { message: string; code: string } {
  let detail = "";
  try {
    const j = JSON.parse(raw) as {
      error?: { message?: string; code?: string; type?: string };
      message?: string;
    };
    detail = (j?.error?.message || j?.message || "").trim();
    const code = (j?.error?.code || j?.error?.type || "").toLowerCase();
    if (
      status === 402 ||
      /insufficient|quota|credit|余额|积分/.test(detail) ||
      /insufficient|quota|credit/.test(code)
    ) {
      return {
        code: "ai_quota_exceeded",
        message: detail
          ? `大模型额度不足：${detail.slice(0, 180)}`
          : "大模型额度不足，请到 AI 服务商控制台充值后再试",
      };
    }
    if (status === 401 || status === 403 || /invalid.?key|unauthorized|authentication/.test(detail + code)) {
      return {
        code: "ai_auth_failed",
        message: detail
          ? `AI 鉴权失败：${detail.slice(0, 180)}`
          : "AI 鉴权失败，请检查设置里的 API Key",
      };
    }
  } catch {
    /* ignore */
  }
  if (detail) {
    return { code: "ai_upstream_failed", message: `大模型调用失败（HTTP ${status}）：${detail.slice(0, 180)}` };
  }
  return { code: "ai_upstream_failed", message: `大模型调用失败（HTTP ${status}）` };
}

async function callChat(query: string, hits: RetrieveHit[], chat: ChatConfig): Promise<string> {
  const base = chat.baseUrl.replace(/\/$/, "");
  const url = `${base}/chat/completions`;
  const numbered = hits
    .map(
      (h, i) =>
        `【${i + 1}】《${h.title}》 note_id=${h.note_id} source_block_id=${h.source_block_id}\n${h.text}`,
    )
    .join("\n\n");
  let res: Response;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60000);
    res = await (chat.fetch ?? fetch)(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${chat.apiKey}`,
      },
      body: JSON.stringify({
        model: chat.model || "gpt-4o-mini",
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content:
              "你是笔记中枢的只读问答助手。只能根据提供的笔记片段作答，使用中文 Markdown。必须能对应片段编号，禁止编造片段中没有的事实。若片段无法回答，只回复：不知道",
          },
          {
            role: "user",
            content: `问题：${query}\n\n笔记片段：\n${numbered}\n\n请作答；文中用【编号】标出依据。`,
          },
        ],
      }),
      signal: ctrl.signal,
    }).finally(() => clearTimeout(timer));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/abort/i.test(msg)) {
      throw new ChatUpstreamError("大模型请求超时，请稍后重试或检查 Base URL", "ai_timeout");
    }
    throw new ChatUpstreamError(
      `无法连接大模型：${msg.slice(0, 160) || "网络错误"}`,
      "ai_network_failed",
    );
  }
  const raw = await res.text();
  if (!res.ok) {
    const { message, code } = friendlyUpstreamMessage(res.status, raw);
    throw new ChatUpstreamError(message, code, res.status);
  }
  let data: { choices?: { message?: { content?: string } }[] };
  try {
    data = JSON.parse(raw) as { choices?: { message?: { content?: string } }[] };
  } catch {
    throw new ChatUpstreamError("大模型返回了无法解析的响应", "ai_bad_response", res.status);
  }
  return data.choices?.[0]?.message?.content ?? "";
}

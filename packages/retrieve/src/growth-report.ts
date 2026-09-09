import { ChatUpstreamError, shortAiError, type ChatConfig } from "./answer.ts";

export type GrowthAiNote = {
  id: string;
  title: string;
  path?: string;
  markdown?: string | null;
};

export type GrowthAiReportResult = {
  markdown: string;
  mode: "ai";
  ai_failed?: boolean;
  ai_error?: string;
};

const PER_NOTE_CAP = 900;
const TOTAL_NOTES_CAP = 12_000;
const DRAFT_CAP = 8_000;

/** Trim note body for the prompt — prefer start of markdown. */
export function clipNoteExcerpt(markdown: string | null | undefined, cap = PER_NOTE_CAP): string {
  const raw = (markdown ?? "").replace(/\r\n/g, "\n").trim();
  if (!raw) return "（无正文）";
  if (raw.length <= cap) return raw;
  return `${raw.slice(0, Math.max(0, cap - 1))}…`;
}

function buildNotesBlock(notes: GrowthAiNote[]): string {
  const parts: string[] = [];
  let used = 0;
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i]!;
    const excerpt = clipNoteExcerpt(n.markdown);
    const pathBit = n.path ? ` path=${n.path}` : "";
    const block = `### ${i + 1}. 《${n.title || n.id}》 id=${n.id}${pathBit}\n${excerpt}`;
    if (used + block.length > TOTAL_NOTES_CAP && parts.length) break;
    parts.push(block);
    used += block.length;
  }
  return parts.length ? parts.join("\n\n") : "（本时段无可用笔记摘录）";
}

/**
 * Warm Chinese growth report from template draft + selected note excerpts.
 * Throws ChatUpstreamError on upstream failure (caller maps to draft + ai_failed).
 */
export async function composeGrowthAiReport(
  draftMarkdown: string,
  notes: GrowthAiNote[],
  chat: ChatConfig,
): Promise<string> {
  if (!chat?.baseUrl || !chat?.apiKey) {
    throw new ChatUpstreamError("未配置 AI（缺少 Base URL 或 API Key）", "ai_auth_failed");
  }
  const draft = (draftMarkdown ?? "").trim().slice(0, DRAFT_CAP) || "（底稿为空）";
  const notesBlock = buildNotesBlock(notes);
  const base = chat.baseUrl.replace(/\/$/, "");
  const url = `${base}/chat/completions`;
  let res: Response;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 90_000);
    res = await (chat.fetch ?? fetch)(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${chat.apiKey}`,
      },
      body: JSON.stringify({
        model: chat.model || "gpt-4o-mini",
        temperature: 0.55,
        messages: [
          {
            role: "system",
            content:
              "你是笔记中枢的成长报告助手。使用温暖、可读的中文 Markdown 撰写成长报告。\n" +
              "中枢只读，不写回任何源；不要编造底稿或笔记中没有的事件、日期或细节。\n" +
              "可基于底稿结构重组与润色，结合所选笔记摘录补充语境与感受，语气真诚而不夸张。\n" +
              "可用 Markdown 标题、列表与短段落；不要在文末堆「来源清单」或脚注编号列表。\n" +
              "不要伪称写回了日记或修改了源笔记。",
          },
          {
            role: "user",
            content:
              `请基于以下「底稿」与「所选笔记摘录」写一篇成长报告。\n\n` +
              `## 底稿\n${draft}\n\n` +
              `## 所选笔记摘录\n${notesBlock}\n\n` +
              `请直接输出报告正文（Markdown）。`,
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
    // Reuse Ask-friendly codes via shortAiError by throwing structured errors
    let detail = "";
    let code = "ai_upstream_failed";
    try {
      const j = JSON.parse(raw) as {
        error?: { message?: string; code?: string; type?: string };
        message?: string;
      };
      detail = (j?.error?.message || j?.message || "").trim();
      const ec = (j?.error?.code || j?.error?.type || "").toLowerCase();
      if (
        res.status === 402 ||
        /insufficient|quota|credit|余额|积分/.test(detail) ||
        /insufficient|quota|credit/.test(ec)
      ) {
        code = "ai_quota_exceeded";
      } else if (
        res.status === 401 ||
        res.status === 403 ||
        /invalid.?key|unauthorized|authentication/.test(detail + ec)
      ) {
        code = "ai_auth_failed";
      }
    } catch {
      /* ignore */
    }
    const message =
      code === "ai_quota_exceeded"
        ? detail
          ? `大模型额度不足：${detail.slice(0, 180)}`
          : "大模型额度不足，请到 AI 服务商控制台充值后再试"
        : code === "ai_auth_failed"
          ? detail
            ? `AI 鉴权失败：${detail.slice(0, 180)}`
            : "AI 鉴权失败，请检查设置里的 API Key"
          : detail
            ? `大模型调用失败（HTTP ${res.status}）：${detail.slice(0, 180)}`
            : `大模型调用失败（HTTP ${res.status}）`;
    throw new ChatUpstreamError(message, code, res.status);
  }
  let data: { choices?: { message?: { content?: string } }[] };
  try {
    data = JSON.parse(raw) as { choices?: { message?: { content?: string } }[] };
  } catch {
    throw new ChatUpstreamError("大模型返回了无法解析的响应", "ai_bad_response", res.status);
  }
  const content = (data.choices?.[0]?.message?.content ?? "").trim();
  if (!content) {
    throw new ChatUpstreamError("大模型返回了空内容", "ai_bad_response", res.status);
  }
  return content;
}

/** Map upstream failure into a soft AI result (never throw for UI). */
export function growthAiFailure(
  draftMarkdown: string,
  err: unknown,
): GrowthAiReportResult {
  if (err instanceof ChatUpstreamError) {
    return {
      markdown: draftMarkdown,
      mode: "ai",
      ai_failed: true,
      ai_error: shortAiError(err),
    };
  }
  const msg = err instanceof Error ? err.message : String(err);
  return {
    markdown: draftMarkdown,
    mode: "ai",
    ai_failed: true,
    ai_error: msg.slice(0, 48) || "AI 未能生成",
  };
}

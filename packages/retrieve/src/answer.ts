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
  const used = uniqueRetrieveHits(hits).slice(0, 12);
  const lines: string[] = [`根据当前空间笔记，与「${query.trim()}」相关的参考如下（摘录，供进一步理解）：`, ""];
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
 * Unique hits in stable order — same keying as citationsFromHits.
 * Chat prompt numbering and returned citations MUST share this list.
 */
export function uniqueRetrieveHits(hits: RetrieveHit[]): RetrieveHit[] {
  const seen = new Set<string>();
  const out: RetrieveHit[] = [];
  for (const h of hits) {
    const key = `${h.note_id}#${h.source_block_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(h);
  }
  return out;
}

/** True if a line looks like a footnote / sources-list entry (【n】…). */
function isCiteListingLine(line: string): boolean {
  const t = line.trim();
  if (!t) return true;
  if (/^(?:[-*•]|\d+[.)、])?\s*【\d+】/.test(t)) return true;
  if (/^(?:【\d+】\s*)+$/.test(t)) return true;
  // Short 【n】… listing row (title / quote stub), not a full prose sentence
  if (/^【\d+】/.test(t) && t.length < 120) return true;
  return false;
}

function isMostlyCiteListing(lines: string[]): boolean {
  const nonempty = lines.filter((l) => l.trim());
  if (!nonempty.length) return true;
  const listing = nonempty.filter((l) => isCiteListingLine(l));
  return listing.length / nonempty.length >= 0.6;
}

/**
 * Remove trailing 来源/参考/参考文献 blocks (and bare 【n】 listing runs) that
 * duplicate the UI sources panel. Inline mid-sentence 【n】 are preserved.
 */
function stripTrailingCiteDump(markdown: string): string {
  const lines = markdown.split("\n");
  let cutAt = lines.length;

  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]!.trim();
    if (/^(#{1,3}\s*)?(?:来源|参考资料|参考文献|参考|Sources|References)\s*[:：]?$/i.test(t)) {
      const rest = lines.slice(i + 1);
      if (isMostlyCiteListing(rest)) {
        cutAt = i;
        break;
      }
    }
  }

  if (cutAt === lines.length) {
    // Trailing run of ≥2 cite-listing lines (no heading)
    let j = lines.length - 1;
    while (j >= 0 && !lines[j]!.trim()) j--;
    const end = j;
    while (j >= 0 && lines[j]!.trim() && isCiteListingLine(lines[j]!)) {
      j--;
      while (j >= 0 && !lines[j]!.trim()) j--;
    }
    let start = j + 1;
    while (start < lines.length && !lines[start]!.trim()) start++;
    const listing = lines.slice(start, end + 1).filter((l) => l.trim());
    if (
      listing.length >= 2 &&
      listing.every((l) => isCiteListingLine(l)) &&
      start > 0
    ) {
      cutAt = start;
      while (cutAt > 0 && !lines[cutAt - 1]!.trim()) cutAt--;
    }
  }

  return lines.slice(0, cutAt).join("\n");
}

/**
 * Deterministic post-process for LLM answers:
 * - normalize common cite variants to 【n】
 * - drop 【k】 outside 1..N (and orphan fake footnote lines)
 * - strip trailing 来源/参考 dumps that duplicate the UI sources panel
 * - optionally repack cited hits to dense 1..M so UI never shows gaps
 */
export function sanitizeAnswerCitations(
  markdown: string,
  citations: AskCitation[],
): { answer_markdown: string; citations: AskCitation[] } {
  const N = citations.length;
  let text = (markdown ?? "").replace(/\r\n/g, "\n");
  if (!text.trim()) {
    return { answer_markdown: text.trim(), citations: N ? citations : [] };
  }

  // Normalize spaced / fullwidth / square-bracket cite-like forms → 【n】
  text = text.replace(/【\s*(\d{1,2})\s*】/g, (_m, d: string) => `【${Number(d)}】`);
  text = text.replace(/［\s*(\d{1,2})\s*］/g, (_m, d: string) => `【${Number(d)}】`);
  // [7] but not markdown links [label](url)
  text = text.replace(/(?<![\w`\\])\[(\d{1,2})\](?!\()/g, (_m, d: string) => `【${Number(d)}】`);

  // Drop trailing 「来源/参考」 dumps (AI often appends a sources list under the answer).
  // Keep inline mid-sentence 【n】; only strip end blocks that are mostly listing lines.
  text = stripTrailingCiteDump(text);

  if (N <= 0) {
    text = text.replace(/【\d+】/g, "");
  } else {
    text = text.replace(/【(\d+)】/g, (m, d: string) => {
      const k = Number(d);
      return k >= 1 && k <= N ? m : "";
    });
  }

  // Strip junk footnote lines that are only a bare integer 1..99
  text = text
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      if (!/^\d{1,2}$/.test(t)) return true;
      const k = Number(t);
      return !(k >= 1 && k <= 99);
    })
    .join("\n");

  // Collapse leftovers after removals
  text = text.replace(/[ \t]{2,}/g, " ");
  text = text.replace(/[ \t]+\n/g, "\n");
  text = text.replace(/\n{3,}/g, "\n\n");
  text = text.replace(/([，、；：,;:])\s*\1+/g, "$1");
  text = text.replace(/([。！？])\s*\1+/g, "$1");
  text = text.replace(/\s+([，、；：。！？,.;:!?])/g, "$1");
  text = text.trim();

  if (N <= 0) {
    return { answer_markdown: text, citations: [] };
  }

  // Repack: dense 1..M for cited hits only (first-appearance order)
  const citedOrder: number[] = [];
  const seen = new Set<number>();
  for (const m of text.matchAll(/【(\d+)】/g)) {
    const k = Number(m[1]);
    if (k >= 1 && k <= N && !seen.has(k)) {
      seen.add(k);
      citedOrder.push(k);
    }
  }

  if (!citedOrder.length) {
    // No inline cites — keep full list for source chips
    return { answer_markdown: text, citations };
  }

  const oldToNew = new Map<number, number>();
  citedOrder.forEach((old, i) => oldToNew.set(old, i + 1));
  text = text.replace(/【(\d+)】/g, (_m, d: string) => {
    const neu = oldToNew.get(Number(d));
    return neu ? `【${neu}】` : "";
  });

  const packed = citedOrder.map((old) => citations[old - 1]!);
  return { answer_markdown: text, citations: packed };
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
  const promptHits = uniqueRetrieveHits(hits);
  try {
    const md = await callChat(query, promptHits, chat);
    const trimmed = md.trim();
    if (!trimmed || trimmed === UNKNOWN_ANSWER) {
      return { answer_markdown: UNKNOWN_ANSWER, citations: [], unknown: true, mode: "ai" };
    }
    const citations = citationsFromHits(promptHits);
    const sanitized = sanitizeAnswerCitations(trimmed, citations);
    return {
      answer_markdown: sanitized.answer_markdown,
      citations: sanitized.citations,
      mode: "ai",
    };
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
        temperature: 0.4,
        messages: [
          {
            role: "system",
            content:
              "你是笔记中枢的只读问答助手。使用中文 Markdown 作答。\n" +
              "笔记片段是参考材料，用来辅助思考与作答，不是唯一合法答案来源，也不是闭卷考试。\n" +
              "请综合片段中的观点、语境，并结合合理常识给出有帮助的回答；可以适度推理与概括。\n" +
              "优先呼应、引用相关片段：文中只能用提供列表里的【编号】标出依据（例如【1】），禁止编造超出列表的编号，也不要另起脚注数字行。\n" +
              "不要在文末另列「来源/参考文献」清单，来源由界面展示。\n" +
              "片段若只是提问、残缺或弱相关，仍应尽力给出有用回答，并可说明「依据笔记较少，以下结合相关讨论与一般理解」。\n" +
              "不要因为片段里没有「标准定义句」就拒绝回答。\n" +
              "仅当片段与问题完全无关、且无法形成任何有意义回答时，才回复：不知道。\n" +
              "不要编造不存在的笔记标题或编号；一般常识可以写，但勿伪称来自某条笔记。",
          },
          {
            role: "user",
            content: `问题：${query}\n\n参考笔记片段：\n${numbered}\n\n请结合上述参考作答（参考而非唯一依据）；有依据处用【编号】标出。`,
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

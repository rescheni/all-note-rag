import { UNKNOWN_ANSWER, type RetrieveHit } from "./hybrid.ts";

export type AskCitation = {
  note_id: string;
  block_id: string;
  source_block_id: string;
  title: string;
  quote: string;
  preview_url: string;
};

export type AskResponse = {
  answer_markdown: string;
  citations: AskCitation[];
  unknown?: true;
};

export type ChatConfig = {
  baseUrl: string;
  apiKey: string;
  model?: string;
  fetch?: typeof fetch;
};

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
    });
  }
  return out;
}

export function composeExtractiveAnswer(query: string, hits: RetrieveHit[]): AskResponse {
  if (!hits.length) {
    return { unknown: true, answer_markdown: UNKNOWN_ANSWER, citations: [] };
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
  };
}

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
    if (!trimmed || trimmed === UNKNOWN_ANSWER) return extractive;
    return { answer_markdown: trimmed, citations: extractive.citations };
  } catch {
    return extractive;
  }
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
  const res = await (chat.fetch ?? fetch)(url, {
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
  });
  if (!res.ok) throw new Error("chat failed");
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return data.choices?.[0]?.message?.content ?? "";
}

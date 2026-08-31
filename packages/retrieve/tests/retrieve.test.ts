import { describe, expect, it } from "vitest";
import {
  hybridRetrieve,
  loadChunksViaSql,
  composeExtractiveAnswer,
  composeAskAnswer,
  UNKNOWN_ANSWER,
  type RetrieveChunk,
} from "../src/index.ts";

const SPACE = "space-a";

const corpus: RetrieveChunk[] = [
  {
    space_id: SPACE,
    note_id: "n-sleep",
    title: "睡眠回顾",
    text: "今晚十一点入睡，起床后精神尚可。",
    source_block_id: "sleep-para",
  },
  {
    space_id: SPACE,
    note_id: "n-shop",
    title: "购物清单",
    text: "牛奶、鸡蛋、面包。",
    source_block_id: "shop-list",
  },
  {
    space_id: SPACE,
    note_id: "n-diary",
    title: "日记",
    text: "关于睡眠质量的记录：少咖啡。",
    source_block_id: "diary-para",
  },
  {
    space_id: "other-space",
    note_id: "n-leak",
    title: "睡眠回顾",
    text: "其他空间的秘密睡眠笔记。",
    source_block_id: "leak-para",
  },
];

describe("hybridRetrieve", () => {
  it("empty query is unknown", async () => {
    const r = await hybridRetrieve(SPACE, "   ", { chunks: corpus });
    expect(r.unknown).toBe(true);
    expect(r.hits).toEqual([]);
  });

  it("no hits is unknown", async () => {
    const r = await hybridRetrieve(SPACE, "量子引力波", { chunks: corpus });
    expect(r.unknown).toBe(true);
    expect(r.hits).toEqual([]);
  });

  it("ranks title match above body-only chunk match", async () => {
    const r = await hybridRetrieve(SPACE, "睡眠", { chunks: corpus });
    expect(r.unknown).toBe(false);
    expect(r.hits[0]?.note_id).toBe("n-sleep");
    expect(r.hits.map((h) => h.note_id)).toContain("n-diary");
    expect(r.hits.map((h) => h.note_id)).not.toContain("n-shop");
  });

  it("never leaks other spaces", async () => {
    const r = await hybridRetrieve(SPACE, "睡眠", { chunks: corpus });
    expect(r.hits.every((h) => h.space_id === SPACE)).toBe(true);
    expect(r.hits.map((h) => h.note_id)).not.toContain("n-leak");
  });

  it("optional note_ids restricts retrieval", async () => {
    const r = await hybridRetrieve(SPACE, "睡眠", { chunks: corpus, noteIds: ["n-diary"] });
    expect(r.unknown).toBe(false);
    expect(r.hits).toHaveLength(1);
    expect(r.hits[0]?.note_id).toBe("n-diary");
  });

  it("citations carry source_block_id and preview hash", async () => {
    const r = await hybridRetrieve(SPACE, "睡眠", { chunks: corpus });
    const hit = r.hits[0];
    expect(hit?.source_block_id).toBe("sleep-para");
    expect(hit?.block_id).toBe("sleep-para");
    expect(hit?.preview_url).toBe("/notes/n-sleep#b-sleep-para");
    expect(hit?.quote).toContain("入睡");
  });
});

describe("composeExtractiveAnswer", () => {
  it("unknown when no hits", () => {
    const out = composeExtractiveAnswer("睡眠", []);
    expect(out.unknown).toBe(true);
    expect(out.answer_markdown).toBe(UNKNOWN_ANSWER);
    expect(out.citations).toEqual([]);
  });

  it("quotes best chunks in Chinese framing with citations", async () => {
    const r = await hybridRetrieve(SPACE, "睡眠", { chunks: corpus });
    const out = composeExtractiveAnswer("睡眠", r.hits);
    expect(out.unknown).toBeUndefined();
    expect(out.answer_markdown).toContain("根据当前空间笔记");
    expect(out.answer_markdown).toContain("睡眠回顾");
    expect(out.answer_markdown).toContain("入睡");
    expect(out.citations[0]?.note_id).toBe("n-sleep");
    expect(out.citations[0]?.source_block_id).toBe("sleep-para");
    expect(out.citations[0]?.preview_url).toBe("/notes/n-sleep#b-sleep-para");
  });
});

describe("composeAskAnswer", () => {
  it("stays extractive without API keys", async () => {
    const r = await hybridRetrieve(SPACE, "睡眠", { chunks: corpus });
    const out = await composeAskAnswer("睡眠", r.hits);
    expect(out.answer_markdown).toContain("根据当前空间笔记");
    expect(out.citations.length).toBeGreaterThan(0);
  });

  it("uses chat when configured and keeps retrieval citations", async () => {
    const r = await hybridRetrieve(SPACE, "睡眠", { chunks: corpus });
    const fakeFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "你十一点入睡。【1】" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const out = await composeAskAnswer("睡眠", r.hits, {
      baseUrl: "https://example.test/v1",
      apiKey: "sk-test",
      fetch: fakeFetch,
    });
    expect(out.answer_markdown).toContain("十一点入睡");
    expect(out.citations[0]?.source_block_id).toBe("sleep-para");
  });

  it("falls back to extractive when chat fails", async () => {
    const r = await hybridRetrieve(SPACE, "睡眠", { chunks: corpus });
    const fakeFetch: typeof fetch = async () => new Response("nope", { status: 500 });
    const out = await composeAskAnswer("睡眠", r.hits, {
      baseUrl: "https://example.test/v1",
      apiKey: "sk-test",
      fetch: fakeFetch,
    });
    expect(out.answer_markdown).toContain("根据当前空间笔记");
  });
});

describe("loadChunksViaSql", () => {
  it("filters by space and passes FTS params", async () => {
    let sql = "";
    let params: unknown[] = [];
    const run = async (text: string, p?: unknown[]) => {
      sql = text;
      params = p ?? [];
      return {
        rows: [
          {
            note_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
            title: "睡眠回顾",
            space_id: SPACE,
            text: "今晚十一点入睡",
            heading_path: "回顾",
            block_uuid: "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee",
            source_block_id: "sleep-para",
          },
        ],
      };
    };
    const r = await hybridRetrieve(SPACE, "睡眠", { loadChunks: loadChunksViaSql(run) });
    expect(sql).toContain("n.space_id = $1");
    expect(sql).toContain("deleted_at IS NULL");
    expect(sql).toContain("to_tsquery('simple'");
    expect(params[0]).toBe(SPACE);
    expect(params[1]).toBe("%睡眠%");
    expect(r.hits[0]?.source_block_id).toBe("sleep-para");
    expect(r.hits[0]?.preview_url).toBe("/notes/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee#b-sleep-para");
  });
});

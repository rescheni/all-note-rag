import { describe, expect, it } from "vitest";
import {
  hybridRetrieve,
  loadChunksViaSql,
  loadVectorChunksViaSql,
  composeExtractiveAnswer,
  composeAskAnswer,
  UNKNOWN_ANSWER,
  embedTexts,
  cosine,
  rrfMerge,
  localProject,
  EMBEDDING_DIM,
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


describe("embed + rrf", () => {
  it("local projector is deterministic, 1536-d, L2-normalized, no network", async () => {
    const prevB = process.env.OPENAI_BASE_URL;
    const prevK = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    delete process.env.OPENAI_API_KEY;
    let fetched = false;
    const boom: typeof fetch = async () => {
      fetched = true;
      throw new Error("network");
    };
    try {
      const [a, b] = await embedTexts(["铜灯笼 pineapple", "铜灯笼 pineapple"], { fetch: boom });
      expect(fetched).toBe(false);
      expect(a).toHaveLength(EMBEDDING_DIM);
      expect(a).toEqual(b);
      expect(a).toEqual(localProject("铜灯笼 pineapple"));
      const n = Math.hypot(...a);
      expect(n).toBeCloseTo(1, 5);
      expect(cosine(a, a)).toBeCloseTo(1, 5);
      const other = localProject("zzzz-unrelated-qwerty");
      expect(cosine(a, other)).toBeLessThan(cosine(a, localProject("铜灯笼 pineapple extra")));
    } finally {
      if (prevB === undefined) delete process.env.OPENAI_BASE_URL;
      else process.env.OPENAI_BASE_URL = prevB;
      if (prevK === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prevK;
    }
  });

  it("rrfMerge boosts items that appear in both lists", () => {
    const fused = rrfMerge(
      [
        ["sem", "fts"],
        ["sem", "noise"],
      ],
      60,
    );
    expect(fused[0]?.id).toBe("sem");
    expect(fused.map((x) => x.id)).toContain("fts");
  });

  it("rrf prefers a semantically overlapping hashed-embed chunk; FTS-only still returned", async () => {
    const q = "copper lantern retrieval token";
    const prevB = process.env.OPENAI_BASE_URL;
    const prevK = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    delete process.env.OPENAI_API_KEY;
    try {
      const [qEmb, semEmb, noiseEmb] = await embedTexts([
        q,
        "copper lantern retrieval token appears in the hashed vault note",
        "zzzz qwerty unrelated embedding space",
      ]);
      const chunks: RetrieveChunk[] = [
        {
          space_id: SPACE,
          note_id: "n-sem",
          title: "语义笔记",
          text: "copper lantern retrieval token appears in the hashed vault note",
          source_block_id: "sem-block",
          embedding: semEmb,
        },
        {
          space_id: SPACE,
          note_id: "n-fts",
          title: "购物清单",
          text: "copper lantern retrieval token 牛奶鸡蛋",
          source_block_id: "fts-block",
        },
        {
          space_id: SPACE,
          note_id: "n-noise",
          title: "无关",
          text: "zzzz qwerty unrelated",
          source_block_id: "noise-block",
          embedding: noiseEmb,
        },
      ];
      const r = await hybridRetrieve(SPACE, q, { chunks, queryEmbedding: qEmb });
      expect(r.unknown).toBe(false);
      expect(r.hits[0]?.note_id).toBe("n-sem");
      expect(r.hits.map((h) => h.note_id)).toContain("n-fts");
    } finally {
      if (prevB === undefined) delete process.env.OPENAI_BASE_URL;
      else process.env.OPENAI_BASE_URL = prevB;
      if (prevK === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prevK;
    }
  });

  it("empty query unknown even with embeddings", async () => {
    const r = await hybridRetrieve(SPACE, "   ", {
      chunks: corpus,
      queryEmbedding: localProject("睡眠"),
    });
    expect(r.unknown).toBe(true);
    expect(r.hits).toEqual([]);
  });
});

describe("loadVectorChunksViaSql", () => {
  it("orders by cosine distance and keeps space ACL", async () => {
    let sql = "";
    let params: unknown[] = [];
    const run = async (text: string, p?: unknown[]) => {
      sql = text;
      params = p ?? [];
      return { rows: [] };
    };
    const load = loadVectorChunksViaSql(run);
    await load(SPACE, localProject("睡眠"), { limit: 10 });
    expect(sql).toContain("n.space_id = $1");
    expect(sql).toContain("deleted_at IS NULL");
    expect(sql).toContain("embedding <=> $2::vector");
    expect(sql).toContain("ch.embedding IS NOT NULL");
    expect(params[0]).toBe(SPACE);
    expect(typeof params[1]).toBe("string");
    expect(params[3]).toBe(10);
  });
});

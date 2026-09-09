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
  searchSourcesAndSimilar,
  similarToEmbedding,
  scoreChunk,
  type RetrieveChunk,
  type SearchCorpusNote,
} from "../src/index.ts";
import { queryContentTokens, toTsQueryTokens } from "@note-hub/core";

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

  it("falls back to extractive with ai_failed when chat fails", async () => {
    const r = await hybridRetrieve(SPACE, "睡眠", { chunks: corpus });
    const fakeFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ error: { message: "insufficient credits", code: "insufficient_user_quota" } }), {
        status: 402,
      });
    const out = await composeAskAnswer("睡眠", r.hits, {
      baseUrl: "https://example.test/v1",
      apiKey: "sk-test",
      fetch: fakeFetch,
    });
    expect(out.mode).toBe("extractive");
    expect(out.ai_failed).toBe(true);
    expect(out.ai_error).toMatch(/额度/);
    expect(out.answer_markdown).toContain("根据当前空间笔记");
    expect(out.citations.length).toBeGreaterThan(0);
  });

  it("marks mode ai when chat succeeds", async () => {
    const r = await hybridRetrieve(SPACE, "睡眠", { chunks: corpus });
    const fakeFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "模型作答【1】" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const out = await composeAskAnswer("睡眠", r.hits, {
      baseUrl: "https://example.test/v1",
      apiKey: "sk-test",
      fetch: fakeFetch,
    });
    expect(out.mode).toBe("ai");
    expect(out.answer_markdown).toContain("模型作答");
  });
});

describe("loadChunksViaSql", () => {
  it("uses content-phrase ILIKE for template questions", async () => {
    let params: unknown[] = [];
    const run = async (_text: string, p?: unknown[]) => {
      params = p ?? [];
      return { rows: [] };
    };
    await loadChunksViaSql(run)(SPACE, "什么是感情", { limit: 10 });
    expect(params[1]).toBe("%感情%");
    expect(params[2]).toBe("感情");
  });

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


describe("searchSourcesAndSimilar", () => {
  const q = "紫铜灯笼检索词";
  const qEmb = localProject(q);
  const noise = localProject("zzzz-unrelated-qwerty-noise-token");
  const fixture: SearchCorpusNote[] = [
    {
      space_id: SPACE,
      note_id: "n-source",
      title: "日记",
      path: "Daily/2026-08-29.md",
      markdown: "今天看到紫铜灯笼检索词写在门上。",
      chunks: [
        {
          text: "今天看到紫铜灯笼检索词写在门上。",
          source_block_id: "src-para",
          embedding: noise,
        },
      ],
    },
    {
      space_id: SPACE,
      note_id: "n-similar",
      title: "提灯收藏",
      path: "Collections/lantern.md",
      markdown: "牛奶鸡蛋面包购物清单，与查询无关。",
      chunks: [
        {
          text: "牛奶鸡蛋面包购物清单，与查询无关。",
          source_block_id: "sim-para",
          embedding: qEmb,
        },
      ],
    },
    {
      space_id: "other-space",
      note_id: "n-leak",
      title: "秘密",
      path: "secret.md",
      markdown: "紫铜灯笼检索词 其他空间",
      chunks: [{ text: "紫铜灯笼检索词 其他空间", embedding: qEmb }],
    },
  ];

  it("puts keyword hit in results and a different embedded note in similar, not duplicated", () => {
    const out = searchSourcesAndSimilar(SPACE, q, fixture, { queryEmbedding: qEmb });
    expect(out.query).toBe(q);
    expect(out.results.map((r) => r.note_id)).toEqual(["n-source"]);
    expect(out.results[0]?.path).toBe("Daily/2026-08-29.md");
    expect(out.results[0]?.match).toBe("keyword");
    expect(out.results[0]?.preview_url).toContain("/notes/n-source");
    expect(out.similar.map((s) => s.note_id)).toEqual(["n-similar"]);
    expect(out.similar[0]?.path).toBe("Collections/lantern.md");
    expect(out.similar[0]?.score).toBeGreaterThan(0.5);
    const ids = [...out.results, ...out.similar].map((x) => x.note_id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain("n-leak");
  });

  it("path match is tagged path and similar is empty without embeddings", () => {
    const out = searchSourcesAndSimilar(SPACE, "Daily/2026", fixture);
    expect(out.results[0]?.note_id).toBe("n-source");
    expect(out.results[0]?.match).toBe("path");
    expect(out.similar).toEqual([]);
  });

  it("never leaks other spaces via similarToEmbedding", () => {
    const hits = similarToEmbedding(SPACE, qEmb, fixture, { excludeIds: ["n-source"] });
    expect(hits.map((h) => h.note_id)).toEqual(["n-similar"]);
  });
});


describe("embedTexts settings endpoint", () => {
  it("uses runtime baseUrl+apiKey even when env is empty", async () => {
    const prevB = process.env.OPENAI_BASE_URL;
    const prevK = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    delete process.env.OPENAI_API_KEY;
    let hit = "";
    let auth = "";
    const fake: typeof fetch = async (input, init) => {
      hit = String(input);
      auth = new Headers(init?.headers).get("authorization") ?? "";
      const emb = new Array(EMBEDDING_DIM).fill(0.01);
      return new Response(JSON.stringify({ data: [{ embedding: emb, index: 0 }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    try {
      const [v] = await embedTexts(["hello"], {
        baseUrl: "https://gateway.example/v1",
        apiKey: "sk-from-settings",
        model: "text-embedding-3-small",
        fetch: fake,
      });
      expect(hit).toBe("https://gateway.example/v1/embeddings");
      expect(auth).toBe("Bearer sk-from-settings");
      expect(v).toHaveLength(EMBEDDING_DIM);
    } finally {
      if (prevB === undefined) delete process.env.OPENAI_BASE_URL;
      else process.env.OPENAI_BASE_URL = prevB;
      if (prevK === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prevK;
    }
  });
});


describe("Chinese question template retrieval", () => {
  const zhCorpus: RetrieveChunk[] = [
    {
      space_id: SPACE,
      note_id: "n-emotion",
      title: "感情随笔",
      text: "感情是人与人之间的联结与共鸣，包含爱与信任。",
      source_block_id: "emo-para",
      embedding: localProject("感情 联结 共鸣 爱 信任"),
    },
    {
      space_id: SPACE,
      note_id: "n-lvalue",
      title: "什么是左值",
      text: "C++ 中左值是可取地址的表达式。",
      source_block_id: "lv-para",
      embedding: localProject("什么是左值 C++ 表达式"),
    },
    {
      space_id: SPACE,
      note_id: "n-protobuf",
      title: "什么是 ProtoBuf",
      text: "Protocol Buffers 是一种序列化格式。",
      source_block_id: "pb-para",
      embedding: localProject("什么是 ProtoBuf 序列化"),
    },
    {
      space_id: SPACE,
      note_id: "n-heap",
      title: "什么是堆",
      text: "堆是动态内存分配区域。",
      source_block_id: "heap-para",
      embedding: localProject("什么是堆 内存"),
    },
  ];

  it("query tokens for 什么是感情 emphasize 感情", () => {
    const tokens = queryContentTokens("什么是感情");
    expect(tokens).toEqual(["感情"]);
    expect(toTsQueryTokens("什么是感情")).toBe("感情");
  });

  it("scoreChunk: note with 感情 outranks 什么是左值 for 什么是感情", () => {
    const q = "什么是感情";
    const emo = scoreChunk(q, zhCorpus[0]!);
    const lv = scoreChunk(q, zhCorpus[1]!);
    const pb = scoreChunk(q, zhCorpus[2]!);
    expect(emo).toBeGreaterThan(lv);
    expect(emo).toBeGreaterThan(pb);
    expect(lv).toBe(0);
    expect(pb).toBe(0);
  });

  it("hybridRetrieve prefers 感情 note over template-only tech notes", async () => {
    const q = "什么是感情";
    const qEmb = localProject(q);
    const r = await hybridRetrieve(SPACE, q, { chunks: zhCorpus, queryEmbedding: qEmb });
    expect(r.unknown).toBe(false);
    expect(r.hits[0]?.note_id).toBe("n-emotion");
    expect(r.hits.map((h) => h.note_id)).not.toContain("n-lvalue");
    expect(r.hits.map((h) => h.note_id)).not.toContain("n-protobuf");
    expect(r.hits.map((h) => h.note_id)).not.toContain("n-heap");
  });

  it("searchSourcesAndSimilar ranks 感情 above 什么是左值", () => {
    const notes: SearchCorpusNote[] = zhCorpus.map((c) => ({
      space_id: c.space_id,
      note_id: c.note_id,
      title: c.title,
      path: `${c.note_id}.md`,
      markdown: c.text,
      chunks: [{ text: c.text, source_block_id: c.source_block_id, embedding: c.embedding }],
    }));
    const out = searchSourcesAndSimilar(SPACE, "什么是感情", notes);
    expect(out.results[0]?.note_id).toBe("n-emotion");
    expect(out.results.map((r) => r.note_id)).not.toContain("n-lvalue");
  });

  it("drops vector-only template/unrelated notes when content tokens present", async () => {
    const q = "什么是感情";
    const qEmb = localProject(q);
    const techOnly: RetrieveChunk[] = [
      {
        space_id: SPACE,
        note_id: "n-lvalue",
        title: "什么是左值",
        text: "C++ 中左值是可取地址的表达式。",
        source_block_id: "lv-para",
        embedding: localProject("什么是左值 C++ 表达式"),
      },
      {
        space_id: SPACE,
        note_id: "n-kitex",
        title: "「Hertz｜Kitex 高性能的秘密#1」",
        text: "Kitex 是字节跳动的 Go RPC 框架，和 protobuf 搭配使用。",
        source_block_id: "kx-para",
        // Pure semantic: no 什么是 template tokens in title/body tokenization path needed —
        // embedding ranks it for the query but content token 感情 is absent.
        embedding: qEmb,
      },
      {
        space_id: SPACE,
        note_id: "n-gorm",
        title: "go web rpc grom",
        text: "Gorm 是 Go 的 ORM，和 Kitex 无关的技术笔记。",
        source_block_id: "gm-para",
        embedding: localProject("gorm kitex protobuf stack"),
      },
    ];
    const r = await hybridRetrieve(SPACE, q, { chunks: techOnly, queryEmbedding: qEmb });
    expect(r.unknown).toBe(true);
    expect(r.hits).toEqual([]);
  });

  it("keeps vector hit only when it shares content tokens", async () => {
    const q = "什么是感情";
    const qEmb = localProject(q);
    const mixed: RetrieveChunk[] = [
      {
        space_id: SPACE,
        note_id: "n-kitex",
        title: "Kitex",
        text: "RPC 框架说明，与本题无关。",
        source_block_id: "kx-para",
        embedding: qEmb,
      },
      {
        space_id: SPACE,
        note_id: "n-emotion",
        title: "日记",
        text: "今天想到感情是信任与共鸣。",
        source_block_id: "emo-para",
        embedding: localProject("无关向量"),
      },
    ];
    const r = await hybridRetrieve(SPACE, q, { chunks: mixed, queryEmbedding: qEmb });
    expect(r.unknown).toBe(false);
    expect(r.hits.map((h) => h.note_id)).toEqual(["n-emotion"]);
  });
});

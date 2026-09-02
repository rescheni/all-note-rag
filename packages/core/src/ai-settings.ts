import { decryptSecret, encryptSecret } from "./secrets.ts";

export const HUB_AI_SETTING_ID = "ai";
export const DEFAULT_CHAT_MODEL = "gpt-4o-mini";
export const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";

export type PublicAiSettings = {
  configured: boolean;
  base_url: string;
  embedding_model: string;
  chat_model: string;
};

export type ResolvedAiSettings = PublicAiSettings & {
  api_key: string;
};

type Sql = (
  text: string,
  params?: unknown[],
) => Promise<{ rows: Record<string, unknown>[] }>;

function envFallback(): { base_url: string; api_key: string; embedding_model: string; chat_model: string } {
  return {
    base_url: process.env.OPENAI_BASE_URL?.trim() ?? "",
    api_key: process.env.OPENAI_API_KEY?.trim() ?? "",
    embedding_model: process.env.EMBEDDING_MODEL?.trim() || DEFAULT_EMBEDDING_MODEL,
    chat_model: process.env.CHAT_MODEL?.trim() || DEFAULT_CHAT_MODEL,
  };
}

export function publicAiSettings(s: ResolvedAiSettings): PublicAiSettings {
  return {
    configured: s.configured,
    base_url: s.base_url,
    embedding_model: s.embedding_model,
    chat_model: s.chat_model,
  };
}

/** Runtime AI endpoint: UI row first, process.env as fallback. Never log the key. */
export async function loadAiSettings(query: Sql, hubSecret: string): Promise<ResolvedAiSettings> {
  const fb = envFallback();
  let row: {
    base_url?: unknown;
    embedding_model?: unknown;
    chat_model?: unknown;
    secrets_ref?: unknown;
  } | undefined;
  try {
    const r = await query(
      `SELECT base_url, embedding_model, chat_model, secrets_ref FROM hub_settings WHERE id = $1`,
      [HUB_AI_SETTING_ID],
    );
    row = r.rows[0];
  } catch {
    row = undefined;
  }
  let storedKey = "";
  const ref = typeof row?.secrets_ref === "string" ? row.secrets_ref : "";
  if (ref) {
    try {
      const s = await query(`SELECT ciphertext FROM secrets WHERE id = $1`, [ref]);
      const blob = typeof s.rows[0]?.ciphertext === "string" ? s.rows[0].ciphertext : "";
      if (blob) {
        const json = JSON.parse(decryptSecret(blob, hubSecret)) as { api_key?: unknown };
        if (typeof json.api_key === "string") storedKey = json.api_key.trim();
      }
    } catch {
      storedKey = "";
    }
  }
  const base_url = (typeof row?.base_url === "string" ? row.base_url.trim() : "") || fb.base_url;
  const embedding_model =
    (typeof row?.embedding_model === "string" ? row.embedding_model.trim() : "") || fb.embedding_model;
  const chat_model = (typeof row?.chat_model === "string" ? row.chat_model.trim() : "") || fb.chat_model;
  const api_key = storedKey || fb.api_key;
  return {
    configured: Boolean(base_url && api_key),
    base_url,
    embedding_model,
    chat_model,
    api_key,
  };
}

export async function saveAiSettings(
  query: Sql,
  hubSecret: string,
  patch: {
    base_url?: string;
    api_key?: string;
    embedding_model?: string;
    chat_model?: string;
  },
): Promise<ResolvedAiSettings> {
  const current = await loadAiSettings(query, hubSecret);
  const base_url = patch.base_url !== undefined ? patch.base_url.trim() : current.base_url;
  const embedding_model =
    patch.embedding_model !== undefined ? patch.embedding_model.trim() : current.embedding_model;
  const chat_model = patch.chat_model !== undefined ? patch.chat_model.trim() : current.chat_model;
  const nextKey = patch.api_key !== undefined && patch.api_key.trim() ? patch.api_key.trim() : current.api_key;

  let secretsRef: string | null = null;
  const existing = await query(`SELECT secrets_ref FROM hub_settings WHERE id = $1`, [HUB_AI_SETTING_ID]);
  const prevRef =
    typeof existing.rows[0]?.secrets_ref === "string" ? (existing.rows[0].secrets_ref as string) : "";

  if (nextKey) {
    const blob = encryptSecret(JSON.stringify({ api_key: nextKey }), hubSecret);
    if (prevRef) {
      await query(`UPDATE secrets SET ciphertext = $2 WHERE id = $1`, [prevRef, blob]);
      secretsRef = prevRef;
    } else {
      const ins = await query(`INSERT INTO secrets (ciphertext) VALUES ($1) RETURNING id`, [blob]);
      secretsRef = typeof ins.rows[0]?.id === "string" ? ins.rows[0].id : null;
    }
  } else if (prevRef) {
    secretsRef = prevRef;
  }

  await query(
    `INSERT INTO hub_settings (id, base_url, embedding_model, chat_model, secrets_ref, updated_at)
     VALUES ($1,$2,$3,$4,$5,now())
     ON CONFLICT (id) DO UPDATE SET
       base_url = EXCLUDED.base_url,
       embedding_model = EXCLUDED.embedding_model,
       chat_model = EXCLUDED.chat_model,
       secrets_ref = EXCLUDED.secrets_ref,
       updated_at = now()`,
    [HUB_AI_SETTING_ID, base_url, embedding_model, chat_model, secretsRef],
  );

  return {
    configured: Boolean(base_url && nextKey),
    base_url,
    embedding_model,
    chat_model,
    api_key: nextKey,
  };
}

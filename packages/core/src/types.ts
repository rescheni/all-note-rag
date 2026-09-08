export type SpaceKind = "personal" | "team";
export type MemberRole = "owner" | "editor" | "viewer";
export const SOURCE_KINDS = ["obsidian", "siyuan", "notion", "feishu"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];
export type ConnectionStatus = "active" | "paused" | "error" | "encrypted_unreadable";
export type ChangeType = "upsert" | "delete";
export type BlockType =
  | "heading"
  | "para"
  | "list"
  | "code"
  | "quote"
  | "table"
  | "embed"
  | "unknown";
export type LinkKind = "ref" | "embed" | "url" | "mention";

export type Change = {
  type: ChangeType;
  source_id: string;
  path?: string;
  etag?: string;
  source_updated_at?: string;
  /** Dejavu object-chunk count for this file, when known. */
  chunk_count?: number;
};

export type ContactsSyncSnapshot = {
  last_at: string;
  pulled: number;
  matched: number;
  added: number;
  skipped: number;
  already_member: number;
  error?: string;
};

export type ConnectionConfig = {
  bucket?: string;
  region?: string;
  remote_prefix?: string;
  endpoint?: string;
  ignore?: string[];
  e2ee?: boolean;
  force_path_style?: boolean;
  kernel_base_url?: string;
  notebook_ids?: string[];
  workspace_prefix?: string;
  official_s3?: boolean;
  workspace_id?: string;
  wiki_space_id?: string;
  /** Wiki node token or https://xxx.feishu.cn/wiki/TOKEN page URL. */
  wiki_node_token?: string;
  obj_types?: string[];
  mode?: string;
  /** Last Feishu contacts sync tallies. Never contains tokens or emails. */
  contacts_sync?: ContactsSyncSnapshot;
};

export type ConnectionRecord = {
  id: string;
  space_id: string;
  source: SourceKind;
  name: string;
  config: ConnectionConfig;
  secrets_ref: string | null;
  cursor: Record<string, unknown> | null;
  mode: string | null;
  status: ConnectionStatus;
  last_sync_at: string | null;
  last_error: string | null;
};

export type ConnectionSecrets = {
  access_key?: string;
  secret_key?: string;
  token?: string;
  access_token?: string;
  user_access_token?: string;
  refresh_token?: string;
  app_id?: string;
  app_secret?: string;
  /** OAuth scope string returned by Feishu token exchange. */
  scope?: string;
  /** ISO time when access_token / user_access_token expires (from expires_in). */
  access_token_expires_at?: string;
  /** ISO time when refresh_token expires (from refresh_token_expires_in). */
  refresh_token_expires_at?: string;
  repo_password?: string;
};

export type AdapterContext = {
  connection: ConnectionRecord;
  secrets: ConnectionSecrets | null;
  cursor: Record<string, unknown> | null;
  /** Full object key when doing file-level sync (skip ListObjects). */
  objectKey?: string;
  /** Persist rotated OAuth tokens; never log the payload. */
  persistSecrets?: (secrets: ConnectionSecrets) => Promise<void>;
  /** Re-read secrets from storage (Feishu refresh_token is single-use). */
  reloadSecrets?: () => Promise<ConnectionSecrets | null>;
  /** Serialize refresh+persist across API/worker for one connection. */
  withSecretsLock?: <T>(fn: () => Promise<T>) => Promise<T>;
};

export type ProbeResult = {
  ok: boolean;
  status?: ConnectionStatus;
  message?: string;
  code?: string;
};

export type AssetRef = {
  path: string;
  contentType?: string;
  bytes?: Uint8Array;
  etag?: string;
};

export type NotePayload = {
  source_id: string;
  path: string;
  title: string;
  raw: string | Uint8Array;
  assets?: AssetRef[];
  etag?: string;
  source_updated_at?: string;
  acl?: Record<string, unknown>;
  /** Lightweight file/image note (not a markdown/docx document). */
  kind?: "note" | "asset";
};

export type NormalizedBlock = {
  source_block_id: string;
  type: BlockType;
  text: string;
  markdown: string;
  order_key: string;
  depth: number;
  parent_source_block_id?: string;
};

export type NormalizedLink = {
  kind: LinkKind;
  raw: string;
  to_source_id?: string;
  to_path?: string;
  from_source_block_id?: string;
};

export type NormalizedAsset = {
  source_path: string;
  content_type?: string;
  bytes: Uint8Array;
  hash: string;
};

export type NormalizedNote = {
  source_id: string;
  path: string;
  title: string;
  markdown: string;
  frontmatter: Record<string, unknown>;
  hash: string;
  blocks: NormalizedBlock[];
  links: NormalizedLink[];
  assets: NormalizedAsset[];
};

export type Adapter = {
  probe(ctx: AdapterContext): Promise<ProbeResult>;
  listChanges(ctx: AdapterContext): Promise<{ changes: Change[]; nextCursor: Record<string, unknown> }>;
  fetchNote(ctx: AdapterContext, source_id: string): Promise<NotePayload | null>;
  fetchAsset(ctx: AdapterContext, ref: string): Promise<Uint8Array>;
};

export const DEFAULT_OBSIDIAN_IGNORE = [".obsidian/", ".trash/"] as const;

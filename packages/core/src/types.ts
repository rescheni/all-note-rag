export type SpaceKind = "personal" | "team";
export type MemberRole = "owner" | "editor" | "viewer";
export type SourceKind = "obsidian" | "siyuan" | "notion" | "feishu";
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
};

export type ConnectionConfig = {
  bucket: string;
  region?: string;
  remote_prefix?: string;
  endpoint?: string;
  ignore?: string[];
  e2ee?: boolean;
  force_path_style?: boolean;
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
  access_key: string;
  secret_key: string;
};

export type AdapterContext = {
  connection: ConnectionRecord;
  secrets: ConnectionSecrets | null;
  cursor: Record<string, unknown> | null;
};

export type ProbeResult = {
  ok: boolean;
  status?: ConnectionStatus;
  message?: string;
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

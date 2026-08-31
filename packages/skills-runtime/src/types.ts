export const ALLOWED_HOOKS = ["post-sync", "on-ask", "weekly-report"] as const;
export type SkillHook = (typeof ALLOWED_HOOKS)[number];

export type GrowthKind = "goal" | "habit" | "mood" | "review" | "focus";
export const GROWTH_KINDS: GrowthKind[] = ["goal", "habit", "mood", "review", "focus"];

export type SkillManifest = {
  name: string;
  description: string;
  version: string;
  hooks: SkillHook[];
  permissions: {
    spaces: "current" | "confirmed-list";
    growth?: "read" | "write";
    notes?: "read";
    network?: boolean;
  };
  tools?: string[];
};

export type HostNote = {
  id: string;
  path: string;
  title: string;
  markdown: string | null;
  frontmatter: Record<string, unknown> | null;
  hash?: string | null;
  updated_at: string;
};

export type HostGrowthEvent = {
  id?: string;
  space_id?: string;
  note_id: string | null;
  kind: GrowthKind;
  happened_at: string;
  payload: Record<string, unknown>;
};

export type WriteGrowthEvent = {
  note_id?: string | null;
  kind: GrowthKind;
  happened_at: string;
  payload?: Record<string, unknown>;
};

export type HostApi = {
  queryNotes: (opts?: { ids?: string[]; from?: string; to?: string; path?: string }) => Promise<HostNote[]>;
  queryGrowth: (opts?: { from?: string; to?: string; kinds?: GrowthKind[] }) => Promise<HostGrowthEvent[]>;
  writeGrowthEvent: (event: WriteGrowthEvent) => Promise<{ id: string; created: boolean }>;
  writeReport: (report: { range_from: string; range_to: string; markdown: string }) => Promise<{ id: string }>;
};

export type SkillRunInput = {
  space_id: string;
  hook: SkillHook;
  payload: Record<string, unknown>;
  host: HostApi;
};

export type SkillRunResult = {
  ok: boolean;
  markdown?: string;
  summary?: string;
  events_written?: number;
  extra?: Record<string, unknown>;
};

export type SkillHandler = (input: SkillRunInput) => Promise<SkillRunResult>;

export type SqlQuery = (
  text: string,
  params?: unknown[],
) => Promise<{ rows: any[]; rowCount?: number | null }>;

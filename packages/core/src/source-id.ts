export function posixVaultPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\/+/, "");
}

export function obsidianSourceId(connectionId: string, vaultPath: string): string {
  return `obsidian://${connectionId}/${posixVaultPath(vaultPath)}`;
}

export function parseObsidianSourceId(
  sourceId: string,
): { connectionId: string; path: string } | null {
  const m = /^obsidian:\/\/([^/]+)\/(.+)$/.exec(sourceId);
  if (!m) return null;
  return { connectionId: m[1], path: m[2] };
}

export function titleFromPath(vaultPath: string): string {
  const base = posixVaultPath(vaultPath).split("/").pop() ?? vaultPath;
  return base.replace(/\.md$/i, "");
}

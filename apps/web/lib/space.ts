import { api } from "./api";

export const SPACE_KEY = "hub_space_id";
export const SPACE_CHANGE_EVENT = "hub-space-change";

export type Space = { id: string; name: string; kind: string; role: string };

export function getStoredSpaceId(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(SPACE_KEY);
}

export function storeSpaceId(id: string) {
  if (typeof window === "undefined") return;
  localStorage.setItem(SPACE_KEY, id);
  window.dispatchEvent(new Event(SPACE_CHANGE_EVENT));
}

export function selectSpace(spaces: Space[]): Space | null {
  if (!spaces.length) return null;
  const stored = getStoredSpaceId();
  const found = stored ? spaces.find((s) => s.id === stored) : undefined;
  const sp = found ?? spaces[0];
  if (sp.id !== stored) storeSpaceId(sp.id);
  return sp;
}

export async function loadSpaces(): Promise<{ spaces: Space[]; current: Space | null }> {
  const data = await api<{ spaces: Space[] }>("/v1/spaces");
  return { spaces: data.spaces, current: selectSpace(data.spaces) };
}

export function spaceKindLabel(kind: string): string {
  return kind === "team" ? "团队" : "个人";
}

export function roleLabel(role: string): string {
  if (role === "owner") return "所有者";
  if (role === "editor") return "编辑";
  if (role === "viewer") return "只读";
  return role;
}

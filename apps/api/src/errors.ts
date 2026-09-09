import type { Context } from "hono";

export function jsonError(
  c: Context,
  status: 400 | 401 | 403 | 404 | 409 | 410 | 500 | 502,
  code: string,
  message: string,
) {
  return c.json({ error: { code, message } }, status);
}

export const errors = {
  unauthenticated: (c: Context) => jsonError(c, 401, "unauthenticated", "未登录"),
  forbidden: (c: Context, message = "权限不足") => jsonError(c, 403, "forbidden", message),
  notFound: (c: Context, message = "未找到") => jsonError(c, 404, "not_found", message),
  gone: (c: Context, message = "已不可用") => jsonError(c, 410, "gone", message),
  encrypted: (c: Context) =>
    jsonError(c, 409, "connection_encrypted", "该连接为端到端加密，无法读取正文"),
  syncInProgress: (c: Context) => jsonError(c, 409, "sync_in_progress", "该连接正在同步"),
  growthPersonalOnly: (c: Context) => jsonError(c, 400, "growth_personal_only", "成长分析仅用于个人空间"),
};

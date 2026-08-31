import type { Context } from "hono";

export function jsonError(
  c: Context,
  status: 400 | 401 | 403 | 404 | 409 | 500,
  code: string,
  message: string,
) {
  return c.json({ error: { code, message } }, status);
}

export const errors = {
  unauthenticated: (c: Context) => jsonError(c, 401, "unauthenticated", "未登录"),
  forbidden: (c: Context, message = "权限不足") => jsonError(c, 403, "forbidden", message),
  notFound: (c: Context, message = "未找到") => jsonError(c, 404, "not_found", message),
  encrypted: (c: Context) =>
    jsonError(c, 409, "connection_encrypted", "该连接为端到端加密，无法读取正文"),
  syncInProgress: (c: Context) => jsonError(c, 409, "sync_in_progress", "该连接正在同步"),
};

/**
 * Sequential GET/POST with retry.
 *
 * 重试两种失败：
 *  1. HTTP 429（遵守 Retry-After，回退指数退避）
 *  2. 网络层错误（fetch 抛错，如 DNS 抖动 / TLS 超时 / 连接重置 / 短暂断网）
 *
 * 第 2 点对国内网络环境很关键：api.notion.com 等境外 API 常有间歇性连接超时，
 * 原实现只重试 429，网络抖动会直接冒泡成 "fetch failed" 导致整次同步失败。
 * 现在网络错误也会退避重试，显著提高同步成功率。
 */

function retryDelayMs(res: Response, attempt: number): number {
  const ra = res.headers.get("Retry-After");
  if (ra) {
    const n = Number(ra);
    if (Number.isFinite(n)) return Math.max(0, n * 1000);
    const d = Date.parse(ra);
    if (Number.isFinite(d)) return Math.max(0, d - Date.now());
  }
  return Math.min(1000 * 2 ** attempt, 8000);
}

function backoffMs(attempt: number): number {
  // 1s, 2s, 4s, 8s, 16s（上限 16s）
  return Math.min(1000 * 2 ** attempt, 16_000);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Sequential GET/POST with 429 Retry-After + network-error retry, max `maxRetries` retries. */
export async function fetchWithRetry(
  fetchFn: typeof fetch,
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
  maxRetries = 5,
): Promise<Response> {
  let last: Response | undefined;
  let lastErr: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      last = await fetchFn(input, init);
    } catch (err) {
      // 网络层失败：退避后重试
      lastErr = err;
      if (attempt === maxRetries) break;
      await sleep(backoffMs(attempt));
      continue;
    }
    // 429：遵守 Retry-After 重试
    if (last.status !== 429 || attempt === maxRetries) return last;
    const ms = retryDelayMs(last, attempt);
    if (ms > 0) await sleep(ms);
  }

  if (last) return last;
  throw lastErr;
}

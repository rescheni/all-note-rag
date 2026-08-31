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

/** Sequential GET/POST with 429 Retry-After, max `maxRetries` retries. */
export async function fetchWithRetry(
  fetchFn: typeof fetch,
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
  maxRetries = 5,
): Promise<Response> {
  let last: Response | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    last = await fetchFn(input, init);
    if (last.status !== 429 || attempt === maxRetries) return last;
    const ms = retryDelayMs(last, attempt);
    if (ms > 0) await new Promise((r) => setTimeout(r, ms));
  }
  return last as Response;
}

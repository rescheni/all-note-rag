/**
 * 登录/注册 防暴力破解限流器（进程内内存实现）。
 *
 * 设计：
 * - 按 key（如 login:<email>:<ip>）累计失败次数；
 * - 窗口期内失败达到 max 次 → 锁定 lockMs；
 * - 登录成功 或 窗口过期 → 计数清零；
 * - 惰性清理 + 定时清理，避免内存泄漏。
 *
 * 单实例部署足够；多实例/多副本场景建议后续换成 Redis 后端
 * （项目已内置 redis，可平移实现）。
 */

type Bucket = {
  count: number;
  firstAt: number;
  lockedUntil: number;
};

const buckets = new Map<string, Bucket>();

/** 最多保留的 key 数量，防止被随机 key 打爆内存 */
const MAX_KEYS = 10_000;

export type LimitResult = {
  allowed: boolean;
  /** 剩余可尝试次数 */
  remaining: number;
  /** 被锁定时：还需等待的秒数 */
  retryAfterSec?: number;
};

function now(): number {
  return Date.now();
}

function pruneIfNeeded(): void {
  if (buckets.size <= MAX_KEYS) return;
  // 优先删已过期/已解锁的
  const t = now();
  for (const [k, b] of buckets) {
    if (b.lockedUntil < t && t - b.firstAt > 60 * 60 * 1000) buckets.delete(k);
    if (buckets.size <= MAX_KEYS * 0.8) break;
  }
  // 仍然过多则删最旧的
  if (buckets.size > MAX_KEYS) {
    const keys = [...buckets.keys()].slice(0, buckets.size - MAX_KEYS);
    for (const k of keys) buckets.delete(k);
  }
}

/** 检查是否允许尝试（不改变计数） */
export function checkLimit(key: string, max: number, windowMs: number): LimitResult {
  const b = buckets.get(key);
  if (!b) return { allowed: true, remaining: max };

  const t = now();
  if (b.lockedUntil > t) {
    return {
      allowed: false,
      remaining: 0,
      retryAfterSec: Math.ceil((b.lockedUntil - t) / 1000),
    };
  }
  // 窗口已过期 → 视作重置
  if (t - b.firstAt > windowMs) {
    buckets.delete(key);
    return { allowed: true, remaining: max };
  }
  return { allowed: true, remaining: Math.max(0, max - b.count) };
}

/** 记录一次失败；返回是否已触发锁定 */
export function recordFailure(
  key: string,
  max: number,
  windowMs: number,
  lockMs: number,
): { locked: boolean; retryAfterSec?: number; remaining: number } {
  pruneIfNeeded();
  const t = now();
  let b = buckets.get(key);

  if (!b || t - b.firstAt > windowMs) {
    b = { count: 0, firstAt: t, lockedUntil: 0 };
    buckets.set(key, b);
  }

  b.count += 1;

  if (b.count >= max) {
    b.lockedUntil = t + lockMs;
    return { locked: true, retryAfterSec: Math.ceil(lockMs / 1000), remaining: 0 };
  }
  return { locked: false, remaining: Math.max(0, max - b.count) };
}

/** 成功后清除该 key 的失败计数 */
export function resetLimit(key: string): void {
  buckets.delete(key);
}

/** 供测试/运维查看当前受限 key 数 */
export function limitStats(): { keys: number } {
  return { keys: buckets.size };
}

// 定时清理，避免长期运行的进程堆积
const CLEAN_INTERVAL_MS = 10 * 60 * 1000;
if (typeof setInterval === "function") {
  const timer = setInterval(() => {
    const t = now();
    for (const [k, b] of buckets) {
      if (b.lockedUntil < t && t - b.firstAt > CLEAN_INTERVAL_MS) buckets.delete(k);
    }
  }, CLEAN_INTERVAL_MS);
  // Node 环境下不阻塞进程退出
  if (typeof (timer as { unref?: () => void }).unref === "function") {
    (timer as { unref: () => void }).unref();
  }
}

/** 测试辅助：清空全部计数 */
export function __resetAllLimits(): void {
  buckets.clear();
}

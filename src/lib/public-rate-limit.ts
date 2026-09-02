/**
 * Client identity and per-isolate rate limiting for unauthenticated surfaces.
 *
 * IP source order matters: X-Forwarded-For is client-appendable, so a caller
 * can pick a fresh "IP" per request and walk straight through any limit keyed
 * on it. Cloudflare sets cf-connecting-ip from the actual connection, so that
 * is authoritative and X-Forwarded-For is only the fallback for local dev.
 *
 * The limiter is a Map in Worker isolate memory: the effective limit is
 * (limit × live isolates). It dampens casual abuse; it is not a quota system.
 */
import { getRequestHeader, getRequestIP } from "@tanstack/react-start/server";

export function clientIp(request: Request): string {
  const cf = request.headers.get("cf-connecting-ip");
  if (cf) return cf.trim();
  const xff = request.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  return "unknown";
}

/** Same resolution from inside a server function, where there is no Request in hand. */
export function serverFnClientIp(): string {
  try {
    const cf = getRequestHeader("cf-connecting-ip");
    if (cf) return cf.trim();
    return getRequestIP({ xForwardedFor: true }) || "unknown";
  } catch {
    return "unknown";
  }
}

type Bucket = { count: number; resetAt: number };
const limiters = new Map<string, Map<string, Bucket>>();

export function rateLimit(name: string, key: string, limit: number, windowMs = 60_000): boolean {
  let buckets = limiters.get(name);
  if (!buckets) {
    buckets = new Map();
    limiters.set(name, buckets);
  }
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || b.resetAt < now) {
    if (buckets.size > 10_000) buckets.clear();
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  b.count += 1;
  return b.count <= limit;
}

export const RATE_LIMITED_MESSAGE = "Too many requests. Please try again in a minute.";

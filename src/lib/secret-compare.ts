/**
 * Constant-time comparison of a presented shared secret (CRON_SECRET and
 * friends) with the configured one — the ONE comparison every Worker hook
 * that checks a shared secret uses (round-4 security L9).
 *
 * Both sides are hashed to fixed-length SHA-256 digests and compared with
 * crypto.timingSafeEqual, so the time taken depends neither on where the two
 * first differ nor on the configured secret's length (a plain `===`, or a
 * timingSafeEqual behind a length check, leaks one or the other). Empty or
 * unset on either side is a refusal, never a match.
 *
 * Server-only (node:crypto).
 */
import { createHash, timingSafeEqual } from "node:crypto";

export function secretsMatch(
  presented: string | null | undefined,
  configured: string | null | undefined,
): boolean {
  const got = typeof presented === "string" ? presented : "";
  const want = typeof configured === "string" ? configured : "";
  if (!got || !want) return false;
  const a = createHash("sha256").update(got, "utf8").digest();
  const b = createHash("sha256").update(want, "utf8").digest();
  return timingSafeEqual(a, b);
}

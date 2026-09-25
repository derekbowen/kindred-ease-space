/**
 * THE GATE ON THE OPS PROBES (/api/public/ops/email-probe, /api/public/ops/sync-health).
 *
 * Both probes are unauthenticated routes on purpose: they diagnose the reasons
 * nobody can log in or no sync has run, so a session gate would close them in
 * exactly the outage they exist for. Access is therefore a shared secret.
 *
 * Which secret matters. The first version accepted SEND_EMAIL_HOOK_SECRET.
 * That value is the HMAC key Supabase Auth signs every send-email hook call
 * with; it is meant to be used only ever inside a signature, never sent. The
 * probes had it typed into a header in plaintext, so every place a probe call
 * lived — a shell history, a runbook, a CI log, a pasted curl — became a copy
 * of the key that authenticates signups, and the only way to rotate it was to
 * rotate the Auth hook. A diagnostic must not cost the credential it
 * diagnoses.
 *
 * OPS_PROBE_SECRET is dedicated to the probes, opens nothing else, and rotates
 * without touching Auth. It is the ONLY value this module consults: there is
 * no fallback to the hook secret, and an unset OPS_PROBE_SECRET closes the
 * probes with the same 401 body as a wrong one, so the endpoint cannot be used
 * to learn whether it is configured.
 */
import { secretsMatch } from "@/lib/secret-compare";

/** The header a caller puts the probe secret in. `Authorization: Bearer …` works too. */
export const OPS_PROBE_SECRET_HEADER = "x-founders-probe-secret";

/**
 * Does `presented` equal `configured`? Compared as fixed-length SHA-256
 * digests so the comparison is constant time AND the secret's length does not
 * leak through an early length check. Empty or unset on either side is a
 * refusal, never a match.
 */
export function opsProbeSecretMatches(
  presented: string | null | undefined,
  configured: string | null | undefined,
): boolean {
  return secretsMatch((presented ?? "").trim(), (configured ?? "").trim());
}

/** The secret a request presents, or null when it presents none. */
export function presentedOpsProbeSecret(request: Request): string | null {
  return (
    request.headers.get(OPS_PROBE_SECRET_HEADER) ??
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
    null
  );
}

/**
 * May this request use an ops probe? Reads OPS_PROBE_SECRET at call time (the
 * Worker populates process.env per request) and nothing else.
 */
export function opsProbeAuthorised(request: Request): boolean {
  return opsProbeSecretMatches(presentedOpsProbeSecret(request), process.env.OPS_PROBE_SECRET);
}

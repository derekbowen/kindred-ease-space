/**
 * Signature verification for the Supabase Auth send-email hook.
 *
 * This endpoint is unauthenticated by URL and triggers outbound email, so the
 * standard-webhooks HMAC is the entire security boundary: a forged call must
 * never send mail, and a replayed one must age out.
 *
 * Run: bun tests/auth-email-hook.test.ts
 */
import {
  decodeSecret, verifySignature, signPayload, verifyUrl, copyFor,
  TIMESTAMP_TOLERANCE_S,
} from "../src/lib/auth-email-hook";

let pass = 0, fail = 0;
const failed: string[] = [];
function t(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failed.push(name); console.log(`  FAIL  ${name}  ${extra}`); }
}

const rawSecret = Buffer.from("test-secret-material-0123456789");
const b64 = rawSecret.toString("base64");
const body = JSON.stringify({ user: { email: "a@b.c" }, email_data: { email_action_type: "signup" } });
const now = Date.now();
const ts = String(Math.floor(now / 1000));
const goodSig = signPayload("msg_1", ts, body, rawSecret);
const H = (over: Partial<{ id: string | null; timestamp: string | null; signature: string | null }> = {}) => ({
  id: "msg_1", timestamp: ts, signature: goodSig, ...over,
});

console.log("\n=== secret formats (as the dashboard shows them) ===");
t("v1,whsec_<base64> decodes", decodeSecret(`v1,whsec_${b64}`)?.equals(rawSecret) === true);
t("whsec_<base64> decodes", decodeSecret(`whsec_${b64}`)?.equals(rawSecret) === true);
t("bare base64 decodes", decodeSecret(b64)?.equals(rawSecret) === true);
t("empty secret rejected", decodeSecret("") === null);

console.log("\n=== a genuine GoTrue call passes ===");
t("valid signature accepted", verifySignature(H(), body, rawSecret, now));
t("multiple space-separated signatures: any match passes",
  verifySignature(H({ signature: `v1,AAAA ${goodSig}` }), body, rawSecret, now));

console.log("\n=== forgeries are refused ===");
t("wrong secret refused",
  !verifySignature(H(), body, Buffer.from("some-other-secret-material!!!!"), now));
t("tampered body refused",
  !verifySignature(H(), body.replace("a@b.c", "evil@x.y"), rawSecret, now));
t("tampered id refused", !verifySignature(H({ id: "msg_2" }), body, rawSecret, now));
t("garbage signature refused",
  !verifySignature(H({ signature: "v1,!!!!not-base64!!!!" }), body, rawSecret, now));
t("missing headers refused", !verifySignature(H({ signature: null }), body, rawSecret, now));

console.log("\n=== replay is bounded ===");
const oldTs = String(Math.floor(now / 1000) - TIMESTAMP_TOLERANCE_S - 60);
t("stale timestamp refused (even with a valid signature for it)",
  !verifySignature(
    { id: "msg_1", timestamp: oldTs, signature: signPayload("msg_1", oldTs, body, rawSecret) },
    body, rawSecret, now));
t("non-numeric timestamp refused",
  !verifySignature(H({ timestamp: "yesterday" }), body, rawSecret, now));

console.log("\n=== verify URL ===");
{
  const u = verifyUrl(
    { token_hash: "th_123", email_action_type: "signup", redirect_to: "https://www.founders.click/app" },
    "https://proj.supabase.co/",
  );
  t("points at GoTrue's verify endpoint", u.startsWith("https://proj.supabase.co/auth/v1/verify?"));
  t("carries token, type and redirect",
    u.includes("token=th_123") && u.includes("type=signup") &&
    u.includes(encodeURIComponent("https://www.founders.click/app")));
}

console.log("\n=== copy is complete for every action GoTrue can send ===");
for (const a of ["signup","invite","magiclink","recovery","email_change_current","email_change_new","reauthentication"] as const) {
  const m = copyFor(a, "https://x/verify", "123456", "Derek");
  t(`${a}: subject + link + text fallback`,
    m.subject.length > 5 && m.html.includes("https://x/verify") && m.text.includes("https://x/verify"));
}
t("OTP code included when provided",
  copyFor("signup", "https://x", "424242", "").html.includes("424242"));
t("no token leaks into the subject line",
  !copyFor("signup", "https://x", "424242", "").subject.includes("424242"));

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail) console.log("FAILED:\n  " + failed.join("\n  ") + "\n");
process.exit(fail ? 1 : 0);

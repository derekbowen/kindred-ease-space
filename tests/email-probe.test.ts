/**
 * The ops email probe. Run: bun tests/email-probe.test.ts
 *
 * This endpoint is unauthenticated by necessity — it diagnoses the reason
 * nobody can log in, so a session gate would make it useless exactly when it
 * is needed. That puts the weight on the shared-secret check, which is what
 * most of this file tests.
 *
 * The regression that shaped the gate: the probe used to accept
 * SEND_EMAIL_HOOK_SECRET, the HMAC key Auth signs the send-email hook with.
 * It must now accept ONLY the dedicated OPS_PROBE_SECRET, and the hook secret
 * must open nothing here even when the probe secret is unset.
 */
import { opsProbeSecretMatches } from "../src/lib/ops-probe-auth";

const PROBE = "ops-probe-3f9c1d7e5b2a4c8d9e0f1a2b3c4d5e6f";
const OTHER = "ops-probe-000000000000000000000000000000";
const HOOK = "v1,whsec_dGVzdHNlY3JldHRlc3RzZWNyZXR0ZXN0c2VjcmV0MDA=";

process.env.OPS_PROBE_SECRET = PROBE;
// Configured, so the config report can say so — and so the gate test below
// proves that having it configured does NOT make it a valid credential.
process.env.SEND_EMAIL_HOOK_SECRET = HOOK;
process.env.FROM_EMAIL = "founders.click <noreply@founders.click>";
process.env.EMAILIT_DKIM_SELECTOR = "emailit";
// Deliberately unset: with no API key, sendEmail short-circuits and returns a
// deterministic failure, so the send path is exercised without touching the
// network or mailing a real person.
delete process.env.EMAILIT_API_KEY;

const { Route } = await import("../src/routes/api/public/ops/email-probe");
const POST = (Route as any).options.server.handlers.POST as (ctx: {
  request: Request;
}) => Promise<Response>;

let pass = 0, fail = 0;
const failed: string[] = [];
function t(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failed.push(name); console.log(`  FAIL  ${name}  ${extra}`); }
}

const call = (opts: { secret?: string; send?: boolean; body?: unknown; bearer?: boolean } = {}) => {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.secret) {
    if (opts.bearer) headers["authorization"] = `Bearer ${opts.secret}`;
    else headers["x-founders-probe-secret"] = opts.secret;
  }
  const url = `https://www.founders.click/api/public/ops/email-probe${opts.send ? "?send=1" : ""}`;
  return POST({
    request: new Request(url, {
      method: "POST",
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    }),
  });
};

console.log("\n=== the secret gate ===");
{
  const none = await call();
  t("no secret is rejected", none.status === 401, String(none.status));

  const wrong = await call({ secret: OTHER });
  t("wrong secret is rejected", wrong.status === 401, String(wrong.status));

  // THE regression: the Auth hook's signing key is not a probe credential.
  const hook = await call({ secret: HOOK });
  t("the send-email hook secret is rejected", hook.status === 401, String(hook.status));
  const hookBearer = await call({ secret: HOOK, bearer: true });
  t("…also as a Bearer token", hookBearer.status === 401, String(hookBearer.status));

  // The endpoint is public, so its error must not reveal whether the probe
  // secret is configured — otherwise it becomes a probe for that fact.
  const noneBody = await none.text();
  const wrongBody = await wrong.text();
  const hookBody = await hook.text();
  t("all rejections are byte-identical (no configuration oracle)",
    noneBody === wrongBody && wrongBody === hookBody, `${noneBody} vs ${wrongBody} vs ${hookBody}`);

  const ok = await call({ secret: PROBE });
  t("correct OPS_PROBE_SECRET is accepted", ok.status === 200, String(ok.status));

  const viaBearer = await call({ secret: PROBE, bearer: true });
  t("Authorization: Bearer works too", viaBearer.status === 200, String(viaBearer.status));
}

console.log("\n=== no OPS_PROBE_SECRET means closed, never a fallback ===");
{
  const wrongBody = await (await call({ secret: OTHER })).text();
  delete process.env.OPS_PROBE_SECRET;

  const formerlyRight = await call({ secret: PROBE });
  t("with the probe secret unset, the previously correct value is rejected",
    formerlyRight.status === 401, String(formerlyRight.status));

  // The hook secret is still configured. It must not become the gate.
  const hook = await call({ secret: HOOK });
  t("with the probe secret unset, the hook secret still opens nothing",
    hook.status === 401, String(hook.status));

  const empty = await call({ secret: "" });
  t("an empty secret is rejected", empty.status === 401, String(empty.status));

  t("unset and wrong are indistinguishable from outside",
    (await formerlyRight.text()) === wrongBody && (await hook.text()) === wrongBody);

  process.env.OPS_PROBE_SECRET = PROBE;
  t("restored: the probe secret works again", (await call({ secret: PROBE })).status === 200);
}

console.log("\n=== the comparison itself ===");
{
  t("equal values match", opsProbeSecretMatches(PROBE, PROBE));
  t("surrounding whitespace is tolerated (a secret pasted with a newline)",
    opsProbeSecretMatches(`${PROBE}\n`, ` ${PROBE} `));
  t("a different value of the same length does not match", !opsProbeSecretMatches(OTHER, PROBE));
  t("a different length does not match and does not throw",
    !opsProbeSecretMatches(PROBE.slice(0, 10), PROBE) && !opsProbeSecretMatches(`${PROBE}x`, PROBE));
  t("a prefix does not match", !opsProbeSecretMatches(PROBE, `${PROBE}-suffix`));
  t("unset configured never matches, even an empty presentation",
    !opsProbeSecretMatches("", undefined) && !opsProbeSecretMatches("", "") && !opsProbeSecretMatches(null, null));
  t("empty presented never matches a configured value", !opsProbeSecretMatches("", PROBE));
  t("whitespace-only presented never matches", !opsProbeSecretMatches("   ", PROBE));
}

console.log("\n=== config-only is side-effect free ===");
{
  const res = await call({ secret: PROBE });
  const body = (await res.json()) as any;
  t("reports config-only", body.probe === "config-only", body.probe);
  t("no send was attempted", body.send === undefined);
  t("reports the address actually sent from",
    body.config?.fromAddress === "founders.click <noreply@founders.click>", body.config?.fromAddress);
  t("resolves the sending domain from it", body.config?.sendingDomain === "founders.click",
    body.config?.sendingDomain);
  t("reports the API key as unconfigured here", body.config?.emailitApiKeyConfigured === false);
  t("reports the hook secret as configured", body.config?.hookSecretConfigured === true);
  t("includes a deliverability verdict", typeof body.deliverability?.verdict === "string",
    JSON.stringify(body.deliverability)?.slice(0, 120));
  t("never echoes a secret or key",
    !JSON.stringify(body).includes("whsec_") &&
      !JSON.stringify(body).includes(HOOK) &&
      !JSON.stringify(body).includes(PROBE));
}

console.log("\n=== send mode ===");
{
  const noBody = await call({ secret: PROBE, send: true });
  t("send=1 without a recipient is rejected", noBody.status === 400, String(noBody.status));

  const badAddr = await call({ secret: PROBE, send: true, body: { to: "not-an-email" } });
  t("send=1 with a malformed address is rejected", badAddr.status === 400, String(badAddr.status));

  const reserved = await call({ secret: PROBE, send: true, body: { to: "probe@example.com" } });
  t("send=1 to a reserved/test address is refused before any send", reserved.status === 400, String(reserved.status));
  const reservedBody = (await reserved.json()) as any;
  t("the refusal names the recipient policy", /refused by policy/.test(reservedBody.error ?? ""), reservedBody.error);
  const smoke = await call({ secret: PROBE, send: true, body: { to: "smoke1790285685@founders.click" } });
  t("send=1 to an automated-test mailbox is refused too", smoke.status === 400, String(smoke.status));

  const sent = await call({ secret: PROBE, send: true, body: { to: "ops-probe@founders.click" } });
  t("send=1 with a recipient returns 200", sent.status === 200, String(sent.status));
  const body = (await sent.json()) as any;
  t("reports send mode", body.probe === "send", body.probe);
  t("echoes the attempted recipient", body.send?.attemptedTo === "ops-probe@founders.click");

  // The whole point: the provider's real answer is surfaced instead of being
  // swallowed the way the auth hook swallows it.
  t("surfaces the provider outcome", typeof body.send?.ok === "boolean");
  t("a refusal carries the reason", body.send.ok === false && typeof body.send.error === "string",
    JSON.stringify(body.send));
  t("names the missing API key as the cause", /EMAILIT_API_KEY/.test(body.send.error ?? ""),
    body.send?.error);
  t("interpretation says the provider refused",
    /REFUSED/.test(body.interpretation ?? ""), body.interpretation);
  t("records elapsed time", typeof body.send?.elapsedMs === "number");
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) { console.log("Failed: " + failed.join(", ")); process.exit(1); }

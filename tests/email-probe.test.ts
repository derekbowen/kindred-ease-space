/**
 * The ops email probe. Run: bun tests/email-probe.test.ts
 *
 * This endpoint is unauthenticated by necessity — it diagnoses the reason
 * nobody can log in, so a session gate would make it useless exactly when it
 * is needed. That puts the weight on the shared-secret check, which is what
 * most of this file tests.
 */
const SECRET = "v1,whsec_dGVzdHNlY3JldHRlc3RzZWNyZXR0ZXN0c2VjcmV0MDA=";
const OTHER = "v1,whsec_b3RoZXJzZWNyZXRvdGhlcnNlY3JldG90aGVyc2VjMDA=";

process.env.SEND_EMAIL_HOOK_SECRET = SECRET;
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

  // The endpoint is public, so its error must not reveal whether the hook
  // secret is configured — otherwise it becomes a probe for that fact.
  const noneBody = await none.text();
  const wrongBody = await wrong.text();
  t("both rejections are byte-identical (no configuration oracle)", noneBody === wrongBody,
    `${noneBody} vs ${wrongBody}`);

  const ok = await call({ secret: SECRET });
  t("correct secret is accepted", ok.status === 200, String(ok.status));

  const viaBearer = await call({ secret: SECRET, bearer: true });
  t("Authorization: Bearer works too", viaBearer.status === 200, String(viaBearer.status));
}

console.log("\n=== config-only is side-effect free ===");
{
  const res = await call({ secret: SECRET });
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
    !JSON.stringify(body).includes("whsec_") && !JSON.stringify(body).includes(SECRET));
}

console.log("\n=== send mode ===");
{
  const noBody = await call({ secret: SECRET, send: true });
  t("send=1 without a recipient is rejected", noBody.status === 400, String(noBody.status));

  const badAddr = await call({ secret: SECRET, send: true, body: { to: "not-an-email" } });
  t("send=1 with a malformed address is rejected", badAddr.status === 400, String(badAddr.status));

  const sent = await call({ secret: SECRET, send: true, body: { to: "probe@example.com" } });
  t("send=1 with a recipient returns 200", sent.status === 200, String(sent.status));
  const body = (await sent.json()) as any;
  t("reports send mode", body.probe === "send", body.probe);
  t("echoes the attempted recipient", body.send?.attemptedTo === "probe@example.com");

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

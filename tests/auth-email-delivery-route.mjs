// Exercise the actual signed HTTP handler with an isolated provider mock.
// No network requests or emails are made by this test.
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const folder = await mkdtemp(join(tmpdir(), "kindred-auth-route-"));
const output = join(folder, "route.mjs");
await build({
  entryPoints: ["src/routes/api/public/hooks/auth-send-email.ts"],
  outfile: output,
  bundle: true,
  platform: "node",
  format: "esm",
  logLevel: "silent",
  plugins: [
    {
      name: "isolated-auth-dependencies",
      setup(b) {
        b.onResolve({ filter: /^@tanstack\/react-router$/ }, () => ({
          path: "router",
          namespace: "mock",
        }));
        b.onResolve({ filter: /^@\/lib\/email\.server$/ }, () => ({
          path: "sender",
          namespace: "mock",
        }));
        b.onLoad({ filter: /.*/, namespace: "mock" }, ({ path }) => ({
          loader: "js",
          contents:
            path === "router"
              ? "export const createFileRoute = () => value => value;"
              : "export async function sendEmail() { globalThis.__kindredSendCalls++; return globalThis.__kindredSendResult; }",
        }));
        b.onResolve({ filter: /^@\// }, ({ path }) => ({
          path: resolve("src", path.slice(2)) + ".ts",
        }));
      },
    },
  ],
});
const secret = randomBytes(32);
process.env.SEND_EMAIL_HOOK_SECRET = "v1,whsec_" + secret.toString("base64");
process.env.SUPABASE_URL = "https://auth-fixture.supabase.co";
const { Route } = await import(pathToFileURL(output).href);
const handler = Route.server.handlers.POST;
function request(signatureValid = true) {
  const body = JSON.stringify({
    user: { email: "delivery-test@gmail.com", user_metadata: {} },
    email_data: {
      email_action_type: "signup",
      token_hash: "test-hash",
      redirect_to: "https://app.example.invalid/app",
    },
  });
  const id = "email-test-" + crypto.randomUUID(),
    timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", secret)
    .update(id + "." + timestamp + "." + body)
    .digest("base64");
  return new Request(
    "https://app.example.invalid/api/public/hooks/auth-send-email",
    {
      method: "POST",
      body,
      headers: {
        "webhook-id": id,
        "webhook-timestamp": timestamp,
        "webhook-signature": "v1," + (signatureValid ? signature : "invalid"),
      },
    },
  );
}
globalThis.__kindredSendCalls = 0;
globalThis.__kindredSendResult = { ok: false, error: "provider refused the send" };
const rejected = await handler({ request: request() });
assert.equal(rejected.status, 503);
assert.equal((await rejected.json()).error.http_code, 503);
assert.equal(globalThis.__kindredSendCalls, 1);
globalThis.__kindredSendResult = { ok: true, id: "mock-accepted" };
const accepted = await handler({ request: request() });
assert.equal(accepted.status, 200);
assert.equal(globalThis.__kindredSendCalls, 2);
const forged = await handler({ request: request(false) });
assert.equal(forged.status, 401);
assert.equal(globalThis.__kindredSendCalls, 2);
await rm(folder, { recursive: true, force: true });
console.log(
  "PASS: signed provider failure returns 503, accepted send returns 200, forged request cannot send. No emails sent.",
);

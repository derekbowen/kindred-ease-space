// Run the real activation handler and Cloudflare status reader against an
// isolated database/network fixture. No customer DNS or Cloudflare writes.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const folder = await mkdtemp(join(tmpdir(), "kindred-domain-test-"));
const output = join(folder, "activation.mjs");
let row,
  pendingState,
  apiFailure = false,
  saveFailure = false,
  cfReads = 0;
let ownershipProof = true;
const workspace = { marketplace_domain: "", domain_verified_at: null };
globalThis.__kindredDomainDb = {
  from(table) {
    assert.ok(["workspace_domains", "workspaces"].includes(table));
    let patch, selected;
    const q = {
      select(columns) {
        selected = columns?.split(",").map((column) => column.trim());
        return q;
      },
      eq() {
        return q;
      },
      maybeSingle: async () => {
        const value = table === "workspaces" ? workspace : row;
        return { data: selected ? Object.fromEntries(selected.map((key) => [key, value[key]])) : { ...value }, error: null };
      },
      update(value) {
        patch = value;
        return q;
      },
      then(resolve) {
        if (saveFailure)
          return Promise.resolve({ data: null, error: { message: "test save failed" } }).then(
            resolve,
          );
        Object.assign(table === "workspaces" ? workspace : row, patch);
        return Promise.resolve({ data: [{ id: row.id }], error: null }).then(resolve);
      },
    };
    return q;
  },
};
await build({
  entryPoints: ["src/lib/admin-domains.functions.ts"],
  outfile: output,
  bundle: true,
  platform: "node",
  format: "esm",
  logLevel: "silent",
  plugins: [
    {
      name: "activation-fixtures",
      setup(b) {
        b.onResolve({ filter: /^@tanstack\/react-start$/ }, () => ({
          path: "server",
          namespace: "mock",
        }));
        b.onResolve(
          {
            filter:
              /^(?:@\/integrations\/supabase\/(?:client\.server|auth-middleware)|\.\/admin-helpers\.functions)$/,
          },
          ({ path }) => ({ path, namespace: "mock" }),
        );
        b.onLoad({ filter: /.*/, namespace: "mock" }, ({ path }) => ({
          loader: "js",
          resolveDir: process.cwd(),
          contents:
            path === "server"
              ? "export function createServerFn(){const q={middleware(){return q},inputValidator(){return q},handler(fn){return fn}};return q}"
              : path.includes("client.server")
                ? "export const supabaseAdmin=globalThis.__kindredDomainDb;"
                : path.includes("auth-middleware")
                  ? "export const requireSupabaseAuth=[];"
                  : 'import {z} from "zod";export const workspaceIdSchema=z.string().uuid();export async function assertWorkspaceOwner(){};export async function assertWorkspaceMember(){};',
        }));
        b.onResolve({ filter: /^@\// }, ({ path }) => ({
          path: resolve("src", path.slice(2)) + ".ts",
        }));
      },
    },
  ],
});
const savedFetch = globalThis.fetch;
process.env.CLOUDFLARE_API_TOKEN = "isolated-fixture-token";
process.env.CLOUDFLARE_ZONE_ID = "isolated-fixture-zone";
globalThis.fetch = async (input) => {
  const url = new URL(String(input));
  if (url.hostname === "api.cloudflare.com") {
    cfReads++;
    return apiFailure
      ? new Response('{"success":false}', { status: 503 })
      : Response.json({ success: true, result: pendingState });
  }
  if (url.hostname === "cloudflare-dns.com") return Response.json({ Answer: ownershipProof ? [{ data: `"${row.verification_token}"` }] : [] });
  if (url.pathname === "/.well-known/founders-click-verify") return new Response(ownershipProof ? row.verification_token : "wrong-proof");
  return new Response(
    url.pathname.includes("founders-domain-test")
      ? "founders-click-domain-test: OK"
      : "Existing site",
  );
};
try {
  const { activateWorkspaceDomain, verifyWorkspaceDomain } = await import(pathToFileURL(output).href);
  const run = () =>
    activateWorkspaceDomain({
      data: { workspaceId: "fixture-workspace", id: row.id },
      context: { userId: "fixture-owner" },
    });
  function reset() {
    row = {
      id: "fixture-domain",
      hostname: "seo.example.invalid",
      verified: true,
      connection_type: "subdomain",
      route_prefix: "/a/",
      status: "ssl_pending",
      cloudflare_hostname_id: "cf-fixture",
    };
    pendingState = {
      hostname: row.hostname,
      status: "active",
      ssl: { status: "pending_validation" },
    };
    apiFailure = false;
    saveFailure = false;
  }
  reset();
  assert.equal(
    (await run()).ok,
    false,
    "A working HTTPS route cannot hide pending certificate validation",
  );
  assert.equal(row.ssl_status, "pending_validation");
  assert.equal(row.status, "ssl_pending");
  pendingState.ssl.status = "active";
  pendingState.status = "pending";
  assert.equal(
    (await run()).ok,
    false,
    "A ready certificate cannot hide pending hostname activation",
  );
  pendingState.status = "active";
  assert.equal((await run()).ok, true);
  assert.equal(row.status, "active");
  reset();
  apiFailure = true;
  let result = await run();
  assert.equal(result.ok, false);
  assert.match(result.checks.find((c) => c.name === "domain_certificate").detail, /couldn't check/);
  reset();
  pendingState.hostname = "someone-else.example.invalid";
  assert.equal((await run()).ok, false, "A mismatched hostname must not validate this domain");
  reset();
  pendingState.ssl.status = "active";
  saveFailure = true;
  assert.equal((await run()).ok, false, "Failed database saves must not report activation success");
  reset();
  row.connection_type = "customer_proxy";
  const before = cfReads;
  assert.equal((await run()).ok, true);
  assert.equal(cfReads, before, "A customer-managed proxy uses its own HTTPS route check");
  delete process.env.CLOUDFLARE_API_TOKEN;
  const verify = () => verifyWorkspaceDomain({ data: { workspaceId: "fixture-workspace", id: row.id }, context: { userId: "fixture-owner" } });
  reset();
  row.connection_type = "customer_proxy";
  row.verified = false;
  row.verification_token = "fixture-ownership-proof";
  const readsBeforeProof = cfReads;
  assert.equal((await verify()).ok, true, "Customer-managed routing needs ownership proof but no shared-edge credential");
  assert.equal(row.verified, true);
  assert.equal(cfReads, readsBeforeProof);
  assert.equal(workspace.marketplace_domain, row.hostname);
  row.status = "error";
  row.last_error = "old managed-edge error";
  assert.equal((await verify()).ok, true, "Customer proxy retry recovers an earlier managed-edge error");
  assert.equal(row.status, "dns_configuration_required", "Ownership alone must not report an active domain");
  assert.equal(row.last_error, null);
  reset();
  row.connection_type = "customer_proxy";
  row.verified = false;
  row.verification_token = "fixture-ownership-proof";
  ownershipProof = false;
  assert.equal((await verify()).ok, false, "Customer proxy mode must still reject failed ownership proof");
  assert.equal(row.verified, false);
  ownershipProof = true;
  reset();
  row.verified = false;
  row.verification_token = "fixture-ownership-proof";
  assert.equal((await verify()).ok, false, "Managed edge modes still require configured provisioning");
  console.log(
    "PASS: real certificate/hostname checks, lookup failures, mismatched domains, failed saves, and customer proxy mode. No external requests made.",
  );
} finally {
  globalThis.fetch = savedFetch;
  delete globalThis.__kindredDomainDb;
  await rm(folder, { recursive: true, force: true });
}

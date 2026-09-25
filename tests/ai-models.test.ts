/**
 * THE MODEL PICKER'S CONTRACT. Run: bun tests/ai-models.test.ts
 *
 * getAvailableAiModels({ workspaceId }) (src/lib/ai-models.functions.ts) is
 * what the Quick Page Builder and the batch "Generate Content" page render
 * their model dropdown from: the models founders.click actually runs (the
 * one allowlist, src/lib/ai/models.ts), grouped by provider, for the key the
 * workspace's calls would really use — never an invented entry.
 *
 *   - every key situation: the workspace's own key (BYOK) → ok/byok, even
 *     with the kill switch off; the platform key → ok/platform, or
 *     platform_paused while the kill switch is off (a missing settings row
 *     counts as off, as ai_reserve fails closed); no key → none_configured,
 *     with what to set up and where (settingsPath);
 *   - only OpenAI and only the allowlist; premium listed because page
 *     generation is the route that offers it; exactly one default (standard);
 *   - the loop back to the server: each option's tier is what the strict
 *     generation schemas accept as `quality`, and the server maps it to the
 *     very model the option names (the rest of the path — the hold, the job
 *     row, the request OpenAI receives — is driven in
 *     tests/generation-flow.test.ts);
 *   - nothing about a key leaks: the BYOK read selects the row id only, the
 *     answer carries no key material;
 *   - the endpoint: strict input, authenticated, member-only, a customer
 *     sentence on failure; nothing else lists a provider or a model.
 */
process.env.SUPABASE_URL = "http://supabase.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test";

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const {
  AI_MODELS_MESSAGES,
  AI_SETTINGS_PATH,
  GetAvailableAiModelsInputSchema,
  availableModelsFor,
  pageGenerationModelOptions,
  readAvailableAiModels,
} = await import("../src/lib/ai-models.functions");
const { AI_MODELS, AI_QUALITY_TIERS } = await import("../src/lib/ai/models");
const { routeModel } = await import("../src/lib/ai/limits");
const { QuickPageInputSchema } = await import("../src/lib/admin-quick-page.functions");
const { StartGenerationJobInputSchema } = await import("../src/lib/generation.functions");
const { AI_MESSAGES } = await import("../src/lib/ai/customer-error");
const { isCustomerSentence } = await import("../src/lib/user-message");

let pass = 0,
  fail = 0;
const failed: string[] = [];
function t(name: string, cond: boolean, extra = "") {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    failed.push(name);
    console.log(`  FAIL  ${name}  ${extra}`);
  }
}

const ROOT = join(import.meta.dir, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const WS = "11111111-1111-4111-8111-111111111111";

console.log("\n=== the contract, for every key situation (pure) ===");
{
  const byok = availableModelsFor({ byokConfigured: true, platformConfigured: true, platformEnabled: true });
  t(
    "own key: ok, one provider group — OpenAI on the workspace's key",
    byok.state === "ok" && byok.providers.length === 1 && byok.providers[0]!.provider === "openai" && byok.providers[0]!.label === "OpenAI" && byok.providers[0]!.source === "byok",
    JSON.stringify(byok),
  );
  const byokPaused = availableModelsFor({ byokConfigured: true, platformConfigured: false, platformEnabled: false });
  t("own key: ok even with no platform key and the kill switch off (it never applies to BYOK)", byokPaused.state === "ok" && byokPaused.providers[0]!.source === "byok");
  const platform = availableModelsFor({ byokConfigured: false, platformConfigured: true, platformEnabled: true });
  t("platform key, switch on: ok, OpenAI on the platform's key", platform.state === "ok" && platform.providers.length === 1 && platform.providers[0]!.source === "platform");
  const paused = availableModelsFor({ byokConfigured: false, platformConfigured: true, platformEnabled: false });
  t(
    "platform key, switch off: platform_paused, no options, the refusal's own sentence",
    paused.state === "platform_paused" && paused.providers.length === 0 && paused.message === AI_MESSAGES.platformPaused,
    JSON.stringify(paused),
  );
  const none = availableModelsFor({ byokConfigured: false, platformConfigured: false, platformEnabled: true });
  t(
    "no key anywhere: none_configured, no options, what to set up and where",
    none.state === "none_configured" && none.providers.length === 0 && none.message === AI_MODELS_MESSAGES.none_configured && none.settingsPath === AI_SETTINGS_PATH && AI_SETTINGS_PATH === "/app/settings/ai",
    JSON.stringify(none),
  );
  t("the settings page named exists as a route", existsSync(join(ROOT, "src/routes/_authenticated/app.settings.ai.tsx")));
  t("every non-ok sentence is a customer sentence", [AI_MODELS_MESSAGES.none_configured, AI_MODELS_MESSAGES.platform_paused].every((m) => isCustomerSentence(m)));
  t("an ok answer carries no message and no settings path", byok.message === undefined && byok.settingsPath === undefined && platform.message === undefined);
}

console.log("\n=== only OpenAI, only the allowlist, the tier the server maps ===");
for (const source of ["platform", "byok"] as const) {
  const opts = pageGenerationModelOptions(source);
  t(
    `${source}: exactly the allowlist, standard then premium`,
    opts.map((o) => `${o.tier}:${o.model}`).join() === "standard:gpt-5-nano,premium:gpt-5-mini" && opts.every((o) => (AI_MODELS as readonly string[]).includes(o.model)),
    JSON.stringify(opts),
  );
  t(`${source}: labels name the model and the tier`, opts.map((o) => o.label).join(" | ") === "GPT-5 nano (Standard) | GPT-5 mini (Premium)", opts.map((o) => o.label).join(" | "));
  t(`${source}: exactly one default, standard`, opts.filter((o) => o.isDefault).map((o) => o.tier).join() === "standard");
  t(`${source}: every hint is a customer sentence`, opts.every((o) => isCustomerSentence(o.hint)), opts.map((o) => o.hint).join(" | "));
  for (const o of opts) {
    t(
      `${source} ${o.tier}: the option's tier is what the generation schemas accept as quality, and the server runs exactly ${o.model} for it`,
      QuickPageInputSchema.safeParse({ workspaceId: WS, title: "Boats in Austin", topic: "City hub page for boat rentals", quality: o.tier }).success &&
        StartGenerationJobInputSchema.safeParse({ workspaceId: WS, targetKeys: ["city:austin|tx"], quality: o.tier }).success &&
        routeModel("page_generation", o.tier) === o.model,
    );
    t(
      `${source} ${o.tier}: the option's model string itself is refused as a quality (only the tier travels)`,
      !QuickPageInputSchema.safeParse({ workspaceId: WS, title: "Boats in Austin", topic: "City hub page for boat rentals", quality: o.model }).success,
    );
  }
}
t("the platform hint for premium says it uses more of the included AI", /included AI/.test(pageGenerationModelOptions("platform")[1]!.hint));
t("the BYOK hints say the workspace's own key is used (no platform allowance wording)", pageGenerationModelOptions("byok").every((o) => /own key/.test(o.hint) && !/included AI/.test(o.hint)));
t("the tiers offered are the page-generation route's own", pageGenerationModelOptions("platform").length === AI_QUALITY_TIERS.length);
{
  const all = JSON.stringify([
    availableModelsFor({ byokConfigured: true, platformConfigured: true, platformEnabled: true }),
    availableModelsFor({ byokConfigured: false, platformConfigured: true, platformEnabled: true }),
  ]);
  t("no other provider or model is ever listed (Anthropic, Gemini, OpenRouter, Lovable, Claude, GPT-4…)", !/anthropic|gemini|openrouter|lovable|claude|gpt-4|o1|o3|llama|mistral/i.test(all), all);
}

console.log("\n=== the reads (existence only) ===");
{
  type Call = { table: string; select: string; filters: Array<[string, unknown]> };
  const fakeDb = (o: { secret?: boolean; enabled?: boolean | null; secretError?: boolean; settingsError?: boolean }) => {
    const calls: Call[] = [];
    const db = {
      from(table: string) {
        const call: Call = { table, select: "", filters: [] };
        calls.push(call);
        const q = {
          select(cols: string) {
            call.select = cols;
            return q;
          },
          eq(col: string, v: unknown) {
            call.filters.push([col, v]);
            return q;
          },
          async maybeSingle() {
            if (table === "workspace_secrets") {
              if (o.secretError) return { data: null, error: { message: "relation exploded" } };
              return { data: o.secret ? { id: "secret-row-1" } : null, error: null };
            }
            if (o.settingsError) return { data: null, error: { message: "settings exploded" } };
            return { data: o.enabled === null ? null : { platform_ai_enabled: o.enabled ?? true }, error: null };
          },
        };
        return q;
      },
    };
    return { db, calls };
  };
  const KEY = "sk-live-this-must-never-appear-anywhere";
  {
    const { db, calls } = fakeDb({ secret: true, enabled: false });
    const r = await readAvailableAiModels(WS, { db, env: { OPENAI_API_KEY: KEY } });
    t("own key stored → ok/byok (the kill switch off does not matter)", r.state === "ok" && r.providers[0]?.source === "byok", JSON.stringify(r));
    const secretRead = calls.find((c) => c.table === "workspace_secrets");
    t(
      "the BYOK read asks for the row id only, for THIS workspace's OPENAI_API_KEY (the one store resolveAiKey uses)",
      secretRead?.select === "id" &&
        JSON.stringify(secretRead.filters) === JSON.stringify([["workspace_id", WS], ["key_name", "OPENAI_API_KEY"]]),
      JSON.stringify(secretRead),
    );
    t("no key material in the answer", !JSON.stringify(r).includes(KEY) && !/sk-|secret-row/.test(JSON.stringify(r)));
  }
  {
    const { db, calls } = fakeDb({ secret: false, enabled: true });
    const r = await readAvailableAiModels(WS, { db, env: { OPENAI_API_KEY: KEY } });
    t("platform key set, switch on → ok/platform", r.state === "ok" && r.providers[0]?.source === "platform");
    t("…the switch is read from the one settings row", calls.some((c) => c.table === "ai_platform_settings" && c.select === "platform_ai_enabled" && JSON.stringify(c.filters) === JSON.stringify([["id", true]])));
    t("…and still no key material in the answer", !JSON.stringify(r).includes(KEY) && !/sk-/.test(JSON.stringify(r)));
  }
  {
    const { db } = fakeDb({ secret: false, enabled: false });
    t("platform key set, switch off → platform_paused", (await readAvailableAiModels(WS, { db, env: { OPENAI_API_KEY: KEY } })).state === "platform_paused");
  }
  {
    const { db } = fakeDb({ secret: false, enabled: null });
    t("platform key set, settings row missing → platform_paused (fails closed, like ai_reserve)", (await readAvailableAiModels(WS, { db, env: { OPENAI_API_KEY: KEY } })).state === "platform_paused");
  }
  for (const [label, env] of [
    ["unset", {}],
    ["empty", { OPENAI_API_KEY: "" }],
    ["whitespace", { OPENAI_API_KEY: "   " }],
  ] as const) {
    const { db } = fakeDb({ secret: false, enabled: true });
    const r = await readAvailableAiModels(WS, { db, env });
    t(`no BYOK and the platform key ${label} → none_configured with the settings path`, r.state === "none_configured" && r.settingsPath === "/app/settings/ai");
  }
  for (const [label, o] of [
    ["the BYOK read", { secretError: true }],
    ["the settings read", { settingsError: true }],
  ] as const) {
    const { db } = fakeDb({ secret: true, enabled: true, ...o });
    let threw = false;
    try {
      await readAvailableAiModels(WS, { db, env: { OPENAI_API_KEY: KEY } });
    } catch {
      threw = true;
    }
    t(`a failed ${label} throws (never an 'ok' it could not check)`, threw);
  }
}

console.log("\n=== the endpoint ===");
{
  t(
    "the input is strict: a workspace id only",
    GetAvailableAiModelsInputSchema.safeParse({ workspaceId: WS }).success &&
      !GetAvailableAiModelsInputSchema.safeParse({ workspaceId: WS, provider: "openai" }).success &&
      !GetAvailableAiModelsInputSchema.safeParse({ workspaceId: WS, model: "gpt-5-mini" }).success &&
      !GetAvailableAiModelsInputSchema.safeParse({ workspaceId: "not-a-uuid" }).success &&
      !GetAvailableAiModelsInputSchema.safeParse({}).success,
  );
  const src = read("src/lib/ai-models.functions.ts");
  const fn = src.slice(src.indexOf("export const getAvailableAiModels"));
  t("authenticated (requireSupabaseAuth)", /\.middleware\(\[requireSupabaseAuth\]\)/.test(fn));
  t("the strict validator", /\.inputValidator\(\(d: unknown\) => GetAvailableAiModelsInputSchema\.parse\(d\)\)/.test(fn));
  t("member-only, checked before any read", /await assertWorkspaceMember\(data\.workspaceId, context\.userId\);\s*return await readAvailableAiModels\(data\.workspaceId\);/.test(fn));
  t("a failure is a customer sentence", /throw new Error\(customerMessage\(e, AI_MODELS_UNAVAILABLE_MESSAGE\)\);/.test(fn));
  t("the key value is never read (existence only)", !/tenant_get_workspace_secret|decrypted|\.value\b/.test(src));
  // The model list lives in exactly one place: nothing else under src/lib
  // declares a provider/model catalogue for a picker.
  const walk = (dir: string, out: string[] = []): string[] => {
    if (!existsSync(dir)) return out;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.(ts|tsx)$/.test(name)) out.push(p);
    }
    return out;
  };
  const listers = walk(join(ROOT, "src"))
    .map((f) => relative(ROOT, f))
    .filter((f) => /["'](gemini|google\/gemini|anthropic\/|openai\/gpt|claude-)[^"']*["']/i.test(read(f)));
  t("no source file lists a Gemini / Anthropic / OpenRouter-style model id", listers.length === 0, listers.join(", "));
  const pkg = read("package.json");
  t("this suite is in the test chain", /bun tests\/ai-models\.test\.ts/.test(pkg));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  console.log("Failed:", failed.join(" || "));
  process.exit(1);
}

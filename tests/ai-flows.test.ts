/**
 * EVERY WORKER AI ROUTE, DRIVEN. Run: bun tests/ai-flows.test.ts
 *
 * The real pipelines behind the AI server functions — the SEO coach
 * (runSeoCoachTurn), the page auditor (runPageAudit), the Daily Briefing
 * actions (runCoachActionPipeline: fix_thin_page, add_meta, add_internal_links,
 * create_city_page), the Opportunity Engine's approve (runApproveOpportunity)
 * and the on-demand briefing request (requestBriefing) —
 * against a fake PostgREST and a fake OpenAI behind globalThis.fetch
 * (tests/_support/fake-backend.ts). Page generation (quick page, batch) is
 * driven the same way in tests/generation-flow.test.ts.
 *
 * For every route: membership and every refusal come BEFORE any spend; the
 * spend order is ai_reserve → ai_mark_called → provider → ai_settle; the
 * route's own hard limits and the standard model are what is held for and
 * sent; a refused hold never reaches the provider; a failure after the call
 * is settled, never released; the customer only ever reads a fixed sentence.
 *
 * Round 5: the SEO coach and the page auditor are not part of launch, so the
 * server serves them only to a workspace holding the founder / internal
 * unlimited entitlement (M2 / security L1) — their flows below run as such a
 * workspace, and the gate itself is driven first; a coach edit that updates
 * no row is not delivered and not charged (L4); an exception after the
 * request left settles at the full hold (L6).
 */
process.env.SUPABASE_URL = "http://supabase.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test";
delete process.env.OPENAI_API_KEY;

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FakeBackend, okJson, okText, responseBody } from "./_support/fake-backend";

const backend = new FakeBackend();
backend.install();

const { runSeoCoachTurn, SEO_COACH_MAX_CHARS, SEO_COACH_UNAVAILABLE_MESSAGE } = await import("../src/lib/admin-seo-coach.functions");
const { runPageAudit, PAGE_NOT_FOUND_MESSAGE, PAGE_AUDITOR_UNAVAILABLE_MESSAGE } = await import("../src/lib/admin-page-auditor.functions");
const { runCoachActionPipeline, CoachActionInputSchema } = await import("../src/lib/coach-actions.functions");
const { runApproveOpportunity } = await import("../src/lib/opportunities.functions");
const { requestBriefing, BRIEFING_FAILED_MESSAGE } = await import("../src/lib/coach-briefing.server");
const { AI_MESSAGES, CustomerFacingError } = await import("../src/lib/ai/customer-error");
const { AI_ROUTE_LIMITS, AI_MAX_INPUT_TOKENS, ADD_META_MAX_PAGES } = await import("../src/lib/ai/limits");
const { deterministicRequestId } = await import("../src/lib/generation.server");

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

const WS = "11111111-1111-4111-8111-111111111111";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PAGE_ID = "55555555-5555-4555-8555-555555555555";
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const hold = () => backend.rpcHits("ai_reserve")[0]?.body;
const settle = () => backend.rpcHits("ai_settle")[0]?.body;
const sent = () => backend.providerHits()[0]?.body;
const FULL_ORDER = "ai_reserve → ai_mark_called → provider → ai_settle";
/** A workspace holding the founder / internal unlimited entitlement (the launch-hidden AI routes' audience). */
const resetInternal = () => {
  backend.reset();
  backend.rpc.workspace_is_internal_unlimited = () => true;
};

const origError = console.error;
const origWarn = console.warn;
const logs: string[] = [];
console.error = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
console.warn = (...a: unknown[]) => void logs.push(a.map(String).join(" "));

/** The common assertions for a route that ran its one call. */
function ranOnce(label: string, route: keyof typeof AI_ROUTE_LIMITS, source: string) {
  t(`${label}: ${FULL_ORDER}`, backend.spendOrder() === FULL_ORDER, backend.spendOrder());
  const h = hold();
  t(
    `${label}: the hold is route ${route}, source ${source}, gpt-5-nano, the route's output limit, this user`,
    h?._feature === route &&
      h?._source === source &&
      h?._model === "gpt-5-nano" &&
      h?._max_output_tokens === AI_ROUTE_LIMITS[route].maxOutputTokens &&
      h?._user_id === USER &&
      h?._workspace_id === WS,
    JSON.stringify(h),
  );
  t(
    `${label}: the hold covers the request (max input ≤ the global bound) and the settle uses the same id`,
    h?._max_input_tokens > 0 && h?._max_input_tokens <= AI_MAX_INPUT_TOKENS && settle()?._request_id === h?._request_id,
  );
  const s = sent();
  t(
    `${label}: one request to the Responses API with the same model and limit, store off, minimal reasoning`,
    backend.providerHits().length === 1 &&
      backend.providerHits()[0]!.name === "/v1/responses" &&
      s?.model === "gpt-5-nano" &&
      s?.max_output_tokens === AI_ROUTE_LIMITS[route].maxOutputTokens &&
      s?.store === false &&
      s?.reasoning?.effort === "minimal" &&
      !("temperature" in (s ?? {})),
    JSON.stringify({ ...s, instructions: undefined, input: undefined }),
  );
}

try {
  // -------------------------------------------------------------------------
  console.log("\n=== SEO coach ===");
  const seoInput = { workspaceId: WS, messages: [{ role: "user" as const, content: "Where do I start?" }] };
  backend.reset(); // an ordinary workspace
  {
    const r = await runSeoCoachTurn(seoInput, USER);
    t(
      "an ordinary workspace is refused on the SERVER: the SEO Coach is not part of launch (round-4 M2)",
      r.ok === false && r.error === SEO_COACH_UNAVAILABLE_MESSAGE && backend.noSpend() && backend.rpcHits("tenant_get_workspace_secret").length === 0,
      JSON.stringify(r),
    );
    t("…decided by THE predicate for this workspace, after membership", backend.rpcHits("workspace_is_internal_unlimited")[0]?.body?._workspace_id === WS && backend.restHits("GET", "workspace_members").length > 0);
  }
  backend.reset();
  backend.rpc.workspace_is_internal_unlimited = () => ({ status: 500, body: { message: "read exploded" } });
  {
    const r = await runSeoCoachTurn(seoInput, USER);
    t("a failed entitlement read refuses too (fails closed), before any spend", r.ok === false && r.error === SEO_COACH_UNAVAILABLE_MESSAGE && backend.noSpend());
  }
  backend.reset();
  backend.rest["GET workspace_members"] = () => [];
  {
    const r = await runSeoCoachTurn(seoInput, USER);
    t("a non-member hears the generic sentence before the gate is even asked", r.ok === false && r.error === AI_MESSAGES.unavailable && backend.rpcHits("workspace_is_internal_unlimited").length === 0);
  }
  resetInternal();
  backend.openai = () => okText("**Q: Do you want to fix the 404s first?**");
  {
    const r = await runSeoCoachTurn(seoInput, USER);
    t("a member gets the model's reply", r.ok === true && r.reply.startsWith("**Q:"), JSON.stringify(r));
    ranOnce("seo coach", "seo_coach", "seo_coach");
    t(
      "the conversation goes as input messages, the system prompt as instructions",
      Array.isArray(sent()?.input) && sent()?.input[0]?.role === "user" && /SEO Coach/.test(sent()?.instructions ?? ""),
    );
    t("settled 'ok' with the reported usage", settle()?._outcome === "ok" && settle()?._input_tokens === 812);
  }
  resetInternal();
  backend.rest["GET workspace_members"] = () => [];
  {
    const r = await runSeoCoachTurn(seoInput, USER);
    t("a non-member is refused with the generic sentence, before any spend", r.ok === false && r.error === AI_MESSAGES.unavailable && backend.noSpend(), JSON.stringify(r));
    t("…and before the key is even read", backend.rpcHits("tenant_get_workspace_secret").length === 0);
  }
  resetInternal();
  backend.rpc.tenant_get_workspace_secret = () => null;
  {
    const r = await runSeoCoachTurn(seoInput, USER);
    t("no key (no BYOK, no platform key) is 'not available', before any spend", r.ok === false && r.error === AI_MESSAGES.notConfigured && backend.noSpend());
  }
  for (const [status, message] of [
    ["insufficient", AI_MESSAGES.outOfFunds],
    ["rate_limited", AI_MESSAGES.rateLimited],
    ["platform_paused", AI_MESSAGES.platformPaused],
    ["budget_exhausted", AI_MESSAGES.budgetExhausted],
  ] as const) {
    resetInternal();
    backend.rpc.ai_reserve = () => ({ status });
    const r = await runSeoCoachTurn(seoInput, USER);
    t(
      `a hold refused as '${status}' is its sentence, and the provider is never called`,
      r.ok === false && r.error === message && backend.providerHits().length === 0 && backend.rpcHits("ai_mark_called").length === 0,
      JSON.stringify(r),
    );
  }
  resetInternal();
  backend.openai = () => new Response("upstream exploded: trace 42", { status: 500 });
  {
    const r = await runSeoCoachTurn(seoInput, USER);
    t("a provider 500 is the generic provider sentence", r.ok === false && r.error === AI_MESSAGES.providerError, JSON.stringify(r));
    t("…settled 'failed' at the full hold, never released", settle()?._cost_micros === null && settle()?._error === "server_error" && backend.rpcHits("ai_release").length === 0);
    t("…and the provider text is only in the server log", !JSON.stringify(r).includes("exploded") && logs.some((l) => l.includes("exploded")));
  }
  // Round-4 L6: an exception that escapes callOpenAI AFTER the request left.
  // callOpenAI classifies every provider outcome itself; what can still
  // escape it after the send is a route's own format.parse throwing (it runs
  // after the response came back). Driven through the one metered flow.
  {
    const { runMeteredAiCall } = await import("../src/lib/ai/spend.server");
    const probe = (name: string, parse: (v: unknown) => unknown) => ({
      workspaceId: WS,
      userId: USER,
      requestId: crypto.randomUUID(),
      route: "seo_coach" as const,
      source: "seo_coach",
      key: { apiKey: "sk-byok-l6", source: "byok" as const },
      billingClass: "byok" as const,
      instructions: "Answer in JSON.",
      input: "Anything.",
      format: { name, schema: { type: "object", properties: {}, additionalProperties: false }, parse },
    });
    resetInternal();
    backend.openai = () => okJson({ any: "thing" });
    let thrown: unknown = null;
    try {
      await runMeteredAiCall(
        probe("l6_probe", () => {
          throw new Error("route parser exploded after the call");
        }),
      );
    } catch (e) {
      thrown = e;
    }
    t(
      "an exception after the request left propagates to the route (which answers its generic sentence)",
      errMsg(thrown) === "route parser exploded after the call" && backend.providerHits().length === 1,
      errMsg(thrown),
    );
    t(
      "…and is settled at the FULL HOLD on the platform budget (it may have been billed), the customer refunded (round-4 L6)",
      backend.spendOrder() === FULL_ORDER &&
        settle()?._outcome === "failed" &&
        settle()?._cost_micros === null &&
        settle()?._credits === null &&
        settle()?._error === "unknown" &&
        backend.rpcHits("ai_release").length === 0,
      JSON.stringify(settle()),
    );
    // The contrast: callOpenAI's own pre-send check throws BEFORE anything
    // left — settled at zero, never at the full hold.
    resetInternal();
    thrown = null;
    try {
      await runMeteredAiCall(probe("not a valid name!", (v) => v));
    } catch (e) {
      thrown = e;
    }
    t(
      "a pre-send refusal inside callOpenAI (OpenAiPreSendError) is settled at ZERO as not_sent, the provider never called",
      thrown !== null &&
        backend.providerHits().length === 0 &&
        settle()?._outcome === "failed" &&
        settle()?._cost_micros === 0 &&
        settle()?._credits === 0 &&
        settle()?._error === "not_sent",
      JSON.stringify(settle()),
    );
  }
  resetInternal();
  // A 200 whose output has a shape nothing expects is classified by
  // callOpenAI itself ('malformed', with the usage the API reported).
  backend.openai = () =>
    Response.json({ ...responseBody("x"), output: [{ type: "message", id: "m", status: "completed", role: "assistant", content: 5 }] });
  {
    const r = await runSeoCoachTurn(seoInput, USER);
    t("a response of an unexpected shape is the 'could not use' sentence", r.ok === false && r.error === AI_MESSAGES.malformed, JSON.stringify(r));
    t("…settled 'failed', never released", settle()?._outcome === "failed" && backend.rpcHits("ai_release").length === 0, JSON.stringify(settle()));
  }
  resetInternal();
  process.env.OPENAI_API_KEY = "sk-platform-flow";
  backend.rpc.tenant_get_workspace_secret = () => null;
  backend.rpc.ai_reserve = () => ({ status: "reserved", billing: "free_quota", hold_seq: 1, credits_charged: 0 });
  backend.openai = () => okText("Next: fix the 404s.");
  {
    const r = await runSeoCoachTurn(seoInput, USER);
    t(
      "on the platform key the hold is billed to the tenant, in whole credits (at least one)",
      r.ok === true && hold()?._billing_class === "tenant" && hold()?._max_credits >= 1 && backend.providerHits()[0]?.headers.get("authorization") === "Bearer sk-platform-flow",
      JSON.stringify(hold()),
    );
  }
  delete process.env.OPENAI_API_KEY;
  resetInternal();
  backend.openai = () => okText("ok");
  {
    const long = Array.from({ length: 40 }, (_, i) => ({
      role: (i % 2 ? "assistant" : "user") as "user" | "assistant",
      content: "x".repeat(7_900),
    }));
    long[39] = { role: "user", content: "latest question" };
    const r = await runSeoCoachTurn({ workspaceId: WS, messages: long }, USER);
    const sentChars = (sent()?.input ?? []).reduce((n: number, m: any) => n + String(m.content).length, 0);
    t(
      "a 40-turn conversation is trimmed to the newest turns that fit, and the hold is sized on what is sent",
      r.ok === true && sentChars <= SEO_COACH_MAX_CHARS && sent()?.input.at(-1)?.content === "latest question" && hold()?._max_input_tokens < 40 * 7_900,
      `${sentChars} chars, hold ${hold()?._max_input_tokens}`,
    );
  }

  // -------------------------------------------------------------------------
  console.log("\n=== page auditor ===");
  const auditOk = { score: 142, summary: "Solid page.", strengths: ["a"], weaknesses: ["b"], recommendations: ["c"] };
  const pageRow = { slug: "boats-austin", title: "Boats in Austin", meta_description: "Rent boats.", body_markdown: "Body", status: "published" };
  backend.reset(); // an ordinary workspace
  backend.rest["GET tenant_pages"] = (h) => (h.query.get("slug") === "eq.boats-austin" ? [pageRow] : []);
  {
    const r = await runPageAudit({ workspaceId: WS, url_path: "/a/boats-austin" }, USER);
    t(
      "an ordinary workspace is refused on the SERVER: the AI Page Auditor is not part of launch (round-4 M2)",
      r.ok === false && r.error === PAGE_AUDITOR_UNAVAILABLE_MESSAGE && backend.noSpend() && backend.restHits("GET", "tenant_pages").length === 0,
      JSON.stringify(r),
    );
  }
  resetInternal();
  {
    const r = await runPageAudit({ workspaceId: WS, url_path: "/a/nowhere" }, USER);
    t(
      "an unknown page is refused with suggestions, and costs nothing (no key read, no hold)",
      r.ok === false && r.error === PAGE_NOT_FOUND_MESSAGE && Array.isArray((r as any).suggestions) && backend.noSpend() && backend.rpcHits("tenant_get_workspace_secret").length === 0,
      JSON.stringify(r),
    );
  }
  resetInternal();
  backend.rest["GET tenant_pages"] = (h) => (h.query.get("slug") === "eq.boats-austin" ? [pageRow] : []);
  backend.rest["POST page_audits"] = (h) => [{ id: "audit-1", ...h.body, audited_at: "now" }];
  backend.openai = () => okJson(auditOk);
  {
    const r = await runPageAudit({ workspaceId: WS, url_path: "/a/boats-austin" }, USER);
    t("a found page is audited and stored", r.ok === true && (r as any).audit?.id === "audit-1", JSON.stringify(r));
    ranOnce("page audit", "page_audit", "page_audit");
    t(
      "Structured Outputs: the page_audit schema, strict",
      sent()?.text?.format?.type === "json_schema" && sent()?.text?.format?.name === "page_audit" && sent()?.text?.format?.strict === true,
    );
    const stored = backend.restHits("POST", "page_audits")[0]?.body;
    t("the stored score is clamped to 0-100", stored?.score === 100, JSON.stringify(stored));
  }
  resetInternal();
  backend.rest["GET tenant_pages"] = (h) => (h.query.get("slug") === "eq.boats-austin" ? [pageRow] : []);
  backend.rest["POST page_audits"] = () => ({ status: 500, body: { message: "insert exploded" } });
  backend.openai = () => okJson(auditOk);
  {
    const r = await runPageAudit({ workspaceId: WS, url_path: "/a/boats-austin" }, USER);
    t("an audit that could not be stored is the generic sentence, never the database text", r.ok === false && r.error === AI_MESSAGES.unavailable, JSON.stringify(r));
    t("…settled as not_delivered: the customer refunded", settle()?._outcome === "failed" && settle()?._error === "not_delivered" && settle()?._credits === 0);
  }
  resetInternal();
  backend.rest["GET tenant_pages"] = (h) => (h.query.get("slug") === "eq.boats-austin" ? [pageRow] : []);
  backend.openai = () => okJson({ score: "high" });
  {
    const r = await runPageAudit({ workspaceId: WS, url_path: "/a/boats-austin" }, USER);
    t("an answer outside the schema is the 'could not use' sentence", r.ok === false && r.error === AI_MESSAGES.malformed, JSON.stringify(r));
    t("…settled with the usage it cost, nothing stored", settle()?._error === "schema_mismatch" && settle()?._input_tokens === 812 && backend.restHits("POST", "page_audits").length === 0);
  }
  resetInternal();
  backend.rest["GET workspace_members"] = () => [];
  {
    const r = await runPageAudit({ workspaceId: WS, url_path: "/a/boats-austin" }, USER);
    t("a non-member is refused before any read of the page or any spend", r.ok === false && r.error === AI_MESSAGES.unavailable && backend.noSpend() && backend.restHits("GET", "tenant_pages").length === 0);
  }

  // -------------------------------------------------------------------------
  console.log("\n=== Daily Briefing actions: fix_thin_page ===");
  const thinPage = { id: PAGE_ID, title: "Boats", slug: "boats", body_markdown: "Short body.", meta_description: null };
  const action = (actionType: string, payload: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    CoachActionInputSchema.parse({ workspaceId: WS, actionType, payload, ...extra });
  async function run(input: any) {
    try {
      return { ok: await runCoachActionPipeline(input, USER), err: null as unknown };
    } catch (e) {
      return { ok: null, err: e };
    }
  }
  backend.reset();
  backend.rest["GET tenant_pages"] = (h) => (h.query.get("id") === `eq.${PAGE_ID}` ? [thinPage] : []);
  backend.openai = () => okText("## Expanded\n\n" + "Real words about boats. ".repeat(40));
  {
    const r = await run(action("fix_thin_page", { page_id: PAGE_ID }));
    t("a thin page is expanded and saved", r.ok?.ok === true && backend.restHits("PATCH", "tenant_pages").length === 1, errMsg(r.err));
    ranOnce("fix_thin_page", "fix_thin_page", "fix_thin_page");
    t("no Structured Outputs for free text", !sent()?.text);
  }
  backend.reset();
  {
    const r = await run(action("fix_thin_page", { page_id: PAGE_ID }));
    t("a page that is not in this workspace is refused before any spend", r.err instanceof CustomerFacingError && backend.noSpend(), errMsg(r.err));
  }
  backend.reset();
  backend.rest["GET tenant_pages"] = (h) => (h.query.get("id") === `eq.${PAGE_ID}` ? [thinPage] : []);
  backend.rest["PATCH tenant_pages"] = () => ({ status: 500, body: { message: "update exploded" } });
  backend.openai = () => okText("## Expanded\n\n" + "Real words about boats. ".repeat(40));
  {
    const r = await run(action("fix_thin_page", { page_id: PAGE_ID }));
    t("an expansion that could not be saved fails the action", r.err !== null && r.ok === null);
    t(
      "…and is settled AFTER the failed save as not_delivered: the customer refunded, the reported cost on the platform budget",
      settle()?._outcome === "failed" && settle()?._error === "not_delivered" && settle()?._credits === 0 && settle()?._input_tokens === 812 &&
        backend.rpcAt("ai_settle") > backend.indexOf((h) => h.kind === "rest" && h.method === "PATCH" && h.name === "tenant_pages"),
      JSON.stringify(settle()),
    );
  }
  backend.reset();
  backend.rest["GET tenant_pages"] = (h) => (h.query.get("id") === `eq.${PAGE_ID}` ? [thinPage] : []);
  backend.openai = () => okText("Too short.", { input: 300, output: 5 });
  {
    const r = await run(action("fix_thin_page", { page_id: PAGE_ID }));
    t("an expansion that is still thin is refused with a plain sentence and saves nothing", r.err instanceof CustomerFacingError && backend.restHits("PATCH", "tenant_pages").length === 0, errMsg(r.err));
    t("…settled 'failed' with the usage it cost", settle()?._outcome === "failed" && settle()?._error === "thin_output" && settle()?._input_tokens === 300);
  }
  backend.reset();
  backend.rest["GET tenant_pages"] = (h) => (h.query.get("id") === `eq.${PAGE_ID}` ? [thinPage] : []);
  // The page was deleted (or moved to another workspace) while the model ran:
  // the scoped update matches nothing.
  backend.rest["PATCH tenant_pages"] = () => [];
  backend.openai = () => okText("## Expanded\n\n" + "Real words about boats. ".repeat(40));
  {
    const r = await run(action("fix_thin_page", { page_id: PAGE_ID }));
    const patch = backend.restHits("PATCH", "tenant_pages")[0];
    t(
      "an expansion whose save updated NO row is not delivered: the not-found sentence (round-4 L4)",
      r.ok === null && r.err instanceof CustomerFacingError && errMsg(r.err) === "That page was not found in this workspace.",
      errMsg(r.err),
    );
    t(
      "…settled not_delivered (the customer refunded), and the update asked for the rows it touched, scoped to this workspace",
      settle()?._outcome === "failed" && settle()?._error === "not_delivered" && settle()?._credits === 0 &&
        (patch?.headers.get("prefer") ?? "").includes("return=representation") &&
        patch?.query.get("workspace_id") === `eq.${WS}` && patch?.query.get("id") === `eq.${PAGE_ID}`,
      JSON.stringify(settle()),
    );
  }

  // -------------------------------------------------------------------------
  console.log("\n=== Daily Briefing actions: add_meta (at most 20 pages, one hold each) ===");
  const ids = Array.from({ length: 25 }, (_, i) => `66666666-6666-4666-8666-${String(i).padStart(12, "0")}`);
  backend.reset();
  backend.rest["GET tenant_pages"] = (h) => {
    const inList = h.query.get("id") ?? "";
    if (!inList.startsWith("in.")) return [];
    const wanted = inList.slice(4, -1).split(",").map((s) => s.replace(/"/g, ""));
    return wanted.map((id) => ({ id, title: `Page ${id.slice(-2)}`, body_markdown: "Body", meta_description: null }));
  };
  backend.openai = () => okJson({ seo_title: "Title", seo_description: "A description." });
  {
    const r = await run(action("add_meta", { page_ids: ids }));
    t(
      `25 requested → exactly ${ADD_META_MAX_PAGES} holds, ${ADD_META_MAX_PAGES} provider calls, ${ADD_META_MAX_PAGES} settlements`,
      backend.rpcHits("ai_reserve").length === 20 && backend.providerHits().length === 20 && backend.rpcHits("ai_settle").length === 20,
      `${backend.rpcHits("ai_reserve").length} / ${backend.providerHits().length}`,
    );
    t("the pages read are the first 20 only", (backend.restHits("GET", "tenant_pages")[0]?.query.get("id") ?? "").split(",").length === 20);
    t("the summary says it did the first 20 of 25", /the first 20 of 25/.test(r.ok?.summary ?? ""), r.ok?.summary);
    t(
      "every hold is add_meta at its own limit, under its own id",
      backend.rpcHits("ai_reserve").every((h) => h.body._feature === "add_meta" && h.body._max_output_tokens === AI_ROUTE_LIMITS.add_meta.maxOutputTokens) &&
        new Set(backend.rpcHits("ai_reserve").map((h) => h.body._request_id)).size === 20,
    );
    t("Structured Outputs: page_meta, strict", sent()?.text?.format?.name === "page_meta" && sent()?.text?.format?.strict === true);
  }
  backend.reset();
  backend.rest["GET tenant_pages"] = () => ids.slice(0, 3).map((id) => ({ id, title: "P", body_markdown: "B", meta_description: null }));
  let metaWrites = 0;
  backend.rest["PATCH tenant_pages"] = () => (++metaWrites === 2 ? { status: 500, body: { message: "update exploded" } } : [{ id: "x" }]);
  backend.openai = () => okJson({ seo_title: "Title", seo_description: "A description." });
  {
    const r = await run(action("add_meta", { page_ids: ids.slice(0, 3) }));
    const outcomes = backend.rpcHits("ai_settle").map((h) => `${h.body._outcome}/${h.body._error ?? "-"}`);
    t(
      "a page whose meta could not be saved is skipped and refunded; the others are charged",
      /Updated meta on 2 of 3 pages/.test(r.ok?.summary ?? "") && outcomes.join() === "ok/-,failed/not_delivered,ok/-",
      `${r.ok?.summary} ${outcomes.join()}`,
    );
  }
  backend.reset();
  backend.rest["GET tenant_pages"] = () => ids.slice(0, 3).map((id) => ({ id, title: "P", body_markdown: "B", meta_description: null }));
  let metaZero = 0;
  // The middle page vanished during its call: its update touches no row.
  backend.rest["PATCH tenant_pages"] = () => (++metaZero === 2 ? [] : [{ id: "x" }]);
  backend.openai = () => okJson({ seo_title: "Title", seo_description: "A description." });
  {
    const r = await run(action("add_meta", { page_ids: ids.slice(0, 3) }));
    const outcomes = backend.rpcHits("ai_settle").map((h) => `${h.body._outcome}/${h.body._error ?? "-"}`);
    t(
      "a page whose meta update touched NO row is not counted and is refused a charge; the others are charged (round-4 L4)",
      /Updated meta on 2 of 3 pages/.test(r.ok?.summary ?? "") && outcomes.join() === "ok/-,failed/not_delivered,ok/-" &&
        backend.rpcHits("ai_settle")[1]?.body._credits === 0,
      `${r.ok?.summary} ${outcomes.join()}`,
    );
  }
  backend.reset();
  backend.rest["GET tenant_pages"] = () => ids.slice(0, 3).map((id) => ({ id, title: "P", body_markdown: "B", meta_description: null }));
  backend.rpc.ai_reserve = () => ({ status: "insufficient" });
  {
    const r = await run(action("add_meta", { page_ids: ids.slice(0, 3) }));
    t(
      "an empty allowance stops at the first page: one refused hold, no provider call, the customer sentence",
      r.err instanceof CustomerFacingError && errMsg(r.err) === AI_MESSAGES.outOfFunds && backend.rpcHits("ai_reserve").length === 1 && backend.providerHits().length === 0,
      errMsg(r.err),
    );
  }

  // -------------------------------------------------------------------------
  console.log("\n=== Daily Briefing actions: add_internal_links ===");
  const linkPage = { id: PAGE_ID, title: "Boats", slug: "boats", body_markdown: "# Boats\n\n" + "Plain text about boats. ".repeat(20), meta_description: null };
  const withLinks = linkPage.body_markdown + "\n\nSee [kayaks](/a/kayaks) and [canoes](/a/canoes) and [rafts](/a/rafts).";
  const linksBackend = () => {
    backend.rest["GET tenant_pages"] = (h) => {
      if (h.query.get("id") === `eq.${PAGE_ID}`) return [linkPage];
      if (h.query.get("status") === "eq.published") return [{ title: "Kayaks", slug: "kayaks" }, { title: "Canoes", slug: "canoes" }, { title: "Rafts", slug: "rafts" }];
      return [];
    };
  };
  backend.reset();
  linksBackend();
  backend.openai = () => okText(withLinks);
  {
    const r = await run(action("add_internal_links", { page_id: PAGE_ID }));
    t("links are added and saved", r.ok?.ok === true && /Added 3 internal links/.test(r.ok.summary) && backend.restHits("PATCH", "tenant_pages").length === 1, errMsg(r.err) || r.ok?.summary);
    ranOnce("add_internal_links", "add_internal_links", "add_internal_links");
  }
  backend.reset();
  linksBackend();
  backend.openai = () => okText(linkPage.body_markdown);
  {
    const r = await run(action("add_internal_links", { page_id: PAGE_ID }));
    t("an answer that adds no link is refused, saves nothing, and is settled as paid", r.err instanceof CustomerFacingError && backend.restHits("PATCH", "tenant_pages").length === 0 && settle()?._error === "no_links_added");
  }
  backend.reset();
  linksBackend();
  backend.openai = () => okText("[x](/a/kayaks)");
  {
    const r = await run(action("add_internal_links", { page_id: PAGE_ID }));
    t("an answer that drops the page is refused and saves nothing", r.err instanceof CustomerFacingError && backend.restHits("PATCH", "tenant_pages").length === 0 && settle()?._error === "content_lost");
  }
  backend.reset();
  linksBackend();
  backend.rest["PATCH tenant_pages"] = () => [];
  backend.openai = () => okText(withLinks);
  {
    const r = await run(action("add_internal_links", { page_id: PAGE_ID }));
    t(
      "links whose save updated NO row are not delivered: the not-found sentence, settled not_delivered, refunded (round-4 L4)",
      r.ok === null && r.err instanceof CustomerFacingError && errMsg(r.err) === "That page was not found in this workspace." &&
        settle()?._outcome === "failed" && settle()?._error === "not_delivered" && settle()?._credits === 0,
      `${errMsg(r.err)} ${JSON.stringify(settle())}`,
    );
  }
  backend.reset();
  backend.rest["GET tenant_pages"] = (h) => (h.query.get("id") === `eq.${PAGE_ID}` ? [linkPage] : []);
  {
    const r = await run(action("add_internal_links", { page_id: PAGE_ID }));
    t("no published page to link to is a refusal before any spend", r.err instanceof CustomerFacingError && backend.noSpend());
  }

  // -------------------------------------------------------------------------
  console.log("\n=== Daily Briefing actions: create_city_page (through the generation core) ===");
  const BRIEFING = "77777777-7777-4777-8777-777777777777";
  const pageBody = { title: "Boat rentals in Austin, TX", seo_title: "Boat rentals in Austin", seo_description: "Rent a boat.", body_markdown: "# Austin\n\n" + "Real copy. ".repeat(60) };
  backend.reset();
  backend.openai = () => okJson(pageBody);
  {
    const r = await run(action("create_city_page", { city: "Austin", state: "TX" }, { briefingId: BRIEFING, insightIndex: 1 }));
    const expectedId = await deterministicRequestId(`coach:${BRIEFING}:1`);
    t("a draft is written", r.ok?.ok === true && backend.restHits("POST", "tenant_pages").length === 1 && backend.restHits("POST", "tenant_pages")[0]?.body?.status !== "published", errMsg(r.err));
    t(
      "slot → hold → marks → provider → settle, all under the insight's deterministic id",
      backend.rpcHits("reserve_generation_slot")[0]?.body?._request_id === expectedId &&
        hold()?._request_id === expectedId &&
        backend.rpcAt("reserve_generation_slot") < backend.rpcAt("ai_reserve") &&
        backend.spendOrder() === FULL_ORDER,
      backend.spendOrder(),
    );
    t(
      "the hold is page generation, standard model, source coach_city_page",
      hold()?._feature === "page_generation" && hold()?._model === "gpt-5-nano" && hold()?._source === "coach_city_page",
      JSON.stringify(hold()),
    );
  }
  backend.reset();
  backend.rest["GET tenant_pages"] = (h) =>
    (h.query.get("variables->>city") ?? "").startsWith("ilike.") ? [{ id: "page-x", slug: "austin", variables: { city: "Austin", state: "TX" } }] : [];
  {
    const r = await run(action("create_city_page", { city: "Austin", state: "TX" }));
    t("a city that already has a page is refused before any slot or spend", r.err instanceof CustomerFacingError && backend.rpcHits("reserve_generation_slot").length === 0 && backend.noSpend(), errMsg(r.err));
  }

  // -------------------------------------------------------------------------
  console.log("\n=== Opportunity Engine: approve → one generation under the opportunity's id ===");
  {
    const OPP = "88888888-8888-4888-8888-888888888888";
    const oppRow = {
      id: OPP,
      workspace_id: WS,
      recommendation: "BUILD_NEW_PAGE",
      status: "approved",
      intent_key: "boats|austin",
      intent_label: "Boat rentals in Austin",
      proposed_title: "Boat rentals in Austin, TX",
      proposed_slug: "boat-rentals-austin",
      geo_city: "Austin",
      geo_state: "TX",
      normalized_geo: "austin|tx",
      normalized_category: "boats",
      query_variants: ["boat rental austin"],
      ranking_urls: [],
    };
    const oppWorld = () => {
      backend.reset();
      process.env.OPPORTUNITY_ENGINE_ENABLED = "1";
      backend.rest["GET feature_enrollments"] = () => [{ workspace_id: WS }];
      backend.rest["GET seo_opportunities"] = (h) => (h.query.get("id") === `eq.${OPP}` ? [oppRow] : []);
      backend.openai = () => okJson(pageBody);
    };
    const approve = async () => {
      try {
        return { ok: await runApproveOpportunity({ workspaceId: WS, id: OPP }, USER), err: null as unknown };
      } catch (e) {
        return { ok: null, err: e };
      }
    };
    oppWorld();
    {
      const r = await approve();
      t("an approved opportunity becomes a draft", (r.ok as any)?.ok === true && backend.restHits("POST", "tenant_pages").length === 1, errMsg(r.err) || JSON.stringify(r.ok));
      t(
        "the opportunity id is the request id of the slot and of the hold",
        backend.rpcHits("reserve_generation_slot")[0]?.body?._request_id === OPP && hold()?._request_id === OPP,
      );
      t(
        "slot → hold → marks → provider → settle; page generation, standard model, source opportunity",
        backend.spendOrder() === FULL_ORDER && hold()?._feature === "page_generation" && hold()?._model === "gpt-5-nano" && hold()?._source === "opportunity",
        backend.spendOrder() + " " + JSON.stringify(hold()),
      );
      t(
        "the 'generating' transition was taken before any spend",
        backend.indexOf((h) => h.kind === "rest" && h.method === "PATCH" && h.name === "seo_opportunities" && h.body?.status === "generating") <
          backend.rpcAt("reserve_generation_slot"),
      );
    }
    oppWorld();
    backend.rest["PATCH seo_opportunities"] = (h) => (h.body?.status === "generating" ? [] : [{ id: OPP }]);
    {
      const r = await approve();
      t(
        "a second approve (already generating or drafted) is refused before any slot or spend",
        (r.ok as any)?.ok === false && (r.ok as any)?.error === "This opportunity is already being generated or has a page." && backend.rpcHits("reserve_generation_slot").length === 0 && backend.noSpend(),
        JSON.stringify(r.ok),
      );
    }
    oppWorld();
    backend.rest["GET workspace_members"] = () => [{ role: "member" }];
    {
      const r = await approve();
      t("a member who is not the owner is refused before anything is read or spent", r.err !== null && backend.noSpend() && backend.restHits("GET", "seo_opportunities").length === 0);
    }
    oppWorld();
    process.env.OPPORTUNITY_ENGINE_ENABLED = "";
    {
      const r = await approve();
      t("with the engine switched off nothing runs", r.err !== null && backend.noSpend());
    }
    // Enrollment and the founder / internal unlimited entitlement (round 5).
    oppWorld();
    backend.rest["GET feature_enrollments"] = () => [];
    {
      const r = await approve();
      t(
        "a workspace that is not enrolled is refused before anything is read or spent",
        r.err !== null && backend.noSpend() && backend.restHits("GET", "seo_opportunities").length === 0 &&
          backend.rpcHits("workspace_is_internal_unlimited")[0]?.body?._workspace_id === WS,
        errMsg(r.err),
      );
    }
    oppWorld();
    backend.rest["GET feature_enrollments"] = () => [];
    backend.rpc.workspace_is_internal_unlimited = () => true;
    {
      const r = await approve();
      t(
        "…unless it holds the internal unlimited entitlement: then it counts as enrolled and the approve runs",
        (r.ok as any)?.ok === true && backend.spendOrder() === FULL_ORDER,
        errMsg(r.err) || JSON.stringify(r.ok),
      );
    }
    oppWorld();
    backend.rest["GET feature_enrollments"] = () => [];
    backend.rpc.workspace_is_internal_unlimited = () => ({ status: 500, body: { message: "read exploded" } });
    {
      const r = await approve();
      t("a failed entitlement read is 'not enrolled' (fails closed), before any spend", r.err !== null && backend.noSpend());
    }
    oppWorld();
    process.env.OPPORTUNITY_ENGINE_ENABLED = "";
    backend.rpc.workspace_is_internal_unlimited = () => true;
    {
      const r = await approve();
      t("the global switch still applies to an internal workspace", r.err !== null && backend.noSpend());
    }
    delete process.env.OPPORTUNITY_ENGINE_ENABLED;
  }

  // -------------------------------------------------------------------------
  console.log("\n=== the action input is strict ===");
  const base = { workspaceId: WS };
  for (const [label, body] of [
    ["a model at the top level", { ...base, actionType: "fix_thin_page", payload: { page_id: PAGE_ID }, model: "gpt-5-mini" }],
    ["a model inside the payload", { ...base, actionType: "fix_thin_page", payload: { page_id: PAGE_ID, model: "gpt-5-mini" } }],
    ["max_output_tokens", { ...base, actionType: "add_internal_links", payload: { page_id: PAGE_ID }, max_output_tokens: 99_999 }],
    ["a quality tier (actions have none)", { ...base, actionType: "add_meta", payload: { page_ids: [PAGE_ID] }, quality: "premium" }],
    ["temperature inside a city payload", { ...base, actionType: "create_city_page", payload: { city: "Austin", temperature: 2 } }],
    ["an unknown action", { ...base, actionType: "rewrite_site", payload: {} }],
    ["more than 100 add_meta ids", { ...base, actionType: "add_meta", payload: { page_ids: Array.from({ length: 101 }, () => PAGE_ID) } }],
    ["a non-uuid page id", { ...base, actionType: "fix_thin_page", payload: { page_id: "../../etc" } }],
  ] as const) {
    t(`rejects ${label}`, !CoachActionInputSchema.safeParse(body).success);
  }
  t(
    "accepts the exact shapes the briefing produces",
    CoachActionInputSchema.safeParse({ ...base, actionType: "fix_thin_page", payload: { page_id: PAGE_ID } }).success &&
      CoachActionInputSchema.safeParse({ ...base, actionType: "add_meta", payload: { page_ids: [PAGE_ID] } }).success &&
      CoachActionInputSchema.safeParse({ ...base, actionType: "create_city_page", payload: { city: "austin" } }).success &&
      CoachActionInputSchema.safeParse({ ...base, actionType: "create_city_page", payload: { city: "Austin", state: "TX" } }).success,
  );

  // -------------------------------------------------------------------------
  console.log("\n=== on-demand briefing request (the app side) ===");
  {
    process.env.CRON_SECRET = "cron-secret-for-tests";
    process.env.SUPABASE_PUBLISHABLE_KEY = "publishable-for-tests";
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const answer = (status: number, body: unknown) => async (url: any, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    };
    for (const status of ["created", "exists", "in_progress"] as const) {
      calls.length = 0;
      const r = await requestBriefing(WS, { fetch: answer(200, { processed: 1, results: [{ workspace_id: WS, status }] }) });
      t(`'${status}' comes back as a status`, r.ok === true && (r as any).status === status, JSON.stringify(r));
    }
    const req = calls[0]!;
    t("one POST to coach-briefing-cron, for this workspace only", req.url === "http://supabase.test/functions/v1/coach-briefing-cron" && req.init?.method === "POST" && JSON.parse(String(req.init?.body)).workspace_id === WS);
    t("it presents the cron secret (the function fails closed without it)", new Headers(req.init?.headers).get("x-cron-secret") === "cron-secret-for-tests");
    t("it carries a timeout signal", req.init?.signal instanceof AbortSignal);
    const bad = await requestBriefing(WS, { fetch: answer(500, "internal detail: relation coach_x does not exist") });
    t("a failing function is the fixed sentence, never its body", bad.ok === false && (bad as any).error === BRIEFING_FAILED_MESSAGE);
    const odd = await requestBriefing(WS, { fetch: answer(200, { results: [{ workspace_id: WS, status: "error" }] }) });
    t("an 'error' status is the fixed sentence", odd.ok === false && (odd as any).error === BRIEFING_FAILED_MESSAGE);
    const other = await requestBriefing(WS, { fetch: answer(200, { results: [{ workspace_id: "someone-else", status: "created" }] }) });
    t("a result for another workspace is not taken as this one's", other.ok === false);
    const down = await requestBriefing(WS, {
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });
    t("a network failure is the fixed sentence", down.ok === false && (down as any).error === BRIEFING_FAILED_MESSAGE);
    delete process.env.CRON_SECRET;
    calls.length = 0;
    const unset = await requestBriefing(WS, { fetch: answer(200, {}) });
    t("without CRON_SECRET nothing is sent at all", unset.ok === false && calls.length === 0);
  }
} finally {
  console.error = origError;
  console.warn = origWarn;
}

{
  const pkg = readFileSync(join(import.meta.dir, "..", "package.json"), "utf8");
  t("this suite is in the test chain", /bun tests\/ai-flows\.test\.ts/.test(pkg));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  console.log("Failed:", failed.join(", "));
  process.exit(1);
}

/**
 * DEFERRED FEATURES — the server-side half of the MVP scope (owner, 2026-09-28).
 *
 * The MVP is one journey: connect Sharetribe → sync listings → coverage
 * opportunities → template → draft → edit and preview → publish on the
 * verified domain → sitemap. Everything else is DEFERRED: hidden in the app
 * (src/lib/app-nav.ts, the route guards in src/lib/deferred-route.ts) AND
 * refused here. Hiding a screen is not closing a product — its server
 * functions stay reachable by anyone who posts to them — so every deferred
 * server function calls `assertFeatureAvailable(<its feature>)` as the FIRST
 * statement of its handler, before any database write, paid API or AI call.
 *
 * Off for everyone by default: ordinary customers, the founder / internal
 * unlimited workspace and platform admins alike. No billing entitlement,
 * add-on row, internal grant or URL parameter turns a feature back on.
 *
 * Re-enabling is an ops decision, never a client one: the service-role-only
 * row platform_settings.enabled_deferred_features (a JSON array of the ids
 * below) lists the features turned back on platform-wide. Anything else — no
 * row, a malformed value, an unknown id, a failed read — means OFF: the gate
 * FAILS CLOSED.
 *
 *   -- turn the affiliate tools back on (SQL editor, service role):
 *   INSERT INTO public.platform_settings (key, value)
 *   VALUES ('enabled_deferred_features', '["affiliates"]'::jsonb)
 *   ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
 *
 * NEVER import from client code.
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";

export const DEFERRED_FEATURES = [
  /** Affiliate programs: dashboard, programs, affiliates, payouts, public sign-up, referral sync. */
  "affiliates",
  /** The Add-ons catalogue and add-on requests (checkout refuses mode "addon" on its own). */
  "addons",
  /** The Coach: conversations, confirmed coach actions, the SEO Coach chat. */
  "coach",
  /** The daily briefing: reading, generating (an AI call) and dismissing insights. */
  "briefing",
  /** GSC import, keyword opportunities, internal-link suggestions, the 404 log, the click report. */
  "seo_tools",
  /** Rank tracker (SerpAPI). */
  "rank_tracker",
  /** Competitor tracker (Firecrawl scrape). */
  "competitor_tools",
  /** AI page auditor, link checker, content health. */
  "audits",
  /** Lead inbox and lead hunters (stub screens; no server functions of their own yet). */
  "lead_tools",
  /** Bulk editor over the legacy content_pages. */
  "bulk_editor",
  /** CSV import into the legacy content tables. */
  "data_import",
  /** Bring-your-own OpenAI key: saving, removing and testing it. */
  "byok_settings",
  /** Workspace API keys (workspace_secrets managed by hand). */
  "workspace_api_keys",
  /** The old Opportunity Engine (site scan → seo_opportunities), replaced by the coverage service. */
  "legacy_opportunity_engine",
] as const;

export type DeferredFeature = (typeof DEFERRED_FEATURES)[number];

/** What a refused call answers — a customer sentence, nothing about why or how. */
export const FEATURE_UNAVAILABLE_MESSAGE = "This part of Founders.click isn't available right now.";

/** The platform_settings key an operator writes to turn deferred features back on. */
export const ENABLED_DEFERRED_FEATURES_KEY = "enabled_deferred_features";

/** The thrown refusal. `customerFacing` lets userMessage show it as is in-process. */
export class FeatureUnavailableError extends Error {
  readonly customerFacing = true;
  readonly feature: DeferredFeature;
  constructor(feature: DeferredFeature) {
    super(FEATURE_UNAVAILABLE_MESSAGE);
    this.name = "FeatureUnavailableError";
    this.feature = feature;
  }
}

/** The slice of a Supabase client the gate reads with (injectable in tests). */
export type FeatureSettingsReader = {
  from: (table: string) => any;
};

export function isDeferredFeature(value: unknown): value is DeferredFeature {
  return typeof value === "string" && (DEFERRED_FEATURES as readonly string[]).includes(value);
}

/**
 * The ids an operator re-enabled, from the stored value. Only a JSON array of
 * known ids counts; any other shape (a string, an object, a number, null)
 * enables nothing, and an unknown id is ignored.
 */
export function parseEnabledFeatures(value: unknown): Set<DeferredFeature> {
  const out = new Set<DeferredFeature>();
  if (!Array.isArray(value)) return out;
  for (const v of value) if (isDeferredFeature(v)) out.add(v);
  return out;
}

/**
 * Is this deferred feature turned back on? Read fresh on every call (no
 * cache: an operator's switch takes effect on the next request). False on
 * any read error — the gate fails closed.
 */
export async function isFeatureAvailable(
  feature: DeferredFeature,
  db?: FeatureSettingsReader,
): Promise<boolean> {
  if (!isDeferredFeature(feature)) return false;
  try {
    const client = db ?? (supabaseAdmin as unknown as FeatureSettingsReader);
    const { data, error } = await client
      .from("platform_settings")
      .select("value")
      .eq("key", ENABLED_DEFERRED_FEATURES_KEY)
      .maybeSingle();
    if (error) {
      console.error("[features] enabled_deferred_features read failed", error.message ?? "error");
      return false;
    }
    return parseEnabledFeatures((data as { value?: unknown } | null)?.value).has(feature);
  } catch (e) {
    console.error(
      "[features] enabled_deferred_features read threw",
      e instanceof Error ? e.message : "error",
    );
    return false;
  }
}

/**
 * The gate: returns only when an operator has turned `feature` back on;
 * otherwise throws FeatureUnavailableError (FEATURE_UNAVAILABLE_MESSAGE).
 * Call it first in every deferred server-function handler.
 */
export async function assertFeatureAvailable(
  feature: DeferredFeature,
  db?: FeatureSettingsReader,
): Promise<void> {
  if (await isFeatureAvailable(feature, db)) return;
  throw new FeatureUnavailableError(feature);
}

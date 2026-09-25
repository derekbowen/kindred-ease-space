/**
 * The app's side of the daily briefing: ask the coach-briefing-cron Supabase
 * function (the only Supabase function that can make an OpenAI request) for
 * TODAY's briefing of one workspace.
 *
 * The function is idempotent per (workspace, UTC date): the first request of
 * the day generates the briefing (at most one AI call, reserved and settled
 * like every other), every later or concurrent one gets the SAME stored row
 * — 'exists', or 'in_progress' while the first run is still writing it.
 * Pressing Refresh never re-rolls the insights and never causes a second AI
 * call.
 *
 * What comes back to the browser is a status or a fixed sentence — never the
 * function's response text.
 *
 * refreshBriefing is what the dashboard's Refresh button runs
 * (generateBriefingNow): at most ONE refresh per workspace every
 * BRIEFING_REFRESH_INTERVAL_SECONDS reaches the function
 * (coach_briefing_refresh_allowed, migration 20260925000800; round-4 security
 * L9). A throttled refresh answers with the day's stored briefing when there
 * is one — a refresh never re-rolls it anyway.
 *
 * NEVER import from client code.
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type BriefingRequestResult =
  | { ok: true; status: "exists" | "created" | "in_progress" }
  | { ok: false; error: string };

export const BRIEFING_FAILED_MESSAGE =
  "Couldn't prepare today's briefing. Try again in a few minutes.";

/** One on-demand refresh per workspace per this many seconds. */
export const BRIEFING_REFRESH_INTERVAL_SECONDS = 600;

export const BRIEFING_THROTTLED_MESSAGE =
  "Today's briefing was requested a few minutes ago. Try again in 10 minutes.";

type RpcAndFrom = {
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
  from: (table: string) => any;
};

/**
 * The Refresh button: the throttle first (atomic, per workspace), then the
 * function. A throttled refresh never reaches the function: it answers
 * 'exists' when today's briefing is stored, otherwise the throttled
 * sentence. A throttle read error fails closed (no function call).
 */
export async function refreshBriefing(
  workspaceId: string,
  deps: { fetch?: FetchLike; db?: RpcAndFrom } = {},
): Promise<BriefingRequestResult> {
  const db = deps.db ?? (supabaseAdmin as unknown as RpcAndFrom);
  const { data: allowed, error } = await db.rpc("coach_briefing_refresh_allowed", {
    _workspace_id: workspaceId,
    _min_interval_seconds: BRIEFING_REFRESH_INTERVAL_SECONDS,
  });
  if (error) {
    console.error("[briefing] refresh throttle read failed", error.message);
    return { ok: false, error: BRIEFING_FAILED_MESSAGE };
  }
  if (allowed !== true) {
    const today = new Date().toISOString().slice(0, 10);
    const { data: row } = await db
      .from("coach_daily_briefings")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("briefing_date", today)
      .maybeSingle();
    return row ? { ok: true, status: "exists" } : { ok: false, error: BRIEFING_THROTTLED_MESSAGE };
  }
  return requestBriefing(workspaceId, deps);
}

const OK_STATUSES = new Set(["exists", "created", "in_progress"]);

export async function requestBriefing(
  workspaceId: string,
  deps: { fetch?: FetchLike } = {},
): Promise<BriefingRequestResult> {
  const base = process.env.SUPABASE_URL;
  const secret = process.env.CRON_SECRET;
  if (!base || !secret) {
    console.error("[briefing] SUPABASE_URL or CRON_SECRET is not configured");
    return { ok: false, error: BRIEFING_FAILED_MESSAGE };
  }
  const doFetch: FetchLike = deps.fetch ?? ((i, init) => globalThis.fetch(i, init));
  let res: Response;
  try {
    res = await doFetch(`${base}/functions/v1/coach-briefing-cron`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: process.env.SUPABASE_PUBLISHABLE_KEY ?? "",
        // The function's CRON_SECRET gate (fails closed without it).
        "x-cron-secret": secret,
      },
      body: JSON.stringify({ workspace_id: workspaceId }),
      // The function waits up to ~20 s for a run already in flight; the AI
      // call itself is capped at 60 s.
      signal: AbortSignal.timeout(90_000),
    });
  } catch (e) {
    console.error("[briefing] request failed", e instanceof Error ? e.name : "error");
    return { ok: false, error: BRIEFING_FAILED_MESSAGE };
  }
  if (!res.ok) {
    // Status only: the body is the function's, not the customer's.
    console.error("[briefing] function answered", res.status);
    return { ok: false, error: BRIEFING_FAILED_MESSAGE };
  }
  const body = (await res.json().catch(() => null)) as {
    results?: Array<{ workspace_id?: string; status?: string }>;
  } | null;
  const status = body?.results?.find((r) => r.workspace_id === workspaceId)?.status;
  if (status && OK_STATUSES.has(status)) {
    return { ok: true, status: status as "exists" | "created" | "in_progress" };
  }
  console.error("[briefing] unexpected result", status ?? "none");
  return { ok: false, error: BRIEFING_FAILED_MESSAGE };
}

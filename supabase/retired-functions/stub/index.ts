// RETIRED ENDPOINT (founders.click MVP release, 2026-09-29).
//
// Deployed in place of the four Founders-only AI functions ai-proxy,
// coach-chat, help-assistant-chat and help-assistant-embed. Each called an AI
// provider outside the metered spend pipeline (ai_reserve / ai_settle), none
// has a caller in the app, and none was invoked in the 24 hours before this
// replaced them. The stub reads nothing, calls nothing and charges nothing:
// every request, including a CORS preflight, gets 410 with a fixed body the
// PRNM isolation probe recognises (scripts/probe-prnm-isolation.ts).
//
// Rollback (reversible by design): redeploy the previous source from git —
//   git show 179205d^:supabase/functions/<name>/index.ts
// (with the _shared files of that commit) under the same function name and
// its old verify_jwt setting (help-assistant-chat: off; the rest: on).
// Deleting the functions for good still needs the owner's approval
// (docs/RELEASE_CHECKLIST.md §8).
//
// Also deployed as coach-briefing-cron for the MVP (the daily briefing is
// deferred): redeploy supabase/functions/coach-briefing-cron (verify_jwt off)
// to bring it back.
const BODY = JSON.stringify({
  error: "retired_endpoint",
  message: "This founders.click endpoint has been retired.",
});

Deno.serve(() =>
  new Response(BODY, {
    status: 410,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  })
);

# Incidents

Real production incidents, recorded so their lessons outlive the sessions that
fixed them. Newest first.

---

## 2026-09-01 — Signup down platform-wide (~65 minutes)

**Impact.** Every signup failed with a 500 from Supabase Auth between roughly
06:26 and 07:31 UTC. No existing session, page, or customer-facing surface was
affected — only the creation of new accounts. Zero paying customers existed,
so no revenue impact; had launch already happened this would have been a
customer-facing outage.

**Detection.** The golden-path E2E smoke, run against production for the first
time about an hour after the break. Nothing else noticed: the homepage was
200, the deploy was green, the build-identity check matched, and the
production monitor passed — signup was not on any check.

**Root cause.** The Supabase Auth *send-email hook* pointed at
`https://founders-click.derekbowencorp.workers.dev/lovab…` — a route served
only by the May 2026 build of the Worker, from an app generation whose code
never existed in this repository. That stale Worker had been quietly doubling
as auth-email infrastructure for four months. The first CI deploy
(2026-09-01 06:26 UTC) replaced the script; the route became a 404; GoTrue
treats a failed hook as a failed signup:

```
{"code":"unexpected_failure","message":"Unexpected status code returned from hook: 404"}
```

The only artefact hinting at any of this was a `SEND_EMAIL_HOOK_SECRET` env
entry on the Worker, which — having zero references in the codebase — had been
catalogued as dead configuration.

**Resolution.**
1. Implemented the hook in-repo: `/api/public/hooks/auth-send-email`
   (standard-webhooks signature verification, EmailIt delivery, branded copy
   for all seven GoTrue action types; `src/lib/auth-email-hook.ts` +
   24 unit assertions on the signature boundary).
2. Deployed through the normal pipeline (`1d02524`).
3. Repointed the hook's Endpoint in the Supabase dashboard to the new URL.
   The Worker's existing May-era secret still matched the dashboard's, so no
   secret rotation was needed.
4. Verified by re-running the E2E: signup reaches the confirmation screen.

**Lessons, encoded rather than remembered.**
- *Out-of-repo infrastructure is severed by the first honest deploy.* The fix
  is not more care during deploys; it is that load-bearing endpoints live in
  version control. The hook target now does.
- *"Dead" configuration is a claim, not an observation.* The env entry with
  zero code references was the one thread that led anywhere. Before deleting
  an unreferenced secret, find what consumes it server-side (here: a Supabase
  dashboard setting no grep could see).
- *A monitor only guards what it probes.* Homepage + build identity said
  everything was fine while signup was down. The production monitor now
  probes the hook unauthenticated every 30 minutes: `401 invalid signature`
  is healthy; `404` or `401 hook not configured` alarms as SIGNUP DOWN.
- *The E2E paid for itself in its first hour.* It exists because "deployment
  works" was explicitly not accepted as "product works".

**Residue.**
- The workers.dev URL is no longer load-bearing (hook now targets `www`), so
  disabling that second public endpoint is unblocked — backlog.
- Email *delivery* through EmailIt was not directly proven (the hook returns
  200 on delivery failure by design); a real-inbox signup confirms it.

# founders.click — live acceptance test (baseline)

Tested as a customer, in a real Chromium browser, against the deployed
product at https://www.founders.click. Started 2026-09-02 06:48 UTC; email
delivery followed up through 2026-09-05 05:09 UTC. Nothing was pushed,
deployed, reconfigured, or written to the database during this baseline.
Dedicated test accounts and test content only; no card was ever entered.

Evidence: `docs/evidence/live-acceptance-2026-09-02/` — one `records.json`
per phase (feature, promise, URL, account/browser, preconditions, exact
actions, expected, actual, screenshot, network calls with bodies on
4xx/5xx, console errors, persistence, status, severity, repro), the
screenshots those records name, the Phase 1 matrix
(`phase1-inventory/feature-matrix.md`, 121 features), and the generated
tables (`TABLES.md`: status counts, defect log, full evidence matrix).
Harness and scripts: `tests/e2e/live/`.

Status rule applied throughout: **Verified** only when the whole customer
outcome happened through the deployed UI with evidence. Code, unit tests,
an accepted API request, a database row, or a rendered button are not
verification.

---

## 1. Product reality

### What a customer successfully accomplished

Through the public site, without an account (77 Verified records):

- Read the marketing page: hero, "Everything included" grid, pricing for
  five plans ($29–$299), FAQ accordion operable by keyboard; all 11 links
  resolve; no console errors; JSON-LD present.
- Used the help centre: home, category, article, search with results (7
  for "Sharetribe") and the no-results state with contact links.
- Read real, dated Terms and Privacy pages linked from the footer.
- Was correctly refused on the signup form for empty, malformed-email and
  short-password input; saw "Invalid login credentials" 0.8 s after a wrong
  password; could Tab straight to "Sign in".
- Submitted a support ticket and saw "Ticket received — your ticket ID is
  …. We'll email you shortly." (the email never came; see below).
- Was bounced from every `/app/*` URL to `/login?next=…` with no data
  rendered (12+ routes probed), including after corrupting the stored
  session; a fresh profile carried no state.
- Got a branded HTTP 404 for unknown routes, unknown `/a/` and `/s/` slugs,
  and an unknown `/apply/` program; `/p/x` 301s to `/a/x`.
- robots.txt, `/sitemap.xml` (4 URLs) and `/help/sitemap.xml` (21 URLs) served
  with correct content types.
- Could not extract any secret from browser output on four public pages;
  every server function refused calls with no Authorization header (401);
  every `/api/public/*` endpoint answered without stack traces or tenant data;
  the auth-email hook refused an unsigned call (401 invalid signature).
- Loaded the landing page on a 400 kbps / 400 ms connection: headline at
  4.0 s, interactive at 13.7 s.

**And that is where the customer's journey ends.** No test account could be
activated, so nothing behind the login was reached.

### What failed

| Sev | Failure | What the customer sees | Evidence |
|---|---|---|---|
| **P0** | **Transactional email is not delivered — at all.** Two signup confirmations (06:48 and 07:21 UTC, Gmail aliases), one support-ticket receipt (06:51 UTC), and the earlier Outlook resend (2026-09-01 08:38 UTC): **zero delivered in 3 days**, inbox or spam, while the same Gmail inbox received other mail normally. The same inbox holds no founders.click email in 60 days, including the founder's own welcome email. Supabase accepted every send (200, `confirmation_sent_at` set); the hook returns 200 even when EmailIt rejects (by design), so the UI reports success. | "Check your email to confirm your account." Nothing arrives. Sign in → "Email not confirmed." Password reset and ticket receipts are on the same path. | `phase2-account/records.json` (4 records incl. the 3-day follow-up) |
| P2 | Landing page transfers the **entire 25.8 MB demo video on load** despite `preload="metadata"` and a poster (video never played). | Slow first load, data cost on mobile. | `phase11-public/desktop/005-…jpg`, record "25 MB demo video" |
| P2 | A server function called with a **garbage Bearer token returns HTTP 200** and an internal error string ("Invalid UTF-8 sequence") instead of 401. No data leaks, but the boundary is inconsistent and the message is internal. | Nothing visible; API consumers get a misleading 200. | `phase10-public-security/records.json` |
| P3 | Mobile (390×844): primary buttons are 36 px tall (Start free trial, Sign in, Continue with Google) — under the 40–44 px touch-target guideline. | Mis-taps on phones. | `phase11-public/mobile/` |
| P3 | Mobile header has **no menu**: Help and Sign in are hidden below the `sm` breakpoint with no alternative. | A phone visitor cannot reach Sign in from the header (must scroll to the footer). | `phase11-public/mobile/` |
| P1 | Support ticket "We'll email you shortly" — no email. (Same root cause as P0; listed because it is a separate customer promise.) | Ticket ID shown, silence afterwards. | `phase2-account/002-contact-support-public-form.jpg` |

### What was blocked

| Blocked | Why | Exact unblock |
|---|---|---|
| **Every authenticated phase** — dashboard (28 pages), AI generation, page editor, publishing pipeline, affiliates, billing observation, two-account permissions, profile/settings persistence, expired-session behaviour inside the app | No test account can be activated (P0 above). The protocol allows a clearly-labelled pre-confirmed test account to continue, but the audit environment has no database access (Supabase/Lovable connectors do not reach this project). Both test accounts were still `email_not_confirmed` on 2026-09-05. | Run in the Supabase SQL editor: `update auth.users set email_confirmed_at = now() where email in ('derekbowencorp+fclive-a@gmail.com','derekbowencorp+fclive-b@gmail.com') and email_confirmed_at is null;` — the prepared authenticated workflow (5 dashboard sections, AI with a 5-run cap, editor→publish→public→sitemap→unpublish, affiliates with a second profile, billing observation, isolation, critic) then runs. Signup itself stays **Failed**. |
| Billing lifecycle (checkout, trial expiry, upgrade/downgrade, cancel, payment failure, refunds, webhooks, reconciliation) | Production has a single live Stripe key; no test mode is configured. Creating a live charge is out of bounds. | Stripe test keys on a staging project, or a test-mode toggle. |
| Outlook delivery proof | No access to the Outlook inbox from the test environment. Two messages were sent to derekcbowen@outlook.com; account still unconfirmed 4 days later. | Founder checks Outlook inbox/junk and the EmailIt send log. |
| Second browser engine | Only Chromium is installed in the test environment (Firefox/WebKit executables absent; installing is disallowed). | Run `tests/e2e/live/*` where Firefox/WebKit exist. |
| Monitoring and scheduled jobs "proven" | All three pg_cron jobs are gated on `CRON_SECRET`, which is unset — they fail closed and silently. Proving them requires a production configuration change, out of baseline scope. | Set `CRON_SECRET` (Worker secret + Vault) after the baseline; then observe sync/briefing/audit runs. |
| Rollback and database recovery "proven" | Both are production actions (a Worker rollback; a PITR restore drill). Rollback is documented but has never been exercised; backups/PITR are undocumented. | Schedule a rollback drill and a restore drill outside the baseline. |
| Backlink research (Phase 8) | **The product has no backlink research tool** and does not advertise one. | Nothing to unblock; recorded as Not implemented. |
| Referral program (Phase 7) | There is no platform referral program. "Affiliate Programs" lets a customer run a program for *their* marketplace, behind a $30/mo add-on (trial available). Testing it needs an activated account. | Same SQL unblock; then the affiliates phase runs with a second browser profile applying at `/apply/<slug>`. |

### What is not implemented (but advertised or navigable)

From the Phase 1 inventory (`phase1-inventory/feature-matrix.md`, section
"Advertised but absent", 24 items). The ones a customer will hit first:

1. **Lead Inbox** — on the landing page's "Everything included" grid, in the
   README and the meta description; the route is a hidden "Coming soon" stub.
2. **Competitor radar** — advertised under "SEO Intelligence"; hidden stub.
3. **"Every plan unlocks every feature"** — Affiliate Programs ($30/mo) and
   DM Champ ($99/mo) are paid add-ons; the Opportunities engine is off.
4. **Generate Content** — a headline nav item whose page says "Generation
   backend pending — will be ported in Wave C"; the edge function does not exist.
5. **"Synced automatically every 30 minutes"** and **"a daily briefing"** —
   both are cron jobs that are currently off (`CRON_SECRET` unset).
6. **Plan changes** — FAQ promises prorated upgrades and end-of-period
   downgrades; there is no in-app upgrade path (checkout refuses a second
   subscription; the portal behaviour is not in the repo).
7. **Cancel from account settings / delete my data** — Terms and Privacy
   promise both; neither exists in the product (support email only).
8. **Help-centre articles describe features that do not exist**: a Field
   mapping page, a matrix builder, per-section "Generate with AI", a template
   editor with "regenerate hundreds of pages", a sync-history view, multiple
   marketplaces per workspace, a "Test connection" button (it is "Validate &
   Connect"), Google indexing ping, and plan limits (Starter 50 / Enterprise)
   that do not match the catalog (Starter 100, no Enterprise).
9. **Click report** — reads a table nothing writes; always empty.
10. **Cookie consent** — promised in the privacy policy; no banner or control.

Eighteen further stub pages ("Coming soon — this tool is scaffolded") are
hidden from navigation but reachable by URL (`?showStubs=1` or direct link):
content migration, blog, learning, competitor radar, listing auditor, SEO
health, link audit, sitemap & indexing, scrape import, click report, lead
inbox, email branding, email verify, site footer, admin team, and four
internal-only ones. These are **Intentionally disabled** and acceptable
only while they stay out of marketing copy — which Lead Inbox and
Competitor radar currently do not.

### What requires your decision

1. **Email provider**: fix EmailIt (sender domain verification, API key,
   account status — the send log for 2026-09-02 06:48/06:51/07:21 UTC will
   say which) or replace it. Nothing else can be accepted until this works.
2. **Pre-confirm the two test accounts** (SQL above) so the authenticated
   phases can run — or supply another route to a confirmed test account.
3. **Stripe test mode / staging** for the billing phase.
4. **Set `CRON_SECRET`** (turns on sync, briefings, canonical audit) — after
   the baseline, as a deliberate production change.
5. **Marketing and help copy**: remove or ship Lead Inbox, Competitor radar,
   "every feature unlocked", Generate Content, the auto-sync/briefing claims,
   and the nine help articles that describe absent features.
6. **Cancellation and deletion**: build native cancel + account/workspace
   deletion, or change the legal pages to describe the real (email) process.
7. Whether to keep the 25 MB demo video on the landing page.

---

## 2. Verdicts

| Audience | Verdict | Why |
|---|---|---|
| Closed, unpaid design partners | **NO-GO** | No customer can activate an account (P0). Every core journey — dashboard, page creation, AI generation, publishing, public rendering — remains unverified through the UI. Marketing advertises three features that do not exist. |
| Paying customers | **NO-GO** | Everything above, plus: billing lifecycle unverifiable (no test mode), no in-app plan change, no cancellation or deletion path despite Terms/Privacy promising both, scheduled jobs off. |
| Public launch | **NO-GO** | Everything above, plus mobile header without navigation, 25 MB video on first load, help centre describing a different product. |

Release criteria (from the brief) against today's state:

| Criterion | State |
|---|---|
| Every enabled and advertised feature accounted for | ✅ 121-feature inventory; 24 advertised-but-absent items listed |
| Every critical feature Verified through the browser | ❌ none of the authenticated journeys reached |
| No P0/P1 defect remains | ❌ P0 email delivery; P1 ticket receipts |
| No critical feature Blocked or Unknown | ❌ all authenticated features Blocked |
| Real confirmation and reset emails arrive | ❌ zero deliveries in 3 days, two providers |
| AI generation → editing → publishing proven | ❌ Blocked |
| Editor and publishing lifecycle proven | ❌ Blocked |
| Referral attribution proven with two accounts | ❌ Blocked (and no platform referral program exists) |
| Backlink research returns real provider data | — Not implemented (not advertised) |
| Monitoring and scheduled jobs proven | ❌ jobs off; monitor covers identity/homepage/auth-hook only |
| Rollback and database recovery proven | ❌ never exercised; backups undocumented |
| Intentionally disabled features hidden and out of marketing | ❌ Lead Inbox and Competitor radar are on the landing page |

---

## 3. Feature matrix

The complete matrix (121 features: where it lives, the customer promise,
the gate, the phase that must test it, discovery status) is
`docs/evidence/live-acceptance-2026-09-02/phase1-inventory/feature-matrix.md`.
Per-record test results are in `TABLES.md`. Summary by area:

| Area | Features | Verified | Failed | Blocked | Not impl. | Disabled |
|---|---|---|---|---|---|---|
| Marketing site, legal, help centre | 12 | 12 (public phase) | 1 (video) | — | — | — |
| Account lifecycle (signup, confirm, login, logout, reset, session, profile, deletion) | 11 | 2 (form; unauth redirects) | 2 (delivery; ticket email) | 6 (need confirmed account) | 1 (deletion) | — |
| Dashboard shell + Overview (dashboard, coach, SEO coach, briefing) | 9 | — | — | 9 | — | — |
| Content (pages list/editor/publish/unpublish/preview, bulk import, quick builder, generate, bulk editor, export, import) | 14 | — | — | 12 | 1 (Generate Content backend) | 3 stubs |
| Public tenant pages, sitemap, canonical, schema, domains, edge proxy | 9 | 4 (404s, /p redirect, headers, sitemaps) | — | 5 | — | — |
| SEO tools (rank tracker, page auditor, keyword opportunities, competitor tracker, internal links, link checker, missing pages, GSC import, content health, canonical audit) | 12 | — | — | 10 | 1 (click report) | 8 stubs |
| Affiliates (6 pages + public apply form) | 8 | 1 (unknown-program 404) | — | 7 | — | — |
| Billing & entitlements (trial, plans, upgrade, cancel, credits, add-ons, webhooks) | 12 | — | — | 12 (no test mode / no account) | 1 (in-app plan change) | — |
| Settings & integrations (workspace, domains, AI providers, API keys, Sharetribe) | 8 | — | — | 8 | — | — |
| Ops / team / support tooling | 12 | 1 (ticket created) | 1 (ticket email) | 1 | 1 (team) | 7 stubs |
| Platform: security boundaries, headers, rate limits, secrets | 14 | 13 | 1 (garbage bearer → 200) | — | — | — |

---

## 4. Browser-journey matrix

| Journey | Chromium desktop 1366×900 | Mobile 390×844 | Slow network | Fresh/incognito profile | Firefox / WebKit |
|---|---|---|---|---|---|
| Landing page | Verified | Verified (no overflow) · Failed P3 (no header menu) | Verified (headline 4.0 s, interactive 13.7 s) | Verified (no state carried) | Blocked (not installed) |
| Pricing + FAQ | Verified (keyboard) | Verified | — | — | Blocked |
| Help centre + search + contact | Verified | Verified | — | — | Blocked |
| Terms / Privacy | Verified | — | — | — | Blocked |
| Signup form validation | Verified | Failed P3 (36 px targets) | — | — | Blocked |
| Signup → confirmation email → activation | **Failed P0** | — | — | — | Blocked |
| Login (wrong password, keyboard) | Verified | Failed P3 (36 px targets) | — | — | Blocked |
| Login (success) → dashboard | Blocked | Blocked | Blocked | Blocked | Blocked |
| Password reset request → email → new password | Blocked (delivery) | — | — | — | Blocked |
| Unauthenticated deep links → /login | Verified (3.3 s delay) | Verified | — | Verified | Blocked |
| Support ticket | Verified (created) · Failed P1 (no email) | — | — | — | Blocked |
| 404 / unknown tenant slugs / /p redirect | Verified | — | — | — | Blocked |
| Dashboard pages (28) | Blocked | Blocked | — | — | Blocked |
| Create → edit → preview → publish → public → sitemap → unpublish | Blocked | — | — | — | Blocked |
| AI generation | Blocked | — | — | — | Blocked |
| Affiliates + public application | Blocked (`/apply` unknown → 404 Verified) | — | — | — | Blocked |
| Billing (observe up to Stripe) | Blocked | — | — | — | Blocked |
| Two-account isolation | Blocked | — | — | — | Blocked |

---

## 5. Defect log

| ID | Sev | Defect | Repro | Evidence |
|---|---|---|---|---|
| D1 | **P0** | No transactional email is delivered (signup confirmation, password reset, ticket receipt). | Sign up at /signup with any Gmail/Outlook address → "Check your email" → nothing, ever. Sign in → "Email not confirmed". | `phase2-account/records.json` #1, #2, #4, #5 |
| D2 | P1 | Support ticket promises an email that never arrives. | /help/contact → submit → "We'll email you shortly" → nothing. | `phase2-account/002-…jpg`, record #3 |
| D3 | P2 | Landing page downloads the full 25.8 MB demo video on load. | Open / with DevTools Network; observe product-demo.mp4 transfer with no play. | `phase11-public/desktop/` record "25 MB demo video" |
| D4 | P2 | Server function with a garbage Bearer token returns 200 + internal error text. | `POST /_serverFn/<listTenantPages id>` with `Authorization: Bearer garbage`. | `phase10-public-security/records.json` (Failed row) |
| D5 | P3 | Mobile touch targets 36 px on signup/login primary buttons. | Open /signup at 390×844; measure button height. | `phase11-public/mobile/` |
| D6 | P3 | Mobile header lacks a menu; Help and Sign in unreachable from the header. | Open / at 390×844. | `phase11-public/mobile/` |
| D7 | P3 | Unauthenticated deep links wait 3.3 s on a blank shell before redirecting to /login. | Open /app/billing in a fresh profile; time the redirect. | `phase11-public/desktop/` unauth records |
| D8 | P2 | Marketing advertises Lead Inbox and Competitor radar; both are "Coming soon" stubs. | Landing "Everything included" → /app/ops/lead-inbox?showStubs=1. | `phase1-inventory/feature-matrix.md` §Advertised but absent 1–2 |
| D9 | P2 | Help centre describes nine features that do not exist and wrong plan limits. | /help/… articles listed in §Advertised but absent 10–22. | same, items 10–22 |
| D10 | P1 (legal) | Terms promise in-app cancellation; Privacy promises deletion; neither exists. | /terms §cancellation, /privacy §rights; no control anywhere in /app/settings. | same, item 23 |

Defects from the earlier code audit (`docs/AUDIT_2026-09-02.md`: billing
reconciliation, trial expiry, refunds, dunning, schema not in migrations,
no error reporting, cron off, no account deletion) stand as supporting
findings; the ones a customer would meet through the UI are above.

---

## 6. Advertised but absent / nonfunctional

Full list of 24 with the exact promise text and where it appears:
`docs/evidence/live-acceptance-2026-09-02/phase1-inventory/feature-matrix.md`
§"Advertised but absent". Summary in §1 above.

## 7. Production journeys that remain unverified

Login success · dashboard load and every dashboard page (28) · workspace
auto-provisioning and trial state · page create/edit/save/cancel/preview ·
publish gate and slot accounting · public rendering of a published page on
`/a/<slug>` (canonical, schema, noindex rules, headers on a customer
hostname) · tenant sitemap add/remove · update/republish cache propagation ·
unpublish → 404 · AI generation (provider, duration, cost, quality,
regeneration) · bulk CSV import · data export contents · GSC import → keyword
opportunities · rank tracker / competitor tracker with BYOK keys · link
checker · missing pages · internal links · SEO coach and coach chat ·
affiliate add-on trial, program creation, public application, approval,
referral codes, payouts · billing page, upgrade redirect, credits card ·
workspace settings persistence, branding, domains flow, AI providers, API
keys, Sharetribe connect/sync · logout invalidation of a captured token ·
two-account isolation of pages, affiliates, settings · password reset
completion and old-password refusal · profile editing · Outlook delivery.

## 8. Method and limitations

- Browser: Playwright Chromium (`/opt/pw-browsers/chromium`) through the
  sandbox proxy; a fresh browser context per Session (separate profile).
- Inbox: Gmail via the connected account (plus-aliases as test addresses);
  `in:anywhere` searches cover spam and all folders.
- Test accounts: `derekbowencorp+fclive-a@gmail.com` (A),
  `derekbowencorp+fclive-b@gmail.com` (B); credentials held outside the repo.
- One harness bug during the run overwrote two early records; they were
  reconstructed from the captured network data and flagged as such in
  `phase2-account/records.json` (the account-A signup screenshot was lost;
  the identical screen for account B is attached). Fixed before any other
  phase ran.
- The multi-agent public phase completed its inventory, public-journey and
  security-boundary work (evidence on disk) but its critic pass was cut off
  by an environment restart; a standalone critic pass was run afterwards and
  its additions, if any, are under `critic-public/`.
- Not attempted: anything requiring production changes, Stripe, a second
  browser engine, or database access.

---

## 9. Proposed fix plan (after the baseline — separate branch, each retested through the same browser journey before its status changes)

1. **Email delivery (D1, D2).** Read the EmailIt send log for the three timestamps; fix sender-domain verification (add SPF for founders.click; DKIM exists), API key or account state; then re-run `phase2_account.py signup/confirm/login/reset-*` and confirm real inbox receipt on Gmail and Outlook with provider message IDs. Consider making the hook log a metric on EmailIt failure so silence is visible.
2. **Unblock authenticated testing**: with a confirmed test account, run the prepared authenticated workflow; expect a second defect log.
3. **Copy honesty (D8, D9, D10)**: remove Lead Inbox and Competitor radar from the landing grid and README; hide or finish Generate Content; rewrite the nine help articles; align Terms/Privacy with the real cancel/delete process or build them.
4. **Garbage-bearer 401 (D4)**: make the auth middleware reject undecodable tokens with 401 before any handler runs; add a test.
5. **Landing performance (D3)**: `preload="none"` plus poster, or lazy-load the video on interaction; verify transfer in DevTools.
6. **Mobile (D5, D6)**: 44 px primary buttons on auth pages; a header menu (or always-visible Sign in) on small screens.
7. **Unauth redirect delay (D7)**: shorten the session-wait timeout or render a "checking your session" state.
8. Then the code-audit P1s (billing lifecycle, cron secret, error reporting, schema capture, account deletion) — each with a browser-level acceptance check where a customer can see the outcome.

# Live acceptance test — agent brief

You are testing founders.click **as a real customer**, through the deployed
product at https://www.founders.click, in a real Chromium browser. Code,
unit tests, database rows and "the implementation exists" are supporting
evidence only. A feature is **Verified** only when the entire customer
outcome happened through the deployed UI and you have the screenshot,
network and console evidence to show it.

## Hard rules

- **Baseline only.** Do NOT push, deploy, edit production configuration,
  run migrations, touch the database, or "fix while testing". Local edits
  to `tests/e2e/live/*` scripts are fine. Nothing else in the repo changes.
- **No real money.** Never enter a card. If a flow redirects to Stripe,
  screenshot the Stripe page URL/title and stop. Stripe test mode is not
  configured in production — billing checks that need it are **Blocked**.
- **Test accounts only.** Use the accounts in the creds file (see below).
  Never touch data belonging to any other workspace. Never email anyone.
- **Spend cap.** AI generation is metered. Only the phase explicitly
  assigned AI generation may trigger it, and at most the number of runs
  it is told. Other phases must not click Generate/Coach send/Run audit.
- **Don't spam sends.** Support tickets, affiliate applications, feedback
  forms: at most one submission each, with obviously-test content.
- Never print passwords or tokens. Redact tokens from any URL you save.

## Harness

`tests/e2e/live/harness.py` — read it first. Key API:

```python
import sys; sys.path.insert(0, "tests/e2e/live")
from harness import Session, load_accounts
async with Session("phase3-content", account="A") as s:   # separate browser profile
    await s.login()                          # from creds file
    await s.goto("/app/pages")               # BASE + path, waits ~2.5 s
    txt = await s.text()                     # visible text of body
    await s.record(feature=..., promise=..., actions=[...], expected=...,
                   actual=..., status="Verified|Failed|Blocked|Not implemented|Intentionally disabled",
                   severity="P0|P1|P2|P3|-", impact=..., persistence=..., repro=[...])
```
`record()` automatically attaches a screenshot, the network calls since the
last record (server functions, Supabase, 4xx/5xx with body snippets) and
console errors, then appends to `docs/evidence/live-acceptance-2026-09-02/<phase>/records.json`.

Run scripts with:
`SMOKE_CHROMIUM_PATH=/opt/pw-browsers/chromium python3 tests/e2e/live/<script>.py`

Extra pages in the same profile: `p = await s.new_page()`; mobile:
`Session(..., mobile=True)`; slow network: `Session(..., slow_network=True)`.

## Accounts

`load_accounts()` returns `{"A": {"email","password"}, "B": {...}}`.
Account **A** is the primary customer workspace; **B** is an unrelated
second customer. Both were created and confirmed through the public UI and
real email. Use B only where the phase says so.

## Per-page checklist (Phase 3 pages)

initial load · loading state · empty state · a valid action · invalid input ·
save · cancel · refresh persistence · browser back/forward · direct URL ·
mobile layout (390×844) · keyboard reachability (Tab to the primary action) ·
console + network errors. Click every customer-visible control (buttons,
tabs, dropdowns, dialogs, links); note controls that do nothing.

## Evidence standard (every record)

Exact URL · test account · exact browser actions · expected result · actual
customer-visible result · screenshot (the harness attaches one; take extra
ones with `await s.shot("name")` and mention them in `actual`) · console
errors · failed or relevant network requests · **persistence after refresh
AND after a new login in a fresh Session** for any save/create/edit — put
both results in the `persistence` field · status · severity.

## Status rules

- **Verified** — full customer outcome achieved in the UI, with evidence.
- **Failed** — the customer outcome did not happen (error, wrong result,
  nothing persisted, dead control). Give exact repro steps and severity.
- **Blocked** — could not be tested for a reason outside the feature
  (missing credential, needs Stripe test mode, needs a domain, rate limit).
  Say exactly what is needed.
- **Not implemented** — advertised or navigable, but there is nothing behind it.
- **Intentionally disabled** — hidden/gated on purpose; say how you know.

Severity: P0 blocks all customers · P1 blocks a core journey or loses
data/money · P2 degrades a journey · P3 polish.

## Return value

Return JSON via the StructuredOutput tool: every `record()` you made
(feature, status, severity, one-line actual), plus `advertised_but_absent`,
`unverified_journeys`, `notes`. Be candid: a Blocked or Failed row is more
useful than an optimistic Verified.

"""
Phase 10 (unauthenticated part) — PUBLIC SECURITY BOUNDARIES.

Probes founders.click as a customer/attacker with NO account and NO session.
Uses the harness (real Chromium) for the customer-facing checks (dashboard
redirects, the /help/search UI, sensitive-value dumps) and curl via subprocess
(which honours the sandbox proxy) for the raw HTTP boundary checks (server
functions with no/garbage auth, the /api/public/* endpoints, rate limits,
response headers).

Evidence: docs/evidence/live-acceptance-2026-09-02/phase10-public-security/

Sections:
  (1) every /app/* dashboard URL without a session redirects to /login, no data
  (2) server functions require auth: no header -> 401, garbage Bearer -> 401
  (3) /api/public/* endpoints: status + body, no stack traces / keys / tenant leak
  (4) rate-limit friendliness: help search x30, sitemap-by-host x130
  (5) sensitive values in inline scripts + window keys on public pages
  (6) response headers on /app/* redirects and /api/public/*

Run: SMOKE_CHROMIUM_PATH=/opt/pw-browsers/chromium python3 tests/e2e/live/phase10_public_security.py
"""
from __future__ import annotations

import asyncio
import json
import re
import shutil
import subprocess
import sys
import time
import traceback
from pathlib import Path
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, str(Path(__file__).parent))
from harness import BASE, EVIDENCE, REPO, Session, now_iso, redact  # noqa: E402

PHASE = "phase10-public-security"
PHASE_DIR = EVIDENCE / PHASE
CA = "/root/.ccr/ca-bundle.crt"

# Known public anon key (VITE_SUPABASE_PUBLISHABLE_KEY) — expected in the bundle,
# NOT a finding. Everything else matching the JWT / secret patterns is.
ANON_KEY = (
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inhi"
    "eGh6aW5uZmhvc296dHFhYWFvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgzODU1ODMsImV4cCI6"
    "MjA5Mzk2MTU4M30.SyvCaO_bMDrGnlFgkAorYu6ArL2mVJlSOFbr1XRQABU"
)

# Workspace-scoped server functions (GET, guarded by requireSupabaseAuth).
# IDs are sha256(filename--functionName); verified identical in the local build
# (.output) and the production /assets/*.functions-*.js chunks.
FN = {
    "listTenantPages (/app/pages)": "4dc67d39250e652ef4b39db4da85261b8ca02b91b7585a31442cb1d0611e04c9",
    "getPageEntitlement (/app/billing)": "cb2022abb91103664894958b217bb84acb3774caf60d46e115c2b9e31a69006b",
}

# Secret / token patterns to hunt for in browser output.
SECRET_PATTERNS = {
    "service_role": re.compile(r"service_role"),
    "sk_live": re.compile(r"sk_live[_A-Za-z0-9]+"),
    "whsec": re.compile(r"whsec_[A-Za-z0-9]+"),
    "LOVABLE_API_KEY": re.compile(r"LOVABLE_API_KEY"),
    "EMAILIT": re.compile(r"EMAILIT", re.I),
}
JWT_RE = re.compile(r"eyJ[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{10,}")
# also catch any long eyJ... base64 blob (>100 chars) even if not dotted
LONG_EYJ_RE = re.compile(r"eyJ[A-Za-z0-9_\-+/=]{100,}")

STACK_TRACE_RE = re.compile(r"(at\s+\w+.*\(.*:\d+:\d+\)|\.mjs:\d+|\.ts:\d+:\d+|node:internal|/src/|Traceback|ReferenceError|TypeError:)")
KEY_LEAK_RE = re.compile(r"(service_role|sk_live|whsec_|SUPABASE_SERVICE|SECRET|PRIVATE KEY|CRON_SECRET)", re.I)


def curl(method: str, url: str, headers: dict | None = None, data: str | None = None,
         timeout: int = 40) -> dict:
    """Raw HTTP probe via subprocess curl (honours the sandbox proxy). Returns
    {status, headers, body, error}."""
    hdr_file = PHASE_DIR / ".curl_hdr.tmp"
    cmd = ["curl", "-sS", "-X", method, "--max-time", str(timeout), "-D", str(hdr_file),
           "-o", "-", "-w", "\n__HTTP_STATUS__:%{http_code}"]
    if Path(CA).exists():
        cmd += ["--cacert", CA]
    for k, v in (headers or {}).items():
        cmd += ["-H", f"{k}: {v}"]
    if data is not None:
        cmd += ["--data-binary", data]
    cmd.append(url)
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout + 10)
    except subprocess.TimeoutExpired:
        return {"status": None, "headers": {}, "body": "", "error": "curl timeout"}
    raw = out.stdout
    status = None
    m = re.search(r"__HTTP_STATUS__:(\d+)\s*$", raw)
    if m:
        status = int(m.group(1))
        raw = raw[: m.start()]
    resp_headers: dict[str, str] = {}
    if hdr_file.exists():
        for line in hdr_file.read_text(errors="replace").splitlines():
            if ":" in line and not line.startswith("HTTP/"):
                k, _, v = line.partition(":")
                resp_headers[k.strip().lower()] = v.strip()
        hdr_file.unlink(missing_ok=True)
    return {"status": status, "headers": resp_headers, "body": raw,
            "error": out.stderr.strip()[:300] if out.returncode != 0 else ""}


def leak_scan(body: str) -> dict:
    """Look for stack traces / secret leaks in a response body."""
    b = body.replace(ANON_KEY, "<ANON_KEY>")
    stack = bool(STACK_TRACE_RE.search(b))
    keys = KEY_LEAK_RE.findall(b)
    jwts = [j for j in LONG_EYJ_RE.findall(b)]
    return {"stack_trace": stack, "key_hits": sorted(set(keys)), "unexpected_jwt": jwts[:2]}


async def step(s: Session, feature: str, fn):
    try:
        await fn()
    except Exception as e:  # noqa: BLE001
        tb = traceback.format_exc()[-1400:]
        print(tb)
        await s.record(feature=feature, promise="(see script)",
                       actions=["(script raised before the check completed)"], expected="-",
                       actual=f"SCRIPT EXCEPTION (not a product verdict): {type(e).__name__}: {str(e)[:300]}",
                       status="Blocked", severity="-", impact="fix the script and rerun",
                       extra={"traceback": tb})


# ============================================================ (1) redirects + (6) headers
APP_URLS = [
    "/app", "/app/pages", "/app/billing", "/app/settings/domains", "/app/affiliates/payouts",
    "/app/coach", "/app/seo/rank-tracker", "/app/settings", "/app/settings/api-keys",
    "/app/affiliates", "/app/content/generate", "/app/addons", "/app/seo/page-auditor",
    "/app/affiliates/programs",
]


async def dashboard_redirects(s: Session) -> None:
    p = s.page
    header_rows: list[dict] = []

    for path in APP_URLS:
        async def one(path=path):
            # --- browser: does an anonymous visit end up on /login with no data?
            await p.goto(BASE + path, wait_until="commit", timeout=45000)
            await p.wait_for_timeout(600)
            mid_txt = (await s.text())[:200]
            redirected = True
            try:
                await p.wait_for_url(re.compile(r"/login"), timeout=15000)
            except Exception:  # noqa: BLE001
                redirected = False
            final = p.url
            nxt = (parse_qs(urlparse(final).query).get("next") or [None])[0]
            body_txt = (await s.text()).lower()
            # crude data-leak check: no tenant/workspace payload words on the pre-redirect shell
            leaked_words = [w for w in ("workspace_id", "payout", "invoice", "api key", "domain verified") if w in mid_txt.lower()]

            # --- curl: capture the raw shell's response headers (item 6)
            c = curl("GET", BASE + path)
            hh = c["headers"]
            row = {
                "path": path, "shell_status": c["status"],
                "cache-control": hh.get("cache-control"),
                "x-frame-options": hh.get("x-frame-options"),
                "x-content-type-options": hh.get("x-content-type-options"),
                "referrer-policy": hh.get("referrer-policy"),
                "strict-transport-security": hh.get("strict-transport-security"),
                "set-cookie": bool(hh.get("set-cookie")),
                "content-type": hh.get("content-type"),
            }
            header_rows.append(row)
            ok = redirected and nxt == path and not leaked_words
            await s.record(
                feature=f"Unauthenticated /app URL redirects to login — {path}",
                promise="Every dashboard URL bounces an anonymous visitor to /login?next=… and renders no tenant data",
                actions=[f"open {path} with no session", "wait for the client redirect", "GET the raw shell with curl for its headers"],
                expected=f"browser lands on /login?next={path}; pre-redirect shell shows no data; raw shell 200 (ssr:false) with security headers",
                actual=f"redirected={redirected} -> {final.replace(BASE, '')} next={nxt!r}; while waiting shell text[:80]={mid_txt[:80]!r}; leaked_words={leaked_words}; "
                       f"raw shell HTTP {c['status']} cache-control={row['cache-control']!r} XFO={row['x-frame-options']} nosniff={row['x-content-type-options']} set-cookie={row['set-cookie']}",
                status="Verified" if ok else "Failed", severity="-" if ok else "P0",
                impact="" if ok else "Anonymous visitor can reach dashboard URL or sees tenant data",
                extra={"header_row": row},
            )
        await step(s, f"redirect {path}", one)

    # aggregate header record (item 6)
    async def headers_summary():
        cache_values = sorted({(r["cache-control"] or "(none)") for r in header_rows})
        nosniff_all = all(r["x-content-type-options"] == "nosniff" for r in header_rows)
        xfo_all = all(r["x-frame-options"] == "DENY" for r in header_rows)
        hsts_all = all(r["strict-transport-security"] for r in header_rows)
        any_cookie = [r["path"] for r in header_rows if r["set-cookie"]]
        # A 200 HTML shell with no data that the client redirects; note whether it's cacheable.
        cacheable = [r["path"] for r in header_rows if r["cache-control"] and re.search(r"max-age=[1-9]|public", r["cache-control"] or "")]
        ok = nosniff_all and xfo_all and hsts_all and not any_cookie
        await s.record(
            feature="Response headers on /app/* shells (authenticated-shaped responses)",
            promise="The 200 SSR shell served for /app/* (before the client redirect) carries platform security headers, sets no session cookie, and is not cached with data",
            actions=["curl each of the 14 /app/* URLs with no cookies", "read cache-control + security headers + set-cookie"],
            expected="every shell: X-Content-Type-Options nosniff, X-Frame-Options DENY, HSTS present, no Set-Cookie; cache-control not caching tenant data",
            actual=f"nosniff on all={nosniff_all}; XFO DENY on all={xfo_all}; HSTS on all={hsts_all}; Set-Cookie paths={any_cookie}; distinct cache-control values={cache_values}; cacheable-with-maxage paths={cacheable}",
            status="Verified" if ok else "Failed", severity="-" if ok else "P2",
            impact="" if ok else "Authenticated-shaped response missing headers or setting cookies",
            extra={"rows": header_rows,
                   "note": "The /app/* shell is a 200 HTML document with ssr:false (no server data); the redirect to /login is client-side. The shell therefore carries no tenant data to cache."},
        )
    await step(s, "headers summary", headers_summary)


# ============================================================ (2) server functions require auth
async def server_functions(s: Session) -> None:
    p = s.page
    await p.goto(BASE + "/login", wait_until="commit")  # backdrop for screenshots

    # no Authorization header on two workspace-scoped GET server functions
    for label, fid in FN.items():
        async def one(label=label, fid=fid):
            c = curl("GET", f"{BASE}/_serverFn/{fid}", headers={"x-tsr-serverFn": "true", "accept": "application/json"})
            scan = leak_scan(c["body"])
            body_short = c["body"][:300]
            ok = c["status"] == 401 and not scan["stack_trace"] and not scan["key_hits"] and not scan["unexpected_jwt"]
            await s.record(
                feature=f"Server function requires auth (no header) — {label}",
                promise="A workspace-scoped server function called with no Authorization header returns 401 and no data",
                actions=[f"curl GET /_serverFn/{fid[:12]}… with no Authorization header"],
                expected="HTTP 401; body is a bare 'Unauthorized' message; no rows, no stack trace, no secrets",
                actual=f"HTTP {c['status']}; body={body_short!r}; leak_scan={scan}",
                status="Verified" if ok else "Failed", severity="-" if ok else "P0",
                impact="" if ok else "Unauthenticated caller reaches a workspace-scoped function or leaks data",
                extra={"function_id": fid, "response_headers": c["headers"]},
            )
        await step(s, f"noauth {label}", one)

    # garbage Bearer token on one of them
    async def garbage():
        fid = FN["listTenantPages (/app/pages)"]
        c = curl("GET", f"{BASE}/_serverFn/{fid}",
                 headers={"x-tsr-serverFn": "true", "accept": "application/json",
                          "authorization": "Bearer not-a-real-token.deadbeef.xyz"})
        scan = leak_scan(c["body"])
        body = c["body"]
        # Did any workspace/tenant data come back? (auth bypass / data leak)
        data_leak = bool(re.search(r"workspace|tenant_page|\"slug\"|payout|invoice", body, re.I)) or bool(scan["key_hits"]) or bool(scan["unexpected_jwt"])
        # A TanStack-serialized error result (x-tss-serialized) with an "error" marker
        # means the call was rejected and NO data was returned, even though the
        # transport status is 200.
        serialized_error = c["headers"].get("x-tss-serialized") == "true" and '"error"' in body
        rejected = (c["status"] == 401) or serialized_error
        clean_401 = c["status"] == 401
        # Rejected + no data leak is the security-critical requirement (met).
        # A clean 401 is the contract the middleware intends (NOT met for malformed tokens).
        internal_msg = re.search(r'"s":"([^"]{0,60})"', body)
        msg = internal_msg.group(1) if internal_msg else None
        ok = clean_401 and not data_leak
        await s.record(
            feature="Server function rejects a garbage Bearer token — listTenantPages",
            promise="A forged Bearer token is rejected with 401 'Unauthorized: Invalid token'; no data; no internal error surface",
            actions=["curl GET /_serverFn/listTenantPages with 'Authorization: Bearer not-a-real-token.deadbeef.xyz'"],
            expected="HTTP 401 'Unauthorized: Invalid token'; no data; no stack trace",
            actual=f"HTTP {c['status']}; rejected(no data)={rejected}; data_leak={data_leak}; x-tss-serialized={c['headers'].get('x-tss-serialized')}; "
                   f"internal error message leaked={msg!r}; body={body[:220]!r}; leak_scan={scan}",
            status="Verified" if ok else "Failed",
            severity="-" if ok else ("P1" if data_leak else "P2"),
            impact="" if ok else (
                "AUTH BYPASS / DATA LEAK — forged token returned tenant data" if data_leak else
                "No bypass and no data leak (request is rejected, zero rows returned), BUT a malformed JWT makes supabase.auth.getClaims() throw before the middleware's `throw new Response(401)`, so the caller gets HTTP 200 with an internal library message (\"Invalid UTF-8 sequence\" / \"Missing exp claim\") instead of the intended clean 401. The middleware's 401 branch is dead code for malformed tokens."),
            repro=[] if ok else [
                "curl -H 'Authorization: Bearer not-a-real-token.deadbeef.xyz' https://www.founders.click/_serverFn/4dc67d39250e652ef4b39db4da85261b8ca02b91b7585a31442cb1d0611e04c9",
                "observe HTTP 200 with x-tss-serialized:true and message 'Invalid UTF-8 sequence' (a structurally-valid JWT missing exp gives 'Missing exp claim') instead of HTTP 401",
                "NOTE: an empty/non-Bearer/no-Authorization request DOES return a clean 401 (verified separately); only malformed tokens that fail getClaims' local decode slip past the Response throw",
            ],
            extra={"function_id": fid, "response_headers": c["headers"], "rejected_no_data": rejected,
                   "root_cause": "src/integrations/supabase/auth-middleware.ts calls supabase.auth.getClaims(token) which decodes the JWT locally and throws a plain Error for a malformed token; that Error is not a Response, so the subsequent `throw new Response('Unauthorized: Invalid token', {status:401})` never runs and TanStack serializes the thrown Error as a 200 result."},
        )
    await step(s, "garbage bearer", garbage)


# ============================================================ (3) public API endpoints
async def public_api(s: Session) -> None:
    p = s.page
    UNKNOWN_HOST = "live-acceptance-unknown-2026.example.com"

    probes = [
        # (feature, method, url, headers, data, expect_status(s), expect_note)
        ("domain-config (no hostname)", "GET", "/api/public/domain-config", None, None, [400],
         "hostname_required"),
        ("domain-config (unknown hostname)", "GET", f"/api/public/domain-config?hostname={UNKNOWN_HOST}", None, None, [404],
         "domain_not_found, no config for a host we don't manage"),
        ("domain-token (unknown hostname)", "GET", f"/api/public/domain-token?hostname={UNKNOWN_HOST}", None, None, [404],
         "not found; verification tokens never handed out for unknown/verified hosts"),
        ("page-lookup (GET not allowed)", "GET", "/api/public/page-lookup", None, None, [405],
         "method_not_allowed (POST-only JSON API)"),
        ("page-lookup (POST unknown host)", "POST", "/api/public/page-lookup",
         {"content-type": "application/json"}, json.dumps({"hostname": UNKNOWN_HOST, "slug": "x"}), [200],
         "ok:false domain_not_found; no other tenant's page"),
        ("sitemap-by-host (no hostname)", "GET", "/api/public/sitemap-by-host", None, None, [400],
         "hostname required"),
        ("sitemap-by-host (unknown host)", "GET", f"/api/public/sitemap-by-host?hostname={UNKNOWN_HOST}", None, None, [404],
         "not found"),
        ("edge-health GET (build identity)", "GET", "/api/public/edge-health", None, None, [200],
         "public build info (commit SHA of a private repo is not a secret)"),
        ("edge-health POST (unsigned)", "POST", "/api/public/edge-health",
         {"content-type": "application/json"}, json.dumps({"hostname": UNKNOWN_HOST, "state": "BROKEN"}), [202],
         "always 202; unknown host recorded nothing (telemetry never load-bearing)"),
        ("hooks/auth-send-email (unsigned POST)", "POST", "/api/public/hooks/auth-send-email",
         {"content-type": "application/json"}, json.dumps({"user": {"email": "x@example.com"}}), [401],
         "invalid signature / hook not configured — a forged call must never send mail"),
        ("hooks/canonical-audit (no secret)", "POST", "/api/public/hooks/canonical-audit",
         {"content-type": "application/json"}, "{}", [401],
         "Unauthorized without CRON_SECRET bearer"),
        ("hooks/sync-sharetribe (no secret)", "POST", "/api/public/hooks/sync-sharetribe",
         {"content-type": "application/json"}, "{}", [401, 500],
         "unauthorized without CRON_SECRET (500 'server misconfigured' if the secret is unset)"),
    ]

    for feature, method, path, headers, data, expect, note in probes:
        async def one(feature=feature, method=method, path=path, headers=headers, data=data, expect=expect, note=note):
            c = curl(method, BASE + path, headers=headers, data=data)
            scan = leak_scan(c["body"])
            hh = c["headers"]
            body_short = c["body"][:400]
            clean = not scan["stack_trace"] and not scan["key_hits"] and not scan["unexpected_jwt"]
            ok = (c["status"] in expect) and clean
            await s.record(
                feature=f"Public API — {feature}",
                promise="Public endpoint answers safely: expected status, no stack trace, no secret, no other tenant's data",
                actions=[f"curl -X {method} {path}" + (f" (body {data[:60]})" if data else "")],
                expected=f"HTTP {expect}; {note}; no stack trace / keys / cross-tenant data",
                actual=f"HTTP {c['status']}; content-type={hh.get('content-type')!r}; cache-control={hh.get('cache-control')!r}; body={body_short!r}; leak_scan={scan}",
                status="Verified" if ok else ("Failed" if not clean else "Failed"),
                severity="-" if ok else ("P1" if not clean else "P2"),
                impact="" if ok else ("Endpoint leaks internals/secrets" if not clean else f"Unexpected status {c['status']} (wanted {expect})"),
                extra={"headers": hh, "expected_status": expect},
            )
        await step(s, feature, one)


# ============================================================ (4) rate-limit friendliness
async def rate_limits(s: Session) -> None:
    p = s.page

    # --- help search UI, 30 quick hits (limit is 120/min per isolate; 30 must stay friendly)
    async def help_search_30():
        statuses: list[int] = []
        first_limited = None
        bodies_sample = None
        for i in range(30):
            c = curl("GET", f"{BASE}/help/search?q=billing{i % 7}")
            statuses.append(c["status"])
            if c["status"] in (429, 503) and first_limited is None:
                first_limited = {"i": i, "status": c["status"], "body": c["body"][:300]}
            if i == 0:
                bodies_sample = c["body"][:200]
        # render the UI once for a screenshot + friendliness check
        await s.goto("/help/search?q=billing", settle_ms=1500)
        ui_txt = (await s.text())[:200]
        broken = "application error" in ui_txt.lower() or "something went wrong" in ui_txt.lower()
        codes = {}
        for st in statuses:
            codes[st] = codes.get(st, 0) + 1
        ok = all(st == 200 for st in statuses) and not broken
        await s.record(
            feature="Rate limit — help search hit 30× quickly stays friendly",
            promise="A customer searching help repeatedly sees results/empty states, never a broken page",
            actions=["GET /help/search?q=… 30 times in quick succession", "then render the UI"],
            expected="all 200; the search UI renders a normal results/empty state (no error screen); if limited, a friendly message not a crash",
            actual=f"status counts over 30 requests={codes}; first limited response={first_limited}; UI text[:120]={ui_txt[:120]!r}; broken_page={broken}",
            status="Verified" if ok else ("Blocked" if first_limited else "Failed"),
            severity="-" if ok else "P2",
            impact="" if ok else "Help search degrades badly under rapid use",
            extra={"statuses": statuses, "note": "help-search server fn limit is 120/min/isolate; 30 requests should never trip it"},
        )
    await step(s, "help search 30x", help_search_30)

    # --- sitemap-by-host, 130 hits (limit 120/min per isolate; may trip if one isolate)
    async def sitemap_130():
        host = "www.founders.click"
        statuses: list[int] = []
        first_limited = None
        for i in range(130):
            c = curl("GET", f"{BASE}/api/public/sitemap-by-host?hostname={host}", timeout=20)
            statuses.append(c["status"])
            if c["status"] == 429 and first_limited is None:
                first_limited = {"i": i, "status": 429, "body": c["body"][:200],
                                 "content-type": c["headers"].get("content-type")}
        codes = {}
        for st in statuses:
            codes[st] = codes.get(st, 0) + 1
        limited = first_limited is not None
        # Either outcome is acceptable as long as the response is a clean status, not a crash.
        any_5xx = any((st or 0) >= 500 for st in statuses)
        ok = not any_5xx
        await s.record(
            feature="Rate limit — sitemap-by-host hit 130× (limit 120/min/isolate)",
            promise="Hammering the public sitemap endpoint yields a clean 429 (or is spread across isolates), never a 5xx/crash",
            actions=[f"GET /api/public/sitemap-by-host?hostname={host} 130 times in quick succession"],
            expected="A clean 429 'rate limited' once ~120 is crossed on a single isolate, or steady 200/404 if Cloudflare spread the load across isolates; never a 5xx",
            actual=f"status counts over 130 requests={codes}; first 429={first_limited}; got_429={limited}; any_5xx={any_5xx}",
            status="Verified" if ok else "Failed", severity="-" if ok else "P2",
            impact="" if ok else "Public endpoint 5xx's under load",
            extra={"statuses": statuses,
                   "note": "Per-isolate in-memory limiter; Cloudflare may spread 130 requests across isolates so a 429 is not guaranteed. Recording the first limited response as asked."},
        )
    await step(s, "sitemap 130x", sitemap_130)


# ============================================================ (5) sensitive values in browser output
async def sensitive_values(s: Session) -> None:
    p = s.page
    pages = [("/", "landing"), ("/login", "login"), ("/signup", "signup"), ("/help", "help")]
    aggregate: dict[str, dict] = {}

    for path, name in pages:
        async def one(path=path, name=name):
            await s.goto(path, settle_ms=1800)
            dump = await p.evaluate("""() => {
                const inline = [...document.querySelectorAll('script:not([src])')].map(sc => sc.textContent || '');
                const winKeys = Object.keys(window);
                // also grab any obvious config globals if present
                const suspects = {};
                for (const k of winKeys) {
                    if (/env|config|supabase|key|secret|token|lovable|emailit|stripe/i.test(k)) {
                        try { const v = window[k]; suspects[k] = (typeof v === 'string') ? v.slice(0, 200) : typeof v; } catch (e) { suspects[k] = 'unreadable'; }
                    }
                }
                return { inlineCount: inline.length, inlineJoined: inline.join('\\n\\n'), winKeys, suspects };
            }""")
            blob = dump["inlineJoined"]
            findings: dict[str, list[str]] = {}
            for label, rx in SECRET_PATTERNS.items():
                hits = rx.findall(blob)
                if hits:
                    findings[label] = sorted(set(hits))[:3]
            # JWTs other than the known anon key
            all_jwt = set(JWT_RE.findall(blob)) | set(LONG_EYJ_RE.findall(blob))
            unexpected_jwt = [j for j in all_jwt if j != ANON_KEY and ANON_KEY not in j and j not in ANON_KEY]
            anon_present = ANON_KEY in blob or any(ANON_KEY[:60] in j for j in all_jwt)
            aggregate[name] = {
                "inlineCount": dump["inlineCount"],
                "findings": findings,
                "unexpected_jwt_count": len(unexpected_jwt),
                "anon_key_present": anon_present,
                "suspect_window_keys": dump["suspects"],
            }
            clean = not findings and not unexpected_jwt
            await s.record(
                feature=f"No secrets in browser output — {name} ({path})",
                promise="Only the public anon key is exposed in inline scripts / window; no service_role, sk_live, whsec, LOVABLE_API_KEY, EMAILIT or extra JWTs",
                actions=[f"open {path}", "dump every inline <script> text + suspicious window keys", "grep for secret patterns and long eyJ JWTs"],
                expected="No secret-pattern hits; no JWT other than the known public anon key; no service_role / LOVABLE_API_KEY / EMAILIT",
                actual=f"{dump['inlineCount']} inline scripts; anon key present={anon_present} (expected/public); secret-pattern findings={findings or 'none'}; "
                       f"unexpected JWTs={len(unexpected_jwt)} {[j[:24] + '…' for j in unexpected_jwt[:2]]}; suspicious window keys={dump['suspects']}",
                status="Verified" if clean else "Failed", severity="-" if clean else "P0",
                impact="" if clean else "A privileged secret is exposed in the public page output",
                extra={"summary": aggregate[name], "window_key_count": len(dump["winKeys"])},
            )
        await step(s, f"secrets {name}", one)


# ============================================================ main
async def main() -> None:
    if PHASE_DIR.exists():
        shutil.rmtree(PHASE_DIR)
    PHASE_DIR.mkdir(parents=True)
    t0 = time.time()
    async with Session(PHASE, label="anonymous attacker (desktop 1366x900)") as s:
        await dashboard_redirects(s)
        await server_functions(s)
        await public_api(s)
        await rate_limits(s)
        await sensitive_values(s)
        records = s.records
    counts: dict[str, int] = {}
    for r in records:
        counts[r["status"]] = counts.get(r["status"], 0) + 1
    print(f"\n{len(records)} records in {round(time.time() - t0)}s: {counts}")
    print(f"evidence → {PHASE_DIR / 'records.json'}")


asyncio.run(main())

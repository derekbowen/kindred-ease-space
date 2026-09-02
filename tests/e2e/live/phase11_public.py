"""
Phase 11 (+ the unauthenticated parts of Phase 2) — public customer journeys
against production, in a real Chromium, with NO account and NO sign-in.

Sessions (each a fresh browser profile) and where their evidence lands:

  docs/evidence/live-acceptance-2026-09-02/phase11-public/
    desktop/          landing, help centre, legal, auth pages, redirects, 404s,
                      robots/sitemaps, /p/ → /a/, security headers, state seed
    fresh-session/    proves a new Session carries no state from the previous one
    mobile/           390x844: landing, signup, login, help — overflow + tap targets
    slow-network/     throttled landing load: loading behaviour, time to interactive
    network-summary/  every 4xx/5xx/failed request seen across all sessions
    records.json      all records merged (the per-session files are kept too)
    http-errors.json  the raw 4xx/5xx/failed-request inventory

Safety: a page.route() aborts any call to /auth/v1/signup so the signup
validation checks can never create an account, and nothing is ever submitted
on /reset-password or /help/contact.

Run:  SMOKE_CHROMIUM_PATH=/opt/pw-browsers/chromium python3 tests/e2e/live/phase11_public.py
"""
from __future__ import annotations

import asyncio
import base64
import json
import re
import shutil
import sys
import time
import traceback
import xml.etree.ElementTree as ET
from pathlib import Path
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, str(Path(__file__).parent))
from harness import BASE, EVIDENCE, REPO, Session, now_iso, redact  # noqa: E402

PHASE = "phase11-public"
PHASE_DIR = EVIDENCE / PHASE
ALL_RECORDS: list[dict] = []
HTTP_ERRORS: list[dict] = []          # every >=400 / failed request, any session, any resource type
CONSOLE: list[str] = []               # every console error / pageerror, any session

UNKNOWN = "live-acceptance-does-not-exist-2026"
SLOW_NET = {"offline": False, "latency": 400, "downloadThroughput": 400 * 1024 / 8, "uploadThroughput": 200 * 1024 / 8}
HEADER_KEYS = ("strict-transport-security", "x-frame-options", "x-content-type-options",
               "referrer-policy", "permissions-policy", "content-type", "cache-control")


# ---------------------------------------------------------------- helpers
def wire(page, tag: str) -> None:
    """Independent of the harness filter: keep every failed/erroring request,
    static assets included, plus every console error."""
    def on_resp(r):
        if r.status >= 400:
            HTTP_ERRORS.append({"session": tag, "t": now_iso(), "status": r.status, "method": r.request.method,
                                "type": r.request.resource_type, "url": redact(r.url)})
    page.on("response", on_resp)
    page.on("requestfailed", lambda r: HTTP_ERRORS.append(
        {"session": tag, "t": now_iso(), "status": "FAILED", "error": str(r.failure), "type": r.resource_type, "url": redact(r.url)}))
    page.on("console", lambda m: CONSOLE.append(f"[{tag}] {m.type}: {m.text[:300]}") if m.type == "error" else None)
    page.on("pageerror", lambda e: CONSOLE.append(f"[{tag}] pageerror: {str(e)[:300]}"))


def errs_since(n: int) -> list[dict]:
    return HTTP_ERRORS[n:]


def console_since(n: int) -> list[str]:
    return CONSOLE[n:]


def hdrs(h: dict) -> dict:
    h = {k.lower(): v for k, v in h.items()}
    return {k: h.get(k) for k in HEADER_KEYS}


DATE_RE = re.compile(
    r"((last\s+updated|effective(\s+date)?|updated\s+on|revised)[^.\n]{0,40}?"
    r"(\d{1,2}\s+[A-Z][a-z]+\s+\d{4}|[A-Z][a-z]+\s+\d{1,2},?\s+\d{4}|\d{4}-\d{2}-\d{2}))", re.I)


async def step(s: Session, feature: str, fn):
    """Run one check; a script exception becomes a Blocked record with the
    traceback so it is visible and can be fixed + rerun, never silently skipped."""
    try:
        await fn()
    except Exception as e:  # noqa: BLE001
        tb = traceback.format_exc()[-1200:]
        print(tb)
        await s.record(feature=feature, promise="(see script)", actions=["(script raised before the check completed)"],
                       expected="-", actual=f"SCRIPT EXCEPTION (not a product verdict): {type(e).__name__}: {str(e)[:300]}",
                       status="Blocked", severity="-", impact="check did not complete; fix the script and rerun",
                       extra={"traceback": tb})


# ================================================================ DESKTOP
async def desktop() -> None:
    async with Session(f"{PHASE}/desktop", label="anonymous visitor (desktop 1366x900)") as s:
        p = s.page
        wire(p, "desktop")

        signup_attempts: list[str] = []

        async def block_signup(route):
            signup_attempts.append(redact(route.request.url))
            await route.abort()
        await p.route(re.compile(r"/auth/v1/signup"), block_signup)

        state: dict = {}   # shared between steps (landing links, headers, help slugs)

        # ---------------------------------------------------------- landing
        async def landing_hero():
            n, c = len(HTTP_ERRORS), len(CONSOLE)
            t0 = time.perf_counter()
            resp = await s.goto("/", wait="load", settle_ms=3000)
            load_s = round(time.perf_counter() - t0, 2)
            state["landing_headers"] = dict(resp.headers)
            state["landing_status"] = resp.status
            title = await p.title()
            hero = await p.evaluate("""() => {
                const h1 = document.querySelector('main h1');
                const sec = h1 ? h1.closest('section') : null;
                const ctas = sec ? [...sec.querySelectorAll('a')].map(a => ({text: a.textContent.trim().replace(/\\s+/g, ' '), href: a.getAttribute('href')})) : [];
                const eyebrow = h1?.previousElementSibling?.textContent?.trim();
                const note = sec ? [...sec.querySelectorAll('p')].map(x => x.textContent.trim()).find(t => /trial/i.test(t)) : null;
                return {h1: h1?.textContent.trim(), eyebrow, ctas, note, hasPricing: !!document.getElementById('pricing'), hasFaq: !!document.getElementById('faq'), hasDemo: !!document.getElementById('demo')};
            }""")
            start = next((c for c in hero["ctas"] if "trial" in c["text"].lower()), None)
            demo = next((c for c in hero["ctas"] if "demo" in c["text"].lower()), None)
            ok = (resp.status == 200 and hero["h1"] and start and start["href"] == "/signup" and demo
                  and hero["hasPricing"] and hero["hasFaq"] and not errs_since(n) and not console_since(c))
            await s.record(
                feature="Landing page — hero",
                promise="Marketing home renders: eyebrow, headline, primary 'Start your free trial' CTA to /signup, 'Watch the demo' anchor, trial note",
                actions=["open / in a fresh profile", "wait for the load event", "read the hero section"],
                expected="HTTP 200; h1 + two CTAs; pricing/FAQ/demo sections present; no console errors; no failed resources",
                actual=f"HTTP {resp.status} in {load_s}s; title={title!r}; h1={hero['h1']!r}; eyebrow={hero['eyebrow']!r}; ctas={hero['ctas']}; note={hero['note']!r}; "
                       f"sections pricing={hero['hasPricing']} faq={hero['hasFaq']} demo={hero['hasDemo']}; console_errors={console_since(c)}; failed_resources={errs_since(n)}",
                status="Verified" if ok else "Failed", severity="-" if ok else "P1",
                impact="" if ok else "First impression / primary conversion path broken",
                extra={"load_seconds": load_s, "title": title, "hero": hero},
            )
        await step(s, "Landing page — hero", landing_hero)

        async def landing_pricing():
            await p.locator("#pricing").scroll_into_view_if_needed()
            await p.wait_for_timeout(600)
            pr = await p.evaluate("""() => {
                const sec = document.getElementById('pricing'); if (!sec) return null;
                const txt = sec.innerText;
                return {heading: sec.querySelector('h2')?.textContent.trim(), prices: (txt.match(/\\$\\s?\\d[\\d,]*/g) || []),
                        plans: [...sec.querySelectorAll('h3')].map(h => h.textContent.trim()),
                        ctas: [...sec.querySelectorAll('a')].map(a => ({text: a.textContent.trim().replace(/\\s+/g,' '), href: a.getAttribute('href')})),
                        textLen: txt.length};
            }""")
            ok = bool(pr and pr["prices"] and pr["ctas"] and pr["heading"])
            await s.record(
                feature="Landing page — pricing section",
                promise="Plans and monthly prices are shown on the home page with a CTA per plan",
                actions=["scroll to #pricing"],
                expected="Section with heading, at least one $ price, plan names and CTA links",
                actual=f"heading={pr and pr['heading']!r}; plans={pr and pr['plans']}; prices={pr and pr['prices']}; ctas={pr and pr['ctas']}",
                status="Verified" if ok else "Failed", severity="-" if ok else "P2", extra={"pricing": pr},
            )
        await step(s, "Landing page — pricing section", landing_pricing)

        async def landing_faq():
            await p.locator("#faq").scroll_into_view_if_needed()
            await p.wait_for_timeout(400)
            faq_state = "() => [0,1,2,3,4].map(i => { const b = document.getElementById('faq-button-'+i); const pnl = document.getElementById('faq-panel-'+i); return {i, exp: b?.getAttribute('aria-expanded'), hidden: pnl?.hidden, focused: document.activeElement === b, txt: b?.textContent.trim().slice(0,40)}; })"
            s0 = await p.evaluate(faq_state)
            await p.focus("#faq-button-0")
            await p.keyboard.press("Enter")          # collapse item 0 (open by default)
            await p.wait_for_timeout(250)
            s1 = await p.evaluate(faq_state)
            await p.keyboard.press("Tab")            # focus moves to item 1
            await p.wait_for_timeout(150)
            s2 = await p.evaluate(faq_state)
            await p.keyboard.press("Space")          # expand item 1
            await p.wait_for_timeout(250)
            s3 = await p.evaluate(faq_state)
            await p.keyboard.press("Tab")            # focus item 2
            await p.wait_for_timeout(150)
            s4 = await p.evaluate(faq_state)
            await p.keyboard.press("Shift+Tab")      # back to item 1
            await p.wait_for_timeout(150)
            s5 = await p.evaluate(faq_state)
            ok = (s0[0]["exp"] == "true" and s0[0]["hidden"] is False
                  and s1[0]["exp"] == "false" and s1[0]["hidden"] is True
                  and s2[1]["focused"] and s3[1]["exp"] == "true" and s3[1]["hidden"] is False
                  and s4[2]["focused"] and s5[1]["focused"])
            await s.record(
                feature="Landing page — FAQ accordion by keyboard",
                promise="FAQ items toggle with Enter/Space and Tab moves between questions (aria-expanded + hidden panels)",
                actions=["scroll to #faq", "focus question 1, press Enter", "Tab", "Space", "Tab", "Shift+Tab"],
                expected="Q1 open by default → Enter closes it; Tab focuses Q2; Space opens Q2; Tab focuses Q3; Shift+Tab returns to Q2",
                actual=f"initial={[(x['exp'], x['hidden']) for x in s0]}; after Enter Q1={s1[0]['exp']}/{s1[0]['hidden']}; Tab→Q2 focused={s2[1]['focused']}; "
                       f"Space Q2={s3[1]['exp']}/{s3[1]['hidden']}; Tab→Q3 focused={s4[2]['focused']}; Shift+Tab→Q2 focused={s5[1]['focused']}",
                status="Verified" if ok else "Failed", severity="-" if ok else "P2",
                impact="" if ok else "Keyboard-only customers cannot read the FAQ",
                extra={"states": {"initial": s0, "enter": s1, "tab": s2, "space": s3, "tab2": s4, "shift_tab": s5}},
            )
        await step(s, "Landing page — FAQ accordion by keyboard", landing_faq)

        async def landing_links():
            links = await p.evaluate("""() => [...document.querySelectorAll('a[href]')].map(a => ({
                href: a.getAttribute('href'), text: a.textContent.trim().replace(/\\s+/g,' ').slice(0,50),
                where: a.closest('header') ? 'header' : a.closest('footer') ? 'footer' : (a.closest('section')?.id || 'main'),
                visible: !!(a.offsetParent || a.getClientRects().length)}))""")
            state["landing_links"] = links
            results, seen = [], {}
            for l in links:
                href = l["href"]
                if href in seen:
                    continue
                r = {"href": href, "text": l["text"], "where": l["where"], "visible": l["visible"]}
                try:
                    if href.startswith("#"):
                        r["kind"] = "anchor"
                        r["ok"] = await p.evaluate("(id) => !!document.getElementById(id)", href[1:])
                        r["status"] = "element present" if r["ok"] else "MISSING TARGET"
                    elif href.startswith(("mailto:", "tel:")):
                        r["kind"] = "mailto"; r["ok"] = True; r["status"] = "not fetched"
                    else:
                        url = href if href.startswith("http") else BASE + href
                        internal = urlparse(url).hostname in ("founders.click", "www.founders.click")
                        r["kind"] = "internal" if internal else "external"
                        if re.search(r"\.(mp4|zip|pdf)$", url, re.I):
                            ar = await s.context.request.fetch(url, method="HEAD", timeout=20000)
                        else:
                            ar = await s.context.request.get(url, timeout=20000)
                        r["status"] = ar.status; r["final_url"] = redact(ar.url); r["ok"] = ar.status < 400
                except Exception as e:  # noqa: BLE001
                    r["status"] = f"ERROR {type(e).__name__}: {str(e)[:80]}"; r["ok"] = False
                seen[href] = r
                results.append(r)
            bad_internal = [r for r in results if r["kind"] in ("internal", "anchor") and not r["ok"]]
            bad_external = [r for r in results if r["kind"] == "external" and not r["ok"]]
            ok = not bad_internal and not bad_external
            await s.record(
                feature="Landing page — every CTA / nav / footer link resolves",
                promise="Every link on the home page goes somewhere real (no dead CTAs)",
                actions=["collect all a[href] on /", "GET each internal + external URL (HEAD for media)", "check each #anchor has a target element"],
                expected="All internal links < 400, all anchors have targets, external links reachable",
                actual=f"{len(results)} unique links: " + "; ".join(f"{r['href']}→{r['status']}" for r in results)
                       + (f"; BAD internal={bad_internal}" if bad_internal else "") + (f"; BAD external={bad_external}" if bad_external else ""),
                status="Verified" if ok else "Failed", severity="-" if ok else ("P2" if bad_internal else "P3"),
                impact="" if ok else "Customers hit dead links from the home page",
                extra={"links": results},
            )
        await step(s, "Landing page — every CTA / nav / footer link resolves", landing_links)

        async def landing_video():
            mp4 = [e for e in HTTP_ERRORS if "product-demo.mp4" in e["url"]]
            # Browser-side Range probe: ask for 1 KB and abort after the headers, so we
            # learn whether the origin honours Range without pulling another 25 MB.
            rng = await p.evaluate("""async () => { const c = new AbortController();
                try { const r = await fetch('/product-demo.mp4?live-acceptance-range-probe=1', {headers: {Range: 'bytes=0-1023'}, signal: c.signal, cache: 'no-store'});
                      const h = {status: r.status, acceptRanges: r.headers.get('accept-ranges'), contentRange: r.headers.get('content-range'), contentLength: r.headers.get('content-length'), cfCache: r.headers.get('cf-cache-status')};
                      c.abort(); return h; } catch (e) { return {error: String(e)}; } }""")
            v = await p.evaluate("""() => {
                const v = document.querySelector('video');
                const nav = performance.getEntriesByType('navigation')[0] || {};
                const res = performance.getEntriesByType('resource').filter(e => /product-demo/.test(e.name))
                    .map(e => ({name: e.name.split('/').pop(), transferSize: e.transferSize, encodedBodySize: e.encodedBodySize, initiator: e.initiatorType, ms: Math.round(e.duration)}));
                const totalTransfer = performance.getEntriesByType('resource').reduce((a, e) => a + (e.transferSize || 0), 0);
                const overlay = document.querySelector('button[aria-label*="Play"]');
                return {present: !!v, preload: v?.preload, poster: v?.getAttribute('poster'), readyState: v?.readyState, networkState: v?.networkState,
                        paused: v?.paused, controls: v?.controls, muted: v?.muted, src: v?.currentSrc?.split('/').pop(),
                        overlayButton: !!overlay, dcl_ms: Math.round(nav.domContentLoadedEventEnd || 0), load_ms: Math.round(nav.loadEventEnd || 0), res, totalTransfer};
            }""")
            mp4_bytes = sum(r.get("transferSize", 0) for r in v["res"] if r["name"].startswith("product-demo.mp4"))
            range_honoured = rng.get("status") == 206
            ok = (v["present"] and v["preload"] == "metadata" and v["poster"] and v["paused"] and v["overlayButton"]
                  and v["load_ms"] > 0 and mp4_bytes < 3_000_000 and not mp4)
            await s.record(
                feature="Landing page — 25 MB demo video does not block the page",
                promise="The product demo is poster + click-to-play; the page load does not wait on (or silently download) the 25 MB mp4",
                actions=["after the load event, inspect the <video> element and Resource Timing for product-demo.*",
                         "fetch /product-demo.mp4 with 'Range: bytes=0-1023' from the page and read the response headers"],
                expected="preload=metadata, poster shown, video paused with a Play overlay, load event fired, only a small metadata range of the mp4 fetched (< 3 MB, i.e. origin answers 206 to Range requests), no mp4 errors",
                actual=f"video present={v['present']} preload={v['preload']!r} poster={v['poster']!r} paused={v['paused']} overlay={v['overlayButton']} readyState={v['readyState']} networkState={v['networkState']}; "
                       f"DCL={v['dcl_ms']}ms load={v['load_ms']}ms; mp4 bytes transferred before any play={mp4_bytes:,} (entries={v['res']}); page total transfer≈{v['totalTransfer']:,} bytes; "
                       f"Range probe → {rng} (206 expected; 200 = origin ignores Range); mp4 errors={mp4}",
                status="Verified" if ok else "Failed", severity="-" if ok else "P2",
                impact="" if ok else "Every visitor to the home page downloads the full 25.8 MB mp4 without pressing Play (on a 400 kbps connection that is ~8.5 minutes of saturated bandwidth competing with the page's own JS/fonts)",
                repro=[] if ok else ["open https://www.founders.click/ in Chrome with DevTools → Network", "do not click Play",
                                     "observe product-demo.mp4 transfers 25.8 MB (initiator: video, HTTP 200, no Accept-Ranges)",
                                     "curl -r 0-1023 -o /dev/null -w '%{http_code} %{size_download}' https://www.founders.click/product-demo.mp4 → 200 25845156"],
                extra={"video": v, "range_probe": rng, "range_honoured": range_honoured,
                       "root_cause_supporting_evidence": "public/product-demo.mp4 in the repo is not faststart: top-level atoms ftyp(0) free(32) mdat(40, 25,381,911 B) moov(25,381,951) — the metadata is at the END of the file, so preload=metadata must read to the end; and the origin answers HTTP 200 (full body, no Accept-Ranges) to Range requests, so the browser cannot skip to the tail.",
                       "sandbox_note": "networkState=3/readyState=0 after the download is consistent with this headless Chromium lacking the H.264 decoder; playback itself is not verifiable here"},
            )
        await step(s, "Landing page — 25 MB demo video does not block the page", landing_video)

        async def landing_clean():
            # our own aborted 1 KB Range probe (tagged ?live-acceptance-range-probe=1) is not a page failure
            errs = [e for e in HTTP_ERRORS if e["session"] == "desktop" and "live-acceptance-range-probe" not in e["url"]]
            cons = [c for c in CONSOLE if c.startswith("[desktop]")]
            ok = not errs and not cons
            await s.record(
                feature="Landing page — no console errors, no failed resources",
                promise="A visitor's first page load is clean (no JS errors, no 4xx/5xx/blocked assets)",
                actions=["listen to every response/requestfailed/console-error during the whole landing visit (load, scroll, FAQ, link probing)"],
                expected="Zero console errors and zero failed/erroring requests (the test's own aborted Range probe excluded)",
                actual=f"console_errors={cons}; failed_or_4xx5xx_requests={errs}",
                status="Verified" if ok else "Failed", severity="-" if ok else "P2",
                extra={"console": cons, "requests": errs},
            )
        await step(s, "Landing page — no console errors, no failed resources", landing_clean)

        # ---------------------------------------------------------- help centre
        async def help_home():
            n, c = len(HTTP_ERRORS), len(CONSOLE)
            resp = await s.goto("/help")
            info = await p.evaluate("""() => {
                const links = [...document.querySelectorAll('a[href^="/help/"]')].map(a => ({href: a.getAttribute('href'), text: a.textContent.trim().replace(/\\s+/g,' ').slice(0,60)}))
                    .filter(l => !/^\\/help\\/(contact|search|sitemap)/.test(l.href));
                return {h1: document.querySelector('h1')?.textContent.trim(), links, search: !!document.querySelector('input[type=search], input[name=q]'), textLen: document.body.innerText.length};
            }""")
            cats = [l for l in info["links"] if l["href"].count("/") == 2]
            arts = [l for l in info["links"] if l["href"].count("/") == 3]
            state["help_cat"] = cats[0] if cats else None
            state["help_art"] = arts[0] if arts else None
            ok = resp.status == 200 and bool(cats or arts) and not console_since(c)
            await s.record(
                feature="Help centre — home",
                promise="Public help centre lists categories/articles with a search box",
                actions=["open /help"],
                expected="HTTP 200, heading, category links, search input",
                actual=f"HTTP {resp.status}; h1={info['h1']!r}; categories={len(cats)} (first={state['help_cat']}); article links={len(arts)}; search box={info['search']}; console={console_since(c)}; errors={errs_since(n)}",
                status="Verified" if ok else "Failed", severity="-" if ok else "P2", extra={"links": info["links"][:30]},
            )
        await step(s, "Help centre — home", help_home)

        async def help_category():
            cat = state.get("help_cat") or (state.get("help_art") and {"href": "/" + "/".join(state["help_art"]["href"].split("/")[1:3]), "text": "(derived)"})
            if not cat:
                await s.record(feature="Help centre — category page", promise="Open a category", actions=["no category link found on /help"],
                               expected="category page", actual="no category links discovered on /help", status="Blocked", severity="-",
                               impact="need at least one published category")
                return
            n, c = len(HTTP_ERRORS), len(CONSOLE)
            resp = await s.goto(cat["href"])
            info = await p.evaluate("""() => ({h1: document.querySelector('h1')?.textContent.trim(),
                arts: [...document.querySelectorAll('a[href^="/help/"]')].map(a => a.getAttribute('href')).filter(h => h.split('/').length === 4).slice(0, 20),
                crumb: document.querySelector('nav[aria-label*="read" i], nav ol')?.textContent.trim().replace(/\\s+/g,' ').slice(0,80)})""")
            if info["arts"] and not state.get("help_art"):
                state["help_art"] = {"href": info["arts"][0], "text": ""}
            ok = resp.status == 200 and bool(info["h1"]) and bool(info["arts"]) and not console_since(c)
            await s.record(
                feature="Help centre — category page",
                promise="A category lists its articles",
                actions=[f"open {cat['href']} ({cat['text']})"],
                expected="HTTP 200, category heading, article links",
                actual=f"HTTP {resp.status}; h1={info['h1']!r}; breadcrumb={info['crumb']!r}; articles={len(info['arts'])} e.g. {info['arts'][:3]}; console={console_since(c)}",
                status="Verified" if ok else "Failed", severity="-" if ok else "P2",
            )
        await step(s, "Help centre — category page", help_category)

        async def help_article():
            art = state.get("help_art")
            if not art:
                await s.record(feature="Help centre — article page", promise="Read an article", actions=["no article link found"],
                               expected="article page", actual="no article links discovered", status="Blocked", severity="-")
                return
            n, c = len(HTTP_ERRORS), len(CONSOLE)
            resp = await s.goto(art["href"])
            info = await p.evaluate("""() => ({h1: document.querySelector('h1')?.textContent.trim(), title: document.title,
                bodyLen: (document.querySelector('article') || document.querySelector('main') || document.body).innerText.length,
                paragraphs: document.querySelectorAll('article p, main p').length,
                feedback: !!document.querySelector('button, [role=button]') && /helpful/i.test(document.body.innerText)})""")
            state["help_title"] = info["h1"] or ""
            ok = resp.status == 200 and bool(info["h1"]) and info["bodyLen"] > 300 and not console_since(c)
            await s.record(
                feature="Help centre — article page",
                promise="An article renders with real content",
                actions=[f"open {art['href']}"],
                expected="HTTP 200, article title, body text",
                actual=f"HTTP {resp.status}; title={info['title']!r}; h1={info['h1']!r}; text chars={info['bodyLen']}; paragraphs={info['paragraphs']}; 'was this helpful' widget={info['feedback']}; console={console_since(c)}",
                status="Verified" if ok else "Failed", severity="-" if ok else "P2",
            )
        await step(s, "Help centre — article page", help_article)

        async def help_search_hit():
            words = [w for w in re.findall(r"[A-Za-z]{5,}", state.get("help_title", "")) if w.lower() not in {"about", "their", "which", "there", "these", "using", "guide"}]
            words = words[:3] or ["billing", "pages"]
            tried = []
            for w in words:
                resp = await s.goto(f"/help/search?q={w}")
                body = await s.text()
                m = re.search(r"(\d+) results? for", body)
                tried.append((w, resp.status, m.group(1) if m else None))
                if m and int(m.group(1)) > 0:
                    break
            w, st, cnt = tried[-1]
            rows = await p.evaluate("""() => [...document.querySelectorAll('a[href^="/help/"]')].map(a => a.getAttribute('href')).filter(h => h.split('/').length === 4).slice(0,5)""")
            ok = st == 200 and cnt and int(cnt) > 0 and bool(rows)
            await s.record(
                feature="Help centre — search with a hit",
                promise="Searching a word from an article title finds it",
                actions=[f"open /help/search?q=<word> (tried {tried})"],
                expected="'N results for \"word\"' with clickable article rows",
                actual=f"query={w!r} HTTP {st}; results={cnt}; first rows={rows}",
                status="Verified" if ok else "Failed", severity="-" if ok else "P2",
            )
        await step(s, "Help centre — search with a hit", help_search_hit)

        async def help_search_miss():
            n, c = len(HTTP_ERRORS), len(CONSOLE)
            q = "zzqxvblorptest"
            resp = await s.goto(f"/help/search?q={q}")
            body = await s.text()
            no = f'No articles match "{q}"' in body
            tips = "search tips" in body.lower()
            contact = await p.locator("a[href='/help/contact']").count()
            ok = resp.status == 200 and no and contact > 0 and not console_since(c)
            await s.record(
                feature="Help centre — search with no hit",
                promise="A miss shows a friendly empty state with tips, popular articles and a contact link",
                actions=[f"open /help/search?q={q}"],
                expected="'No articles match' + search tips + Contact support link; HTTP 200",
                actual=f"HTTP {resp.status}; no-match copy={no}; tips={tips}; contact links={contact}; console={console_since(c)}; body starts: {body[:140]!r}",
                status="Verified" if ok else "Failed", severity="-" if ok else "P3",
            )
        await step(s, "Help centre — search with no hit", help_search_miss)

        async def help_contact():
            n, c = len(HTTP_ERRORS), len(CONSOLE)
            resp = await s.goto("/help/contact")
            info = await p.evaluate("""() => ({h1: document.querySelector('h1')?.textContent.trim(),
                fields: [...document.querySelectorAll('form input, form textarea, form select, form [role=combobox]')].map(e => (e.getAttribute('name') || e.id || e.getAttribute('aria-label') || e.tagName).toLowerCase()),
                submit: [...document.querySelectorAll('form button')].map(b => b.textContent.trim()).filter(Boolean)})""")
            ok = resp.status == 200 and any("email" in f for f in info["fields"]) and any("message" in f or "textarea" in f for f in info["fields"]) and bool(info["submit"]) and not console_since(c)
            await s.record(
                feature="Help centre — contact form renders",
                promise="Contact support page shows a usable form (NOT submitted in this phase)",
                actions=["open /help/contact", "inspect the form fields"],
                expected="HTTP 200; email + message fields; a submit button",
                actual=f"HTTP {resp.status}; h1={info['h1']!r}; fields={info['fields']}; submit={info['submit']}; console={console_since(c)}",
                status="Verified" if ok else "Failed", severity="-" if ok else "P2",
                extra={"note": "form deliberately not submitted (submission covered by phase_public_contact.py)"},
            )
        await step(s, "Help centre — contact form renders", help_contact)

        # ---------------------------------------------------------- legal
        async def legal(path: str, label: str):
            n, c = len(HTTP_ERRORS), len(CONSOLE)
            resp = await s.goto(path)
            body = await s.text()
            info = await p.evaluate("""() => ({h1: document.querySelector('h1')?.textContent.trim(), title: document.title,
                h2s: [...document.querySelectorAll('h2')].map(h => h.textContent.trim()).slice(0,12), time: document.querySelector('time')?.textContent.trim(), len: document.body.innerText.length})""")
            m = DATE_RE.search(body)
            date = m.group(0) if m else (info["time"] or None)
            footer = [l for l in state.get("landing_links", []) if l["href"] == path and l["where"] == "footer"]
            ok = resp.status == 200 and info["len"] > 1500 and bool(date) and bool(footer) and not console_since(c)
            await s.record(
                feature=f"{label} page",
                promise=f"{label} is real, dated text reachable from the site footer",
                actions=[f"open {path}", "look for a 'last updated/effective' date", "confirm a footer link on / points here"],
                expected="HTTP 200, substantive text (> 1500 chars), a visible date, footer link present",
                actual=f"HTTP {resp.status}; title={info['title']!r}; h1={info['h1']!r}; chars={info['len']}; sections={len(info['h2s'])} {info['h2s'][:5]}; date={date!r}; footer link on /={bool(footer)}; console={console_since(c)}",
                status="Verified" if ok else "Failed", severity="-" if ok else "P2",
                impact="" if ok else "Legal terms missing or undated",
            )
        await step(s, "Privacy policy page", lambda: legal("/privacy", "Privacy policy"))
        await step(s, "Terms of service page", lambda: legal("/terms", "Terms of service"))

        # ---------------------------------------------------------- signup validation (never submits)
        async def signup_validation():
            resp = await s.goto("/signup", settle_ms=1500)
            title = await p.title()
            validity = "() => { const f = document.querySelector('form'); const g = id => { const e = document.getElementById(id); return e ? {value: e.value, valid: e.validity.valid, valueMissing: e.validity.valueMissing, typeMismatch: e.validity.typeMismatch, tooShort: e.validity.tooShort, msg: e.validationMessage} : null; }; return {formValid: f?.checkValidity(), name: g('name'), email: g('email'), password: g('password'), focused: document.activeElement?.id, confirmScreen: /sent a confirmation link/i.test(document.body.innerText)}; }"
            n_before = len([x for x in s._net if "auth/v1" in x["url"]])
            # 1) empty submit
            await p.get_by_role("button", name="Start free trial").click()
            await p.wait_for_timeout(600)
            empty = await p.evaluate(validity)
            toasts_empty = await s.toasts()
            await s.record(
                feature="Signup — empty form is refused",
                promise="Submitting /signup with nothing filled does not create anything and points at the first missing field",
                actions=["open /signup", "click 'Start free trial' with all fields empty"],
                expected="Browser validation blocks: form invalid, name field flagged valueMissing and focused; no call to /auth/v1/signup; still on /signup",
                actual=f"formValid={empty['formValid']}; name={empty['name']}; focused={empty['focused']!r}; toasts={toasts_empty}; signup calls attempted={signup_attempts}; url={p.url}; confirmScreen={empty['confirmScreen']}",
                status="Verified" if (empty["formValid"] is False and empty["name"]["valueMissing"] and not signup_attempts and "/signup" in p.url) else "Failed",
                severity="-" if empty["formValid"] is False else "P1",
                extra={"validity": empty, "title": title},
            )
            # 2) bad email
            await p.get_by_label("Your name").fill("Live Acceptance Test")
            await p.get_by_label("Email").press_sequentially("not-an-email")
            await p.get_by_label("Password").press_sequentially("validpassword123")
            await p.get_by_role("button", name="Start free trial").click()
            await p.wait_for_timeout(600)
            bad = await p.evaluate(validity)
            await s.record(
                feature="Signup — malformed email is refused",
                promise="An email without an @ cannot be submitted",
                actions=["fill name", "type 'not-an-email' in Email", "type a valid password", "click 'Start free trial'"],
                expected="Email flagged typeMismatch with a validation message; form not submitted; no /auth/v1/signup call",
                actual=f"formValid={bad['formValid']}; email={bad['email']}; focused={bad['focused']!r}; signup calls attempted={signup_attempts}; url={p.url}",
                status="Verified" if (bad["formValid"] is False and bad["email"]["typeMismatch"] and not signup_attempts) else "Failed",
                severity="-" if bad["formValid"] is False else "P1", extra={"validity": bad},
            )
            # 3) short password
            await p.get_by_label("Email").fill("")
            await p.get_by_label("Email").press_sequentially("live-acceptance-noreply@example.com")
            await p.get_by_label("Password").fill("")
            await p.get_by_label("Password").press_sequentially("short")
            await p.get_by_role("button", name="Start free trial").click()
            await p.wait_for_timeout(600)
            short = await p.evaluate(validity)
            await s.record(
                feature="Signup — short password is refused",
                promise="Passwords under 8 characters cannot be submitted",
                actions=["valid name + email", "type 'short' (5 chars) in Password", "click 'Start free trial'"],
                expected="Password flagged tooShort with a validation message; no /auth/v1/signup call; no account created",
                actual=f"formValid={short['formValid']}; password={short['password']}; focused={short['focused']!r}; signup calls attempted={signup_attempts}; url={p.url}; confirmScreen={short['confirmScreen']}",
                status="Verified" if (short["formValid"] is False and short["password"]["tooShort"] and not signup_attempts) else "Failed",
                severity="-" if short["formValid"] is False else "P1", extra={"validity": short},
                persistence="nothing submitted (route guard confirms zero signup requests)" if not signup_attempts else "A SIGNUP REQUEST WAS ATTEMPTED (aborted by the test guard)",
            )
            # signup page extras: terms/privacy links, Google button, sign-in link
            extras = await p.evaluate("""() => ({terms: !!document.querySelector('a[href="/terms"]'), privacy: !!document.querySelector('a[href="/privacy"]'),
                google: [...document.querySelectorAll('button')].some(b => /google/i.test(b.textContent)), signin: !!document.querySelector('a[href="/login"]'),
                robots: document.querySelector('meta[name=robots]')?.content})""")
            await s.record(
                feature="Signup — page furniture",
                promise="Signup page links to Terms/Privacy, offers Google sign-in and a link to sign in; not indexed",
                actions=["inspect /signup"],
                expected="Terms + Privacy links, 'Continue with Google' button, 'Sign in' link, robots noindex",
                actual=f"{extras}",
                status="Verified" if all([extras["terms"], extras["privacy"], extras["google"], extras["signin"]]) else "Failed", severity="-" if extras["terms"] else "P3",
            )
        await step(s, "Signup — validation", signup_validation)

        # ---------------------------------------------------------- login
        async def login_wrong_password():
            n, c = len(HTTP_ERRORS), len(CONSOLE)
            resp = await s.goto("/login", settle_ms=1500)
            await p.get_by_label("Email").fill("live-acceptance-nobody-2026@example.com")
            await p.get_by_label("Password").fill("definitely-wrong-password")
            t0 = time.perf_counter()
            await p.get_by_role("button", name="Sign in").click()
            try:
                await p.locator("[role=alert]").first.wait_for(timeout=15000)
            except Exception:  # noqa: BLE001
                pass
            dt = round(time.perf_counter() - t0, 2)
            alert = (await p.locator("[role=alert]").first.inner_text()).strip() if await p.locator("[role=alert]").count() else ""
            toasts = await s.toasts()
            auth = [x for x in s._net if "/auth/v1/token" in x["url"]]
            ok = "/login" in p.url and bool(alert) and any(x.get("status") == 400 for x in auth)
            await s.record(
                feature="Login — wrong password shows an error",
                promise="A bad email/password combination is refused with a clear message and the customer stays on the login page",
                actions=["open /login", "enter an unknown email + wrong password", "click Sign in"],
                expected="Inline role=alert 'Invalid login credentials' (+ toast); HTTP 400 from /auth/v1/token; URL stays /login",
                actual=f"alert={alert!r} after {dt}s; toasts={toasts}; auth responses={[(x['status'], x.get('body', '')[:80]) for x in auth]}; url={p.url}",
                status="Verified" if ok else "Failed", severity="-" if ok else "P1",
                impact="" if ok else "Customers get no feedback on a failed sign-in",
            )
        await step(s, "Login — wrong password shows an error", login_wrong_password)

        async def login_tab_order():
            await s.goto("/login", settle_ms=1200)
            desc = "() => { const e = document.activeElement; return e ? {tag: e.tagName.toLowerCase(), id: e.id || null, type: e.getAttribute('type'), text: (e.textContent || '').trim().replace(/\\s+/g,' ').slice(0,30), href: e.getAttribute('href')} : null; }"
            seq = []
            for _ in range(9):
                await p.keyboard.press("Tab")
                seq.append(await p.evaluate(desc))
                if seq[-1] and seq[-1]["tag"] == "button" and seq[-1]["text"] == "Sign in":
                    break
            ids = [(x or {}).get("id") or (x or {}).get("text") for x in seq]
            i_email = ids.index("email") if "email" in ids else -1
            i_pw = ids.index("password") if "password" in ids else -1
            i_btn = ids.index("Sign in") if "Sign in" in ids else -1
            ok = 0 <= i_email < i_pw < i_btn
            await s.record(
                feature="Login — keyboard Tab order reaches Sign in",
                promise="Tab moves logo → email → password → Sign in in a sensible order",
                actions=["open /login", "press Tab repeatedly, reading document.activeElement each time"],
                expected="email, then password, then the Sign in button (within a few tabs)",
                actual=f"tab sequence={ids} (email@{i_email}, password@{i_pw}, Sign in@{i_btn})",
                status="Verified" if ok else "Failed", severity="-" if ok else "P2", extra={"sequence": seq},
            )
        await step(s, "Login — keyboard Tab order reaches Sign in", login_tab_order)

        async def reset_page():
            n, c = len(HTTP_ERRORS), len(CONSOLE)
            resp = await s.goto("/reset-password", settle_ms=1500)
            info = await p.evaluate("""() => ({title: document.title, copy: [...document.querySelectorAll('p')].map(x => x.textContent.trim()).slice(0,3),
                email: !!document.getElementById('email'), submit: [...document.querySelectorAll('form button')].map(b => b.textContent.trim()),
                back: !!document.querySelector('a[href="/login"]'), robots: document.querySelector('meta[name=robots]')?.content})""")
            ok = resp.status == 200 and info["email"] and any("reset" in b.lower() for b in info["submit"]) and info["back"] and not console_since(c)
            await s.record(
                feature="Reset password — request page renders",
                promise="Forgot-password page shows an email field and 'Send reset link' (NOT submitted in this phase)",
                actions=["open /reset-password"],
                expected="HTTP 200; 'We'll email you a reset link'; Email input; Send reset link button; Back to sign in link",
                actual=f"HTTP {resp.status}; {info}; console={console_since(c)}",
                status="Verified" if ok else "Failed", severity="-" if ok else "P1",
                extra={"note": "not submitted — email sending covered in phase 2"},
            )
        await step(s, "Reset password — request page renders", reset_page)

        # ---------------------------------------------------------- unauthenticated redirects (timed)
        async def redirects():
            for path in ["/app", "/app/pages", "/app/billing", "/app/settings"]:
                n, c = len(HTTP_ERRORS), len(CONSOLE)
                t0 = time.perf_counter()
                r = await p.goto(BASE + path, wait_until="commit", timeout=45000)
                commit_s = round(time.perf_counter() - t0, 2)
                await p.wait_for_timeout(700)
                mid_url = p.url
                mid_txt = (await s.text())[:100]
                mid_shot = await s.shot(f"waiting {path}")
                redirected = True
                try:
                    await p.wait_for_url(re.compile(r"/login"), timeout=20000)
                except Exception:  # noqa: BLE001
                    redirected = False
                delay = round(time.perf_counter() - t0, 2)
                await p.wait_for_timeout(800)
                final = p.url
                nxt = (parse_qs(urlparse(final).query).get("next") or [None])[0]
                ok = redirected and nxt == path
                blank = mid_txt.strip() == "" and mid_url.rstrip("/").endswith(path)
                await s.record(
                    feature=f"Unauthenticated visit to {path} redirects to login",
                    promise="Dashboard URLs bounce an anonymous visitor to /login and remember where they were going",
                    actions=[f"open {path} in a profile with no session", "time the redirect", "screenshot what is shown while waiting"],
                    expected=f"→ /login?next={path}",
                    actual=f"HTTP {r.status} shell committed at {commit_s}s; redirected={redirected} to {final} after {delay}s; next={nxt!r}; "
                           f"while waiting (t≈0.7s, url={mid_url.replace(BASE, '')}) customer sees: {'a BLANK WHITE page (no spinner/skeleton)' if blank else mid_txt!r}; console={console_since(c)}",
                    status="Verified" if ok else "Failed", severity="-" if ok else "P0",
                    impact="" if ok else "Anonymous visitors can reach or get stuck on dashboard URLs",
                    extra={"redirect_seconds": delay, "commit_seconds": commit_s, "waiting_screenshot": mid_shot, "blank_while_waiting": blank,
                           "note": "delay ≈ the 3 s waitForSession() timeout in src/routes/_authenticated.tsx (client-side guard, ssr:false)"},
                )
        await step(s, "Unauthenticated redirects", redirects)

        # ---------------------------------------------------------- 404s, robots, sitemaps, /p/, /a/, /s/, /apply/
        async def unknown_route():
            n, c = len(HTTP_ERRORS), len(CONSOLE)
            r = await s.goto(f"/{UNKNOWN}")
            body = await s.text()
            info = await p.evaluate("""() => ({title: document.title, h1: document.querySelector('h1')?.textContent.trim(), h2: document.querySelector('h2')?.textContent.trim(),
                home: !!document.querySelector('a[href="/"]'), favicon: document.querySelector('link[rel=icon]')?.href, brand: /founders/i.test(document.body.innerText),
                bg: getComputedStyle(document.body).backgroundColor, logo: !!document.querySelector('header, img[alt*="founders" i], svg[aria-label*="founders" i]')})""")
            ok = r.status == 404 and "404" in body and "Page not found" in body and info["home"]
            await s.record(
                feature="Unknown route returns a branded 404",
                promise="A typo'd URL gets a proper HTTP 404 and a page that looks like ours with a way home",
                actions=[f"open /{UNKNOWN}"],
                expected="HTTP 404; '404 / Page not found' copy; 'Go home' link; site title/favicon",
                actual=f"HTTP {r.status}; title={info['title']!r}; h1={info['h1']!r} h2={info['h2']!r}; Go-home link={info['home']}; wordmark/header on page={info['logo']}; brand text in body={info['brand']}; "
                       f"body background={info['bg']} (light theme; the marketing site is dark); favicon={info['favicon']}",
                status="Verified" if ok else "Failed", severity="-" if ok else "P2",
                extra={"note": "P3 polish: the 404 body carries no wordmark/logo and renders light-themed while every other public page is dark; brand only via <title>, favicon and the orange 'Go home' button"},
            )
        await step(s, "Unknown route returns a branded 404", unknown_route)

        async def text_file(path: str, feature: str, promise: str, want_ct: str, check):
            ar = await s.context.request.get(BASE + path)
            ct = ar.headers.get("content-type", "")
            body = await ar.text()
            detail = check(body)
            await s.goto(path, settle_ms=800)
            ok = ar.status == 200 and want_ct in ct and detail["ok"]
            await s.record(
                feature=feature, promise=promise,
                actions=[f"GET {path}", "check status, content-type and body"],
                expected=f"HTTP 200, content-type {want_ct}, {detail['expect']}",
                actual=f"HTTP {ar.status}; content-type={ct!r}; {detail['actual']}; headers={hdrs(ar.headers)}",
                status="Verified" if ok else "Failed", severity="-" if ok else "P2",
                extra={"body_head": body[:800]},
            )

        def robots_check(b):
            return {"ok": "Sitemap:" in b and "Disallow: /app/" in b and "User-agent" in b,
                    "expect": "User-agent, Disallow: /app/ + auth pages, two Sitemap lines",
                    "actual": f"lines={[l for l in b.splitlines() if l.strip()]}"}

        def sitemap_check(b):
            try:
                root = ET.fromstring(b)
                tag = root.tag.split('}')[-1]
                locs = [e.text for e in root.iter() if e.tag.endswith('loc')]
                return {"ok": tag in ("urlset", "sitemapindex") and len(locs) > 0, "expect": "well-formed <urlset>/<sitemapindex> with <loc> entries",
                        "actual": f"root=<{tag}> locs={len(locs)} first={locs[:4]}"}
            except ET.ParseError as e:
                return {"ok": False, "expect": "well-formed XML", "actual": f"XML parse error: {e}; body starts {b[:120]!r}"}

        await step(s, "robots.txt", lambda: text_file("/robots.txt", "robots.txt", "Crawlers get a robots file that hides the dashboard/auth pages and points at both sitemaps", "text/plain", robots_check))
        await step(s, "sitemap.xml", lambda: text_file("/sitemap.xml", "sitemap.xml", "The marketing sitemap is valid XML with URLs", "xml", sitemap_check))
        await step(s, "help/sitemap.xml", lambda: text_file("/help/sitemap.xml", "help/sitemap.xml", "The help-centre sitemap is valid XML listing articles", "xml", sitemap_check))

        async def p_redirect():
            ar = await s.context.request.get(f"{BASE}/p/{UNKNOWN}?utm_source=live-acceptance", max_redirects=0)
            loc = ar.headers.get("location")
            r2 = await s.goto(f"/p/{UNKNOWN}?utm_source=live-acceptance")
            final = p.url.replace(BASE, "")
            ok = ar.status == 301 and loc == f"/a/{UNKNOWN}?utm_source=live-acceptance" and final.startswith(f"/a/{UNKNOWN}")
            await s.record(
                feature="/p/<slug> permanently redirects to /a/<slug>",
                promise="Legacy /p/ links (and their query strings) 301 to the canonical /a/ path",
                actions=[f"GET /p/{UNKNOWN}?utm_source=… without following", "then open it in the browser"],
                expected=f"301 with Location /a/{UNKNOWN}?utm_source=…; browser lands on /a/…",
                actual=f"HTTP {ar.status} Location={loc!r}; browser final url={final} (HTTP {r2.status})",
                status="Verified" if ok else "Failed", severity="-" if ok else "P2",
            )
        await step(s, "/p/<slug> permanently redirects to /a/<slug>", p_redirect)

        async def tenant_404(path: str, feature: str, want_text: str, key: str):
            n, c = len(HTTP_ERRORS), len(CONSOLE)
            r = await s.goto(path)
            body = await s.text()
            state[key] = dict(r.headers)
            ok = r.status == 404 and want_text in body
            await s.record(
                feature=feature, promise="An unknown published-page URL is a clean 404, not an error screen",
                actions=[f"open {path}"], expected=f"HTTP 404 with '{want_text}'",
                actual=f"HTTP {r.status}; body={body[:120]!r}; console={console_since(c)}",
                status="Verified" if ok else "Failed", severity="-" if ok else "P2",
            )
        await step(s, "/a/<unknown>", lambda: tenant_404(f"/a/{UNKNOWN}", "/a/<unknown slug> returns 404", "Page not found", "a_headers"))
        await step(s, "/s/<ws>/<unknown>", lambda: tenant_404(f"/s/{UNKNOWN}-ws/{UNKNOWN}", "/s/<workspace>/<unknown slug> returns 404", "Page not found", "s_headers"))

        async def apply_unknown():
            n, c = len(HTTP_ERRORS), len(CONSOLE)
            r = await s.goto(f"/apply/{UNKNOWN}", settle_ms=3000)
            body = await s.text()
            state["apply_headers"] = dict(r.headers)
            msg = "This affiliate program isn't available" in body
            # Chrome always logs "Failed to load resource ... 404" for a 404 document we asked for; that is not an app error.
            real_console = [x for x in console_since(c) if "responded with a status of 404" not in x]
            ok = msg and r.status in (404, 200) and not real_console
            await s.record(
                feature="/apply/<unknown slug> — public affiliate application page",
                promise="An affiliate link for a program that doesn't exist explains itself instead of erroring",
                actions=[f"open /apply/{UNKNOWN}"],
                expected="'This affiliate program isn't available.' (ideally HTTP 404), no form, no console errors",
                actual=f"HTTP {r.status}; message shown={msg}; body={body[:120]!r}; app console errors={real_console} (Chrome's own '404 document' line excluded); server fns={[ (x['url'].split('/')[-1][:60], x['status']) for x in s._net if '_serverFn' in x['url']][:3]}",
                status="Verified" if ok else "Failed", severity="-" if ok else "P2",
                extra={"http_status_note": "404 expected from notFound() in the loader; 200 would mean the not-found is client-rendered only"},
            )
        await step(s, "/apply/<unknown slug>", apply_unknown)

        # ---------------------------------------------------------- security headers
        async def headers():
            ar = await s.context.request.get(BASE + "/")
            root = hdrs(ar.headers)
            goto_root = hdrs(state.get("landing_headers", {}))
            # /a/founders-domain-test is the domain-activation probe: it answers 200 only
            # when the Host maps to a connected tenant, so on www.founders.click a 404
            # with "tenant: not-connected" is the designed answer. Its headers are
            # still produced by the /a/ path policy, which is what we check here.
            ra = await s.goto("/a/founders-domain-test", settle_ms=1500)
            a_real = hdrs(ra.headers)
            probe_body = (await s.text())[:160]
            a_404 = hdrs(state.get("a_headers", {}))
            s_404 = hdrs(state.get("s_headers", {}))
            ap = hdrs(state.get("apply_headers", {}))
            hsts_ok = bool(re.fullmatch(r"max-age=\d+", root["strict-transport-security"] or ""))
            root_ok = hsts_ok and root["x-frame-options"] == "DENY" and root["x-content-type-options"] == "nosniff" and root["referrer-policy"] == "strict-origin-when-cross-origin"
            await s.record(
                feature="Security headers on / (platform)",
                promise="HSTS (no includeSubDomains), X-Frame-Options DENY, nosniff, Referrer-Policy on the marketing/dashboard host",
                actions=["GET / via the browser context", "read response headers (also from the earlier page load)"],
                expected="Strict-Transport-Security: max-age=N; X-Frame-Options: DENY; X-Content-Type-Options: nosniff; Referrer-Policy: strict-origin-when-cross-origin",
                actual=f"GET /: {root}; page.goto /: {goto_root}",
                status="Verified" if root_ok else "Failed", severity="-" if root_ok else "P1",
                impact="" if root_ok else "Clickjacking / downgrade protection missing on the platform host",
            )
            tenant = {"/a/founders-domain-test": a_real, "/a/<404>": a_404, "/s/<404>": s_404, "/apply/<404>": ap}
            a_ok = all(h["x-frame-options"] is None and h["x-content-type-options"] == "nosniff" and h["referrer-policy"] == "strict-origin-when-cross-origin"
                       and h["strict-transport-security"] for h in tenant.values())
            await s.record(
                feature="No X-Frame-Options on tenant paths (/a/, /s/, /apply/)",
                promise="Customers may embed their own published pages; frame lock is platform-only, nosniff/Referrer-Policy/HSTS stay",
                actions=["open /a/founders-domain-test (server route on the /a/ path)", "reuse headers captured on /a/<404>, /s/<404>, /apply/<404>"],
                expected="X-Frame-Options absent on all four tenant-path responses; nosniff + Referrer-Policy still present; HSTS present (platform hostname)",
                actual="; ".join(f"{k}: XFO={v['x-frame-options']} nosniff={v['x-content-type-options']} referrer={v['referrer-policy']} HSTS={v['strict-transport-security']}" for k, v in tenant.items())
                       + f"; domain-test probe answered HTTP {ra.status} {probe_body!r} (404 'tenant: not-connected' is by design on the platform host)",
                status="Verified" if a_ok else "Failed", severity="-" if a_ok else "P2",
                extra={"headers": tenant, "domain_test_status": ra.status, "domain_test_body": probe_body},
            )
        await step(s, "Security headers", headers)

        # ---------------------------------------------------------- seed state for the fresh-session check
        async def seed_state():
            await s.goto("/", settle_ms=800)
            info = await p.evaluate("""() => { localStorage.setItem('live-acceptance-marker', 'desktop-session'); sessionStorage.setItem('live-acceptance-marker', 'desktop-session');
                document.cookie = 'live_acceptance_marker=1; path=/; max-age=3600'; return {ls: Object.keys(localStorage), ss: Object.keys(sessionStorage), cookie: document.cookie}; }""")
            cookies = [c["name"] for c in await s.context.cookies()]
            await s.record(
                feature="Fresh-session check — seed state in profile #1",
                promise="(setup) this profile now holds a localStorage/sessionStorage/cookie marker; the next Session must not see it",
                actions=["on /, set a marker in localStorage, sessionStorage and a cookie"],
                expected="markers present in this profile; note which storage keys an anonymous visit created",
                actual=f"localStorage keys={info['ls']}; sessionStorage keys={info['ss']}; document.cookie={info['cookie']!r}; context cookies={cookies}",
                status="Verified", severity="-", persistence="to be checked by the fresh Session",
            )
        await step(s, "Fresh-session check — seed state in profile #1", seed_state)

        ALL_RECORDS.extend(s.records)


# ================================================================ FRESH SESSION
async def fresh_session() -> None:
    async with Session(f"{PHASE}/fresh-session", label="anonymous visitor (second fresh profile)") as s:
        p = s.page
        wire(p, "fresh")

        async def check():
            await s.goto("/", settle_ms=1000)
            info = await p.evaluate("() => ({ls: Object.keys(localStorage), ss: Object.keys(sessionStorage), cookie: document.cookie, marker: localStorage.getItem('live-acceptance-marker')})")
            cookies = [c["name"] for c in await s.context.cookies()]
            auth_keys = [k for k in info["ls"] if "auth-token" in k or k.startswith("sb-")]
            await p.goto(BASE + "/app", wait_until="commit")
            try:
                await p.wait_for_url(re.compile(r"/login"), timeout=20000)
                bounced = True
            except Exception:  # noqa: BLE001
                bounced = False
            ok = info["marker"] is None and "live_acceptance_marker" not in cookies and not auth_keys and bounced
            await s.record(
                feature="New Session (incognito) carries no state from the previous profile",
                promise="Each browser profile starts clean: no markers, no cookies, no auth token; /app still bounces to login",
                actions=["open / in a brand-new Session", "read localStorage/sessionStorage/cookies", "open /app"],
                expected="marker absent; no live_acceptance_marker cookie; no sb-*-auth-token; /app → /login",
                actual=f"marker={info['marker']!r}; localStorage keys={info['ls']}; sessionStorage keys={info['ss']}; cookies={cookies}; auth keys={auth_keys}; /app bounced to login={bounced} ({p.url.replace(BASE, '')})",
                status="Verified" if ok else "Failed", severity="-" if ok else "P1",
                persistence="no state carried over" if ok else "STATE LEAKED between profiles",
            )
        await step(s, "New Session carries no state", check)
        ALL_RECORDS.extend(s.records)


# ================================================================ MOBILE
async def mobile() -> None:
    async with Session(f"{PHASE}/mobile", label="anonymous visitor (mobile 390x844)", mobile=True) as s:
        p = s.page
        wire(p, "mobile")
        overflow_js = """() => { const vw = window.innerWidth; const de = document.documentElement;
            const wide = [...document.querySelectorAll('body *')].filter(el => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && cs.position !== 'absolute' && cs.position !== 'fixed' && (r.right > vw + 1 || r.left < -1); })
              .slice(0, 6).map(el => ({tag: el.tagName.toLowerCase(), cls: (typeof el.className === 'string' ? el.className : '').slice(0, 50), left: Math.round(el.getBoundingClientRect().left), right: Math.round(el.getBoundingClientRect().right)}));
            return {vw, docScrollWidth: de.scrollWidth, bodyScrollWidth: document.body.scrollWidth, overflow: de.scrollWidth > vw + 1 || document.body.scrollWidth > vw + 1, wide,
                    viewportMeta: document.querySelector('meta[name=viewport]')?.content}; }"""

        async def measure(loc):
            if await loc.count() == 0:
                return None
            bb = await loc.first.bounding_box()
            if not bb:
                return None
            txt = (await loc.first.inner_text()).strip().replace("\n", " ")[:40] if await loc.first.evaluate("e => e.tagName !== 'INPUT'") else await loc.first.get_attribute("placeholder")
            return {"text": txt, "w": round(bb["width"]), "h": round(bb["height"])}

        targets = [
            ("/", "Landing", [("link Start your free trial", lambda: p.get_by_role("link", name="Start your free trial")),
                              ("link Watch the demo", lambda: p.get_by_role("link", name="Watch the demo")),
                              ("header Start free trial", lambda: p.locator("header a[href='/signup']")),
                              ("header wordmark", lambda: p.locator("header a[href='/']"))]),
            ("/signup", "Signup", [("button Start free trial", lambda: p.get_by_role("button", name="Start free trial")),
                                    ("button Continue with Google", lambda: p.get_by_role("button", name="Continue with Google")),
                                    ("input Email", lambda: p.get_by_label("Email"))]),
            ("/login", "Login", [("button Sign in", lambda: p.get_by_role("button", name="Sign in")),
                                  ("button Continue with Google", lambda: p.get_by_role("button", name="Continue with Google")),
                                  ("link Forgot password", lambda: p.get_by_role("link", name="Forgot password?"))]),
            ("/help", "Help centre", [("search input", lambda: p.locator("input[type=search], input[name=q]")),
                                      ("link Contact support", lambda: p.locator("a[href='/help/contact']")),
                                      ("first category link", lambda: p.locator("a[href^='/help/']:not([href*='contact']):not([href*='search'])"))]),
        ]
        for path, label, ctas in targets:
            async def one(path=path, label=label, ctas=ctas):
                n, c = len(HTTP_ERRORS), len(CONSOLE)
                r = await s.goto(path, settle_ms=2000)
                ov = await p.evaluate(overflow_js)
                sizes = {}
                for name, mk in ctas:
                    try:
                        sizes[name] = await measure(mk())
                    except Exception as e:  # noqa: BLE001
                        sizes[name] = f"ERR {type(e).__name__}"
                primary_name, primary = ctas[0][0], sizes.get(ctas[0][0])
                tap_ok = isinstance(primary, dict) and primary["h"] >= 40 and primary["w"] >= 40
                small = [k for k, v in sizes.items() if isinstance(v, dict) and (v["h"] < 40 or v["w"] < 40)]
                ok = r.status == 200 and not ov["overflow"] and tap_ok and not console_since(c)
                await s.record(
                    feature=f"Mobile 390x844 — {label} ({path})",
                    promise="Page fits the phone width (no horizontal scroll) and the primary CTA is a comfortable tap target (>= 40px)",
                    actions=[f"open {path} at 390x844 (touch, mobile UA flags)", "compare scrollWidth with innerWidth", "getBoundingClientRect on the primary CTAs"],
                    expected="HTTP 200; documentElement.scrollWidth <= 390; primary CTA height and width >= 40px",
                    actual=f"HTTP {r.status}; innerWidth={ov['vw']} docScrollWidth={ov['docScrollWidth']} bodyScrollWidth={ov['bodyScrollWidth']} overflow={ov['overflow']}; "
                           f"primary '{primary_name}'={primary}; other targets={ {k: v for k, v in sizes.items() if k != primary_name} }; under-40px={small}; wide elements={ov['wide'][:3]}; console={console_since(c)}",
                    status="Verified" if ok else "Failed", severity="-" if ok else ("P2" if (ov["overflow"] or r.status != 200) else "P3"),
                    impact="" if ok else ("Phone visitors get a page that scrolls sideways" if ov["overflow"] else f"Primary CTA is {primary and primary.get('h')}px tall — under the 40px touch-target guideline (polish; it is full-width so still tappable)"),
                    repro=[] if ok else [f"open {path} at 390x844", f"getBoundingClientRect() on the '{primary_name}' control → {primary}"],
                    extra={"overflow": ov, "sizes": sizes, "viewport_meta": ov["viewportMeta"]},
                )
            await step(s, f"Mobile — {label}", one)

        async def mobile_menu():
            await s.goto("/", settle_ms=1500)
            info = await p.evaluate("""() => { const h = document.querySelector('header'); if (!h) return {header: false};
                const vis = el => !!(el.offsetParent || el.getClientRects().length);
                const btns = [...h.querySelectorAll('button')].filter(vis).map(b => ({label: b.getAttribute('aria-label') || b.textContent.trim(), expanded: b.getAttribute('aria-expanded')}));
                const links = [...h.querySelectorAll('a')].map(a => ({text: a.textContent.trim().replace(/\\s+/g,' ').slice(0,30), href: a.getAttribute('href'), visible: vis(a)}));
                return {header: true, buttons: btns, links}; }""")
            opened = None
            if info.get("header") and info["buttons"]:
                target = p.locator("header button").first
                before = [l for l in info["links"] if l["visible"]]
                await target.click()
                await p.wait_for_timeout(600)
                after = await p.evaluate("""() => [...document.querySelectorAll('header a, nav a, [role=dialog] a, [data-state=open] a')].filter(a => a.offsetParent || a.getClientRects().length).map(a => ({text: a.textContent.trim().replace(/\\s+/g,' ').slice(0,30), href: a.getAttribute('href')}))""")
                opened = {"before_visible_links": len(before), "after_visible_links": len(after), "after": after[:10]}
                menu_note = f"header buttons={info['buttons']}; clicking the first revealed {len(after) - len(before)} more links: {opened}"
            else:
                menu_note = "no menu button in the header on mobile"
            # Can a phone visitor reach Sign in from the landing page at all?
            login_vis = await p.evaluate("""() => [...document.querySelectorAll('a[href="/login"]')].filter(a => a.offsetParent || a.getClientRects().length).map(a => ({text: a.textContent.trim(), where: a.closest('header') ? 'header' : a.closest('footer') ? 'footer' : 'main'}))""")
            signup_vis = [l for l in info.get("links", []) if l["visible"] and l["href"] == "/signup"]
            hidden = [l for l in info.get("links", []) if not l["visible"]]
            ok = bool(signup_vis) and bool(login_vis)
            await s.record(
                feature="Mobile 390x844 — header navigation usable",
                promise="On a phone the header still gives access to both Start free trial and Sign in (inline or via a menu button)",
                actions=["open / at 390x844", "inspect header buttons/links", "click the menu button if present", "look for any visible link to /login on the page"],
                expected="Visible Start free trial AND a visible Sign in entry point (header, menu, or elsewhere on the page)",
                actual=f"{menu_note}; visible header links={[l for l in info.get('links', []) if l['visible']]}; hidden header links={hidden}; visible /login links anywhere on the page={login_vis}",
                status="Verified" if ok else "Failed", severity="-" if ok else "P3",
                impact="" if ok else "An existing customer on a phone has no 'Sign in' link on the landing page (the desktop header's Help + Sign in links are hidden on mobile with no menu button); they must go via /signup → 'Sign in' or type /login",
                repro=[] if ok else ["open https://www.founders.click/ at 390px width", "look for Sign in — header shows only the wordmark and 'Start free trial'"],
                extra={"header": info, "opened": opened, "login_links_visible": login_vis},
            )
        await step(s, "Mobile — header navigation", mobile_menu)
        ALL_RECORDS.extend(s.records)


# ================================================================ SLOW NETWORK
async def slow_network() -> None:
    async with Session(f"{PHASE}/slow-network", label="anonymous visitor (desktop, throttled 400 kbps / 400 ms RTT)", slow_network=True) as s:
        p = s.page
        wire(p, "slow")
        # The harness applies the CDP throttle to a throwaway page; CDP network
        # emulation is per-target, so apply the same conditions to the page we drive.
        cdp = await s.context.new_cdp_session(p)
        await cdp.send("Network.enable")
        await cdp.send("Network.emulateNetworkConditions", SLOW_NET)

        # In-flight request tracker: what is still downloading at each checkpoint.
        t_start = [0.0]
        inflight: dict[str, float] = {}
        finished: list[dict] = []

        def el() -> float:
            return round(time.perf_counter() - t_start[0], 2)

        def on_req(r):
            inflight[r.url] = time.perf_counter()

        def on_done(r, how: str):
            t0 = inflight.pop(r.url, None)
            finished.append({"url": redact(r.url).replace(BASE, ""), "type": r.resource_type, "how": how,
                             "started_s": round(t0 - t_start[0], 2) if t0 else None, "ended_s": el()})
        p.on("request", on_req)
        p.on("requestfinished", lambda r: on_done(r, "finished"))
        p.on("requestfailed", lambda r: on_done(r, f"failed:{r.failure}"))

        def in_flight_now() -> list[dict]:
            now = time.perf_counter()
            return [{"url": redact(u).replace(BASE, "")[:100], "for_s": round(now - t0, 1)} for u, t0 in inflight.items()]

        async def cdp_shot(name: str) -> str:
            # page.screenshot() waits for document.fonts — which never settles while the
            # throttled pipe is saturated — so capture straight through CDP instead.
            s._shot_n += 1
            path = s.dir / f"{s._shot_n:02d}-{re.sub(r'[^a-z0-9]+', '-', name.lower()).strip('-')}.jpg"
            try:
                data = await cdp.send("Page.captureScreenshot", {"format": "jpeg", "quality": 55})
                path.write_bytes(base64.b64decode(data["data"]))
                return str(path.relative_to(REPO))
            except Exception as e:  # noqa: BLE001
                return f"(screenshot failed: {e})"

        async def load():
            n, c = len(HTTP_ERRORS), len(CONSOLE)
            t_start[0] = time.perf_counter()
            r = await p.goto(BASE + "/", wait_until="commit", timeout=180000)
            t_commit = el()
            shots, cp = {}, {}
            while el() < 1.5:
                await p.wait_for_timeout(100)
            shots["t+1.5s"] = await cdp_shot("slow loading at 1.5s")
            cp["t+1.5s"] = await p.evaluate("() => ({ready: document.readyState, h1_in_dom: !!document.querySelector('main h1'), textLen: document.body?.innerText?.length || 0, stylesheets: document.styleSheets.length})")
            cp["t+1.5s"]["in_flight"] = in_flight_now()
            # 1) headline painted (SSR HTML + CSS)
            t_h1 = None
            while el() < 60:
                vis = await p.evaluate("() => { const h = document.querySelector('main h1'); if (!h) return false; const r = h.getBoundingClientRect(); const cs = getComputedStyle(h); return r.height > 0 && cs.visibility !== 'hidden' && cs.opacity !== '0'; }")
                if vis:
                    t_h1 = el()
                    break
                await p.wait_for_timeout(250)
            shots["headline visible"] = await cdp_shot("slow headline visible")
            cp["headline"] = {"t": t_h1, "in_flight": in_flight_now()}
            # 2) hydrated: React has attached a fiber to the FAQ button (no side effects)
            t_hyd = None
            while el() < 120:
                hyd = await p.evaluate("() => { const b = document.getElementById('faq-button-1'); return !!b && Object.keys(b).some(k => k.startsWith('__reactFiber')); }")
                if hyd:
                    t_hyd = el()
                    break
                await p.wait_for_timeout(250)
            # 3) interactive: a real click on the FAQ button changes aria-expanded
            t_inter = None
            if t_hyd is not None:
                for _ in range(20):
                    await p.evaluate("() => document.getElementById('faq-button-1')?.click()")
                    await p.wait_for_timeout(150)
                    if await p.evaluate("() => document.getElementById('faq-button-1')?.getAttribute('aria-expanded')") == "true":
                        t_inter = el()
                        await p.evaluate("() => document.getElementById('faq-button-1')?.click()")  # restore
                        break
                    await p.wait_for_timeout(350)
            shots["interactive"] = await cdp_shot("slow interactive")
            cp["interactive"] = {"t_hydrated": t_hyd, "t_click_works": t_inter, "in_flight": in_flight_now()}
            # 4) does the load event ever fire? (cap the wait at 90 s total)
            t_load = None
            while el() < 90:
                lm = await p.evaluate("() => Math.round((performance.getEntriesByType('navigation')[0] || {}).loadEventEnd || 0)")
                if lm > 0:
                    t_load = round(lm / 1000, 2)
                    break
                await p.wait_for_timeout(500)
            timing = await p.evaluate("""() => { const nav = performance.getEntriesByType('navigation')[0] || {}; const res = performance.getEntriesByType('resource');
                const by = t => res.filter(e => e.initiatorType === t).length;
                return {ttfb_ms: Math.round(nav.responseStart || 0), dcl_ms: Math.round(nav.domContentLoadedEventEnd || 0), load_ms: Math.round(nav.loadEventEnd || 0), readyState: document.readyState,
                        fonts: document.fonts.status, resources_done: res.length, scripts: by('script'), css: by('link'), img: by('img'), transfer_bytes: res.reduce((a, e) => a + (e.transferSize || 0), 0),
                        mp4_bytes_done: res.filter(e => /product-demo\\.mp4/.test(e.name)).reduce((a, e) => a + (e.transferSize || 0), 0),
                        video_readyState: document.querySelector('video')?.readyState}; }""")
            still = in_flight_now()
            shots["final"] = await cdp_shot("slow final")
            errs, cons = errs_since(n), console_since(c)
            slowest = sorted([f for f in finished if f["started_s"] is not None], key=lambda f: f["ended_s"] - f["started_s"], reverse=True)[:5]
            ok = (r.status == 200 and t_h1 is not None and t_h1 <= 10 and t_inter is not None and t_inter <= 30 and not errs and not cons)
            await s.record(
                feature="Slow network (400 kbps, 400 ms RTT) — landing page load",
                promise="On a poor connection the home page still appears progressively and becomes interactive without errors",
                actions=["throttle this page via CDP Network.emulateNetworkConditions (400 kbps down / 200 kbps up / 400 ms)", "open /", "CDP screenshot at +1.5 s",
                         "time: commit, headline painted, React hydrated (fiber attached), FAQ button responding to a click, load event (waited up to 90 s)", "list requests still in flight at each checkpoint"],
                expected="Progressive render (SSR headline within 10 s), interactive within 30 s, no failed chunks/timeouts/console errors; nothing large hogging the pipe before the page is usable",
                actual=f"HTTP {r.status}; commit={t_commit}s; headline painted={t_h1}s; DCL={timing['dcl_ms']}ms; hydrated={t_hyd}s; interactive (FAQ click works)={t_inter}s; "
                       f"load event={'%ss' % t_load if t_load else 'NOT fired within 90 s'} (readyState={timing['readyState']}, fonts={timing['fonts']}); "
                       f"at +1.5s: {cp['t+1.5s']}; still in flight at the end: {still}; resources finished={timing['resources_done']} (scripts {timing['scripts']}, css {timing['css']}, img {timing['img']}) transfer={timing['transfer_bytes']:,} bytes; "
                       f"slowest finished={[(f['url'][:50], f['type'], round(f['ended_s'] - f['started_s'], 1)) for f in slowest]}; failed/4xx={errs}; console={cons}",
                status="Verified" if ok else "Failed", severity="-" if ok else "P2",
                impact="" if ok else "Visitors on slow connections wait too long for a usable home page",
                screenshot=shots["final"],
                extra={"timing": timing, "checkpoints": cp, "screenshots": shots, "throttle": SLOW_NET, "t_commit": t_commit, "t_h1": t_h1, "t_hydrated": t_hyd, "t_interactive": t_inter, "t_load": t_load,
                       "in_flight_at_end": still, "finished_sample": finished[:40],
                       "harness_note": "Session(slow_network=True) applies the CDP throttle to a throwaway page; CDP network emulation is per-target, so this script re-applies the same conditions to the page it drives"},
            )
        await step(s, "Slow network — landing page load", load)
        ALL_RECORDS.extend(s.records)


# ================================================================ NETWORK SUMMARY
async def network_summary() -> None:
    async with Session(f"{PHASE}/network-summary", label="aggregate of all phase-11 sessions") as s:
        await s.goto("/", settle_ms=500)
        expected_pat = re.compile(rf"/({UNKNOWN}|a/{UNKNOWN}|s/{UNKNOWN}|apply/{UNKNOWN}|p/{UNKNOWN}|a/founders-domain-test)|/auth/v1/token|/auth/v1/signup|live-acceptance-range-probe", re.I)
        expected = [e for e in HTTP_ERRORS if expected_pat.search(e["url"])]
        unexpected = [e for e in HTTP_ERRORS if not expected_pat.search(e["url"])]
        await s.record(
            feature="4xx/5xx and failed requests seen across all phase-11 sessions",
            promise="Nothing on the public journeys errors except the responses we deliberately provoked",
            actions=["aggregate every response >= 400 and every failed request from desktop, fresh, mobile and slow-network sessions"],
            expected="Only the deliberate 404s (unknown routes/slugs, the domain-test probe on the platform host) and the deliberate 400 from the wrong-password login",
            actual=f"total={len(HTTP_ERRORS)}; deliberate={len(expected)} {[(e['status'], e['url'].replace(BASE, '')) for e in expected]}; UNEXPECTED={len(unexpected)} {[(e['session'], e['status'], e['url'][:120], e.get('error')) for e in unexpected]}",
            status="Verified" if not unexpected else "Failed", severity="-" if not unexpected else "P2",
            extra={"all": HTTP_ERRORS, "console_all": CONSOLE},
        )
        ALL_RECORDS.extend(s.records)


async def main() -> None:
    if PHASE_DIR.exists():
        shutil.rmtree(PHASE_DIR)
    PHASE_DIR.mkdir(parents=True)
    t0 = time.time()
    await desktop()
    await fresh_session()
    await mobile()
    await slow_network()
    await network_summary()
    (PHASE_DIR / "records.json").write_text(json.dumps(ALL_RECORDS, indent=2))
    (PHASE_DIR / "http-errors.json").write_text(json.dumps({"http_errors": HTTP_ERRORS, "console": CONSOLE}, indent=2))
    counts: dict[str, int] = {}
    for r in ALL_RECORDS:
        counts[r["status"]] = counts.get(r["status"], 0) + 1
    print(f"\n{len(ALL_RECORDS)} records in {round(time.time() - t0)}s: {counts}")
    print(f"merged → {PHASE_DIR / 'records.json'}")


asyncio.run(main())

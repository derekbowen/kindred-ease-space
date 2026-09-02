"""
Unauthenticated customer journeys against a deployed site, recorded as
evidence rather than asserted: marketing pages + metadata, legal pages,
help centre, signup/login validation and error states, password-reset
request, session-less access to the app, 404 handling, robots/sitemap,
keyboard reachability of the login form, and mobile layout.

Run:  python3 tests/e2e/public-journeys.py [BASE_URL]
Output: /tmp/browser/public/results.json + screenshots.

Sends at most ONE email (a password-reset request for RESET_EMAIL, if set)
so a real inbox can confirm transactional delivery. Never creates accounts.
"""
import asyncio
import json
import os
import re
import sys
from pathlib import Path
from playwright.async_api import async_playwright, TimeoutError as PWTimeout

BASE = (sys.argv[1] if len(sys.argv) > 1 else "https://www.founders.click").rstrip("/")
OUT = Path("/tmp/browser/public")
OUT.mkdir(parents=True, exist_ok=True)
RESET_EMAIL = os.environ.get("RESET_EMAIL")
EXISTING_EMAIL = os.environ.get("EXISTING_EMAIL")  # for duplicate-signup wording check

R: list[dict] = []


def rec(name, **kw):
    kw["name"] = name
    R.append(kw)
    flag = kw.get("verdict", "")
    print(f"- {name}: {flag} {kw.get('note','')}"[:220])


async def text_of(page, sel="body"):
    try:
        return re.sub(r"\s+", " ", await page.locator(sel).first.inner_text(timeout=4000)).strip()
    except Exception:
        return ""


async def meta(page):
    return await page.evaluate(
        """() => {
      const q = (s) => document.querySelector(s);
      const c = (s) => (q(s) ? q(s).getAttribute('content') : null);
      return {
        title: document.title,
        description: c('meta[name="description"]'),
        og_title: c('meta[property="og:title"]'),
        og_description: c('meta[property="og:description"]'),
        og_image: c('meta[property="og:image"]'),
        twitter_card: c('meta[name="twitter:card"]'),
        canonical: q('link[rel="canonical"]') ? q('link[rel="canonical"]').href : null,
        robots: c('meta[name="robots"]'),
        h1: Array.from(document.querySelectorAll('h1')).map(h => h.innerText.trim()).slice(0,3),
        lang: document.documentElement.lang || null,
        imgs_without_alt: Array.from(document.images).filter(i => !i.hasAttribute('alt')).length,
        scripts_external: Array.from(document.scripts).map(s => s.src).filter(s => s && !s.startsWith(location.origin)),
      };
    }"""
    )


async def run():
    async with async_playwright() as pw:
        proxy_url = os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy")
        kw = {"headless": True}
        if proxy_url:
            kw["proxy"] = {"server": proxy_url}
            kw["args"] = ["--disable-features=EncryptedClientHello,PostQuantumKyber", "--ssl-version-max=tls1.2"]
        exe = os.environ.get("SMOKE_CHROMIUM_PATH")
        if exe:
            kw["executable_path"] = exe
        browser = await pw.chromium.launch(**kw)
        ctx = await browser.new_context(viewport={"width": 1366, "height": 1400}, ignore_https_errors=bool(proxy_url))
        page = await ctx.new_page()
        cerr: list[str] = []
        page.on("console", lambda m: cerr.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: cerr.append(f"pageerror: {e}"))

        async def visit(name, path, shot=True):
            cerr.clear()
            resp = await page.goto(f"{BASE}{path}", wait_until="domcontentloaded", timeout=30000)
            await page.wait_for_timeout(1500)
            m = await meta(page)
            body = await text_of(page)
            if shot:
                await page.screenshot(path=str(OUT / f"{name}.png"))
            return resp.status if resp else None, m, body, list(cerr)

        # ---- Marketing + metadata --------------------------------------
        for name, path in [("landing", "/"), ("privacy", "/privacy"), ("terms", "/terms"),
                           ("help", "/help"), ("help-contact", "/help/contact"),
                           ("login", "/login"), ("signup", "/signup"), ("reset", "/reset-password")]:
            st, m, body, errs = await visit(name, path)
            placeholder = bool(re.search(r"lorem|placeholder|coming soon|\[insert|TBD", body, re.I))
            rec(f"page {path}", status=st, meta=m, words=len(body.split()), placeholder_text=placeholder,
                console_errors=errs[:5], verdict="ok" if st == 200 else f"HTTP {st}",
                note=f"title={m['title']!r} h1={m['h1']} words={len(body.split())} og_image={'yes' if m['og_image'] else 'NO'} canonical={'yes' if m['canonical'] else 'NO'}")

        # Landing CTAs + footer links
        links = await page.goto(f"{BASE}/", wait_until="domcontentloaded")
        hrefs = await page.evaluate("() => Array.from(document.querySelectorAll('a[href]')).map(a => a.getAttribute('href'))")
        rec("landing links", hrefs=sorted(set(h for h in hrefs if h)), verdict="ok",
            note=f"{len(set(hrefs))} unique; has /signup={'/signup' in hrefs} /login={'/login' in hrefs} /privacy={'/privacy' in hrefs} /terms={'/terms' in hrefs} pricing-anchor={any('pric' in (h or '') for h in hrefs)}")
        # Every internal link on the landing page must resolve
        broken = []
        for h in sorted(set(h for h in hrefs if h and h.startswith("/") and not h.startswith("//"))):
            r = await page.request.get(f"{BASE}{h.split('#')[0]}")
            if r.status >= 400:
                broken.append((h, r.status))
        rec("landing internal links resolve", broken=broken, verdict="ok" if not broken else "BROKEN", note=str(broken))

        # ---- robots / sitemap / 404 ------------------------------------
        for name, path in [("robots", "/robots.txt"), ("sitemap", "/sitemap.xml"), ("help-sitemap", "/help/sitemap.xml")]:
            r = await page.request.get(f"{BASE}{path}")
            body = await r.text()
            rec(f"file {path}", status=r.status, content_type=r.headers.get("content-type"), head=body[:300],
                verdict="ok" if r.status == 200 else f"HTTP {r.status}", note=f"{r.status} {r.headers.get('content-type')} {len(body)}B")
        st, m, body, errs = await visit("404", "/this-route-does-not-exist-9f3a")
        rec("404 page", status=st, verdict="ok" if st == 404 else f"HTTP {st} (should be 404)",
            note=f"status={st} title={m['title']!r} text={body[:120]!r}")
        # Security headers on the document
        r = await page.request.get(f"{BASE}/")
        hdrs = {k: v for k, v in r.headers.items() if k.lower() in ("strict-transport-security", "content-security-policy", "x-frame-options", "x-content-type-options", "referrer-policy", "permissions-policy", "cache-control")}
        rec("security headers on /", headers=hdrs, verdict="ok", note=str(hdrs))

        # ---- Session-less access to the app ----------------------------
        for path in ["/app", "/app/billing", "/app/settings"]:
            resp = await page.goto(f"{BASE}{path}", wait_until="domcontentloaded")
            await page.wait_for_timeout(1500)
            rec(f"unauthenticated {path}", status=resp.status if resp else None, final_url=page.url,
                verdict="ok" if "/login" in page.url else "NOT REDIRECTED", note=f"-> {page.url}")

        # ---- Signup validation states ----------------------------------
        await page.goto(f"{BASE}/signup", wait_until="domcontentloaded")
        await page.wait_for_timeout(1000)
        await page.get_by_role("button", name="Start free trial").click()
        invalid = await page.evaluate("() => Array.from(document.querySelectorAll('input:invalid')).map(i => i.id || i.name)")
        rec("signup empty submit", invalid_fields=invalid, verdict="ok" if invalid else "NO VALIDATION", note=f"native-invalid={invalid}")
        await page.get_by_label("Your name").fill("Audit")
        await page.get_by_label("Email").fill("not-an-email")
        await page.get_by_label("Password").fill("x")
        await page.get_by_role("button", name="Start free trial").click()
        await page.wait_for_timeout(800)
        invalid = await page.evaluate("() => Array.from(document.querySelectorAll('input:invalid')).map(i => i.id || i.name)")
        rec("signup bad email", invalid_fields=invalid, verdict="ok" if "email" in " ".join(invalid) else "ACCEPTED BAD EMAIL", note=f"native-invalid={invalid}")
        await page.get_by_label("Email").fill("audit-weak@example.com")
        await page.get_by_role("button", name="Start free trial").click()
        await page.wait_for_timeout(2500)
        body = await text_of(page)
        weak_msg = re.search(r"(password[^.]{0,80})", body, re.I)
        await page.screenshot(path=str(OUT / "signup-weak-password.png"))
        rec("signup weak password (1 char)", url=page.url, message=weak_msg.group(1) if weak_msg else None,
            verdict="ok" if weak_msg and "/signup" in page.url else "UNCLEAR", note=f"url={page.url} msg={weak_msg.group(1) if weak_msg else None!r}")
        if EXISTING_EMAIL:
            await page.goto(f"{BASE}/signup", wait_until="domcontentloaded")
            await page.wait_for_timeout(1000)
            await page.get_by_label("Your name").fill("Audit")
            await page.get_by_label("Email").fill(EXISTING_EMAIL)
            await page.get_by_label("Password").fill("SomethingLong!12345")
            await page.get_by_role("button", name="Start free trial").click()
            await page.wait_for_timeout(3500)
            body = await text_of(page)
            await page.screenshot(path=str(OUT / "signup-existing-email.png"))
            leak = bool(re.search(r"already|exists|registered", body, re.I))
            rec("signup with existing email", url=page.url, enumerates_account=leak, text=body[:300],
                verdict="ok", note=f"url={page.url} says-already-registered={leak}")

        # ---- Login error states ----------------------------------------
        await page.goto(f"{BASE}/login", wait_until="domcontentloaded")
        await page.wait_for_timeout(1000)
        await page.get_by_label("Email").fill("nobody-9f3a@example.com")
        await page.get_by_label("Password").fill("wrong-password-123")
        await page.get_by_role("button", name="Sign in").click()
        try:
            await page.locator("[role=alert]").first.wait_for(state="visible", timeout=8000)
            msg = (await page.locator("[role=alert]").first.inner_text()).strip()
        except PWTimeout:
            msg = None
        await page.screenshot(path=str(OUT / "login-wrong.png"))
        rec("login wrong credentials", message=msg, verdict="ok" if msg else "NO ERROR SHOWN", note=f"msg={msg!r}")

        # Keyboard: Tab order reaches the submit button
        await page.goto(f"{BASE}/login", wait_until="domcontentloaded")
        await page.wait_for_timeout(800)
        order = []
        for _ in range(8):
            await page.keyboard.press("Tab")
            order.append(await page.evaluate("() => { const e = document.activeElement; return (e.tagName + ':' + (e.id || e.innerText || e.getAttribute('aria-label') || '')).slice(0,40); }"))
        rec("login keyboard tab order", order=order, verdict="ok" if any("Sign in" in o for o in order) else "SUBMIT NOT REACHABLE", note=str(order))

        # ---- Password reset request (sends ONE real email if RESET_EMAIL) --
        await page.goto(f"{BASE}/reset-password", wait_until="domcontentloaded")
        await page.wait_for_timeout(1000)
        body = await text_of(page)
        rec("reset-password page", text=body[:300], verdict="ok" if "email" in body.lower() else "UNCLEAR", note=body[:120])
        if RESET_EMAIL:
            try:
                await page.get_by_label("Email").fill(RESET_EMAIL)
                await page.get_by_role("button").filter(has_text=re.compile("reset|send|email", re.I)).first.click()
                await page.wait_for_timeout(4000)
                body = await text_of(page)
                await page.screenshot(path=str(OUT / "reset-submitted.png"))
                rec("reset-password submitted", text=body[:400], toasts=[t for t in [await text_of(page, "[data-sonner-toast]")] if t],
                    verdict="ok", note=body[:200])
            except Exception as e:
                rec("reset-password submitted", verdict="FAILED", note=f"{type(e).__name__}: {e}"[:200])

        # ---- Mobile layout ---------------------------------------------
        mctx = await browser.new_context(viewport={"width": 375, "height": 812}, ignore_https_errors=bool(proxy_url), is_mobile=True, has_touch=True)
        mp = await mctx.new_page()
        for name, path in [("m-landing", "/"), ("m-signup", "/signup"), ("m-login", "/login")]:
            await mp.goto(f"{BASE}{path}", wait_until="domcontentloaded")
            await mp.wait_for_timeout(1200)
            overflow = await mp.evaluate("() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2")
            await mp.screenshot(path=str(OUT / f"{name}.png"), full_page=True)
            rec(f"mobile {path}", horizontal_overflow=overflow, verdict="HORIZONTAL SCROLL" if overflow else "ok", note=f"overflow={overflow}")
        await mctx.close()

        (OUT / "results.json").write_text(json.dumps(R, indent=2))
        print(f"\nWrote {OUT/'results.json'}")
        await browser.close()


asyncio.run(run())

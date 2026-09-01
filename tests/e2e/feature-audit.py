"""
Authenticated per-feature audit: sign in with a real account and visit every
customer-visible nav route, recording what each one actually shows.

Run:  SUPABASE_TEST_EMAIL=... SUPABASE_TEST_PASSWORD=... \
      python3 tests/e2e/feature-audit.py [BASE_URL]

Output: /tmp/browser/audit/results.json (one record per route: status code,
final URL, error-marker flags, visible-text snippet, console errors) plus a
screenshot per route. The script records evidence; classification of
worked / empty-state / errored happens by reading the evidence, not by the
script guessing.

The password is read from env and never printed.
"""
import asyncio
import json
import os
import re
import sys
from pathlib import Path
from playwright.async_api import async_playwright, TimeoutError as PWTimeout

BASE_URL = (sys.argv[1] if len(sys.argv) > 1 else "https://www.founders.click").rstrip("/")
OUT = Path("/tmp/browser/audit")
OUT.mkdir(parents=True, exist_ok=True)

EMAIL = os.environ.get("SUPABASE_TEST_EMAIL")
PASSWORD = os.environ.get("SUPABASE_TEST_PASSWORD")
if not (EMAIL and PASSWORD):
    print("Set SUPABASE_TEST_EMAIL and SUPABASE_TEST_PASSWORD")
    sys.exit(2)

# Every non-stub, non-internalOnly item from src/lib/app-nav.ts, in nav order.
ROUTES = [
    ("Overview", "Dashboard", "/app"),
    ("Overview", "Coach", "/app/coach"),
    ("Overview", "SEO Coach", "/app/seo-coach"),
    ("Content", "Pages", "/app/pages"),
    ("Content", "Quick Page Builder", "/app/content/quick-page-builder"),
    ("Content", "Generate Content", "/app/content/generate"),
    ("Content", "Bulk Page Editor", "/app/content/bulk-editor"),
    ("Content", "Data Export", "/app/content/data-export"),
    ("Content", "Data Import", "/app/content/data-import"),
    ("SEO", "Rank Tracker", "/app/seo/rank-tracker"),
    ("SEO", "AI Page Auditor", "/app/seo/page-auditor"),
    ("SEO", "Keyword Opportunities", "/app/seo/keyword-opportunities"),
    ("SEO", "Competitor Tracker", "/app/seo/competitor-tracker"),
    ("SEO", "Internal Link Recommender", "/app/seo/internal-links"),
    ("SEO", "Link Checker", "/app/seo/link-checker"),
    ("SEO", "Missing Pages (404s)", "/app/seo/missing-pages"),
    ("SEO", "GSC Import", "/app/seo/gsc-import"),
    ("Affiliates", "Affiliate Dashboard", "/app/affiliates"),
    ("Affiliates", "Programs", "/app/affiliates/programs"),
    ("Affiliates", "Affiliates", "/app/affiliates/directory"),
    ("Affiliates", "Payouts", "/app/affiliates/payouts"),
    ("Affiliates", "Customise", "/app/affiliates/customise"),
    ("Affiliates", "Affiliate Settings", "/app/affiliates/settings"),
    ("Account", "Add-ons", "/app/addons"),
    ("Account", "Billing & Plans", "/app/billing"),
    ("Account", "Workspace Settings", "/app/settings"),
    ("Account", "AI Providers", "/app/settings/ai"),
    ("Account", "API Keys", "/app/settings/api-keys"),
    ("Account", "Sharetribe", "/app/settings/integrations/sharetribe"),
]

ERROR_MARKERS = [
    "Page not found",
    "didn't load",
    "Something went wrong",
    "Forbidden",
    "Internal Server Error",
]


def slug(label: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", label.lower()).strip("-")


async def page_text(page) -> str:
    # Prefer the main content area; fall back to body.
    for sel in ("main", "body"):
        loc = page.locator(sel)
        if await loc.count() > 0:
            try:
                txt = await loc.first.inner_text(timeout=5_000)
                return re.sub(r"\s+", " ", txt).strip()
            except Exception:
                continue
    return ""


async def toasts(page) -> list[str]:
    out = []
    for el in await page.locator("[data-sonner-toast]").all():
        try:
            out.append(re.sub(r"\s+", " ", await el.inner_text()).strip())
        except Exception:
            pass
    return out


async def run():
    async with async_playwright() as pw:
        proxy_url = os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy")
        launch_kwargs = {"headless": True}
        if proxy_url:
            launch_kwargs["proxy"] = {"server": proxy_url}
            launch_kwargs["args"] = [
                "--disable-features=EncryptedClientHello,PostQuantumKyber",
                "--ssl-version-max=tls1.2",
            ]
        exe = os.environ.get("SMOKE_CHROMIUM_PATH")
        if exe:
            launch_kwargs["executable_path"] = exe
        browser = await pw.chromium.launch(**launch_kwargs)
        context = await browser.new_context(
            viewport={"width": 1440, "height": 2000},
            ignore_https_errors=bool(proxy_url),
        )
        page = await context.new_page()

        console_errors: list[str] = []
        page.on(
            "console",
            lambda m: console_errors.append(m.text) if m.type == "error" else None,
        )
        page.on("pageerror", lambda e: console_errors.append(f"pageerror: {e}"))

        # ---- Login -------------------------------------------------------
        await page.goto(f"{BASE_URL}/login", wait_until="domcontentloaded")
        await page.get_by_label("Email").wait_for(state="visible", timeout=15_000)
        await page.wait_for_timeout(800)  # hydration
        await page.get_by_label("Email").fill(EMAIL)
        await page.get_by_label("Password").fill(PASSWORD)
        await page.get_by_role("button", name="Sign in").click()
        try:
            await page.wait_for_url("**/app**", timeout=15_000)
        except PWTimeout:
            alert = page.locator("[role=alert]")
            msg = ""
            if await alert.count() > 0:
                msg = (await alert.first.inner_text()).strip()
            msg = msg or "; ".join(await toasts(page)) or "no visible error message"
            await page.screenshot(path=str(OUT / "login_failed.png"))
            print(f"LOGIN FAILED for {EMAIL}: {msg}")
            await browser.close()
            sys.exit(1)
        print(f"LOGIN OK for {EMAIL}")

        results = []

        # ---- Walk every route -------------------------------------------
        for section, label, path in ROUTES:
            rec = {
                "section": section,
                "label": label,
                "path": path,
                "status": None,
                "final_url": None,
                "error_markers": [],
                "toasts": [],
                "console_errors": [],
                "text": "",
            }
            console_errors.clear()
            try:
                resp = await page.goto(
                    f"{BASE_URL}{path}", wait_until="domcontentloaded", timeout=30_000
                )
                rec["status"] = resp.status if resp else None
                # Let queries settle; bounded — no networkidle (polling pages
                # never go idle).
                await page.wait_for_timeout(3_500)
                rec["final_url"] = page.url
                txt = await page_text(page)
                rec["text"] = txt[:900]
                rec["error_markers"] = [m for m in ERROR_MARKERS if m in txt]
                rec["toasts"] = await toasts(page)
                rec["console_errors"] = [e[:300] for e in console_errors[:8]]
                await page.screenshot(path=str(OUT / f"{slug(label)}.png"), full_page=False)
            except Exception as e:
                rec["error_markers"].append(f"navigation failed: {type(e).__name__}: {e}")
                try:
                    await page.screenshot(path=str(OUT / f"{slug(label)}_fail.png"))
                except Exception:
                    pass
            results.append(rec)
            flags = "; ".join(rec["error_markers"]) or "ok"
            print(f"[{rec['status']}] {section} / {label}  ->  {flags}")

        # ---- Coach interaction: settles the platform-AI gate -------------
        coach = {"label": "Coach interaction", "outcome": None, "detail": ""}
        try:
            await page.goto(f"{BASE_URL}/app/coach", wait_until="domcontentloaded")
            box = page.get_by_placeholder("Ask the coach…")
            await box.wait_for(state="visible", timeout=15_000)
            await box.fill("In one sentence: what should I do first in this workspace?")
            await page.get_by_role("button", name="Send").click()
            # Wait for either an error box or a non-trivial assistant reply.
            deadline = asyncio.get_event_loop().time() + 60
            outcome = "timeout"
            detail = ""
            while asyncio.get_event_loop().time() < deadline:
                err = page.locator(".text-destructive.break-words, .bg-destructive\\/10")
                if await err.count() > 0:
                    detail = (await err.first.inner_text()).strip()
                    if detail:
                        outcome = "error"
                        break
                txt = await page_text(page)
                # Our question echoes back as the user message; a reply makes
                # the transcript meaningfully longer than question + chrome.
                if "what should I do first" in txt and len(txt) > 700:
                    outcome = "replied"
                    detail = txt[-500:]
                    break
                await page.wait_for_timeout(2_000)
            coach["outcome"] = outcome
            coach["detail"] = detail[:600]
            await page.screenshot(path=str(OUT / "coach-interaction.png"))
        except Exception as e:
            coach["outcome"] = "exception"
            coach["detail"] = f"{type(e).__name__}: {e}"[:300]
        results.append(coach)
        print(f"Coach interaction: {coach['outcome']}")

        (OUT / "results.json").write_text(json.dumps(results, indent=2))
        print(f"\nWrote {OUT / 'results.json'} and {len(list(OUT.glob('*.png')))} screenshots")
        await browser.close()


asyncio.run(run())

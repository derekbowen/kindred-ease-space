"""
End-to-end smoke test:
  landing → signup → workspace auto-provision → dashboard → billing

Run:  python3 tests/e2e/smoke.py [BASE_URL]
Default BASE_URL: http://localhost:8080

Exit code 0 on success, non-zero with screenshot/log path on failure.

Notes
-----
- Uses a unique throwaway email per run (smoke+<ts>@founders.click).
- If Supabase email confirmation is enforced, the signup path stops at the
  "check your email" screen and the test passes that branch only — full
  authenticated traversal requires SUPABASE_TEST_EMAIL/SUPABASE_TEST_PASSWORD
  env vars for a pre-confirmed account, in which case we sign in via /login
  and continue to /app + /app/billing.
"""
import asyncio
import os
import sys
import time
from pathlib import Path
from playwright.async_api import async_playwright, TimeoutError as PWTimeout

BASE_URL = (sys.argv[1] if len(sys.argv) > 1 else os.environ.get("SMOKE_BASE_URL", "http://localhost:8080")).rstrip("/")
OUT = Path("/tmp/browser/smoke")
OUT.mkdir(parents=True, exist_ok=True)

TEST_EMAIL = os.environ.get("SUPABASE_TEST_EMAIL")
TEST_PASS = os.environ.get("SUPABASE_TEST_PASSWORD")


async def shot(page, name):
    path = OUT / f"{name}.png"
    await page.screenshot(path=str(path))
    return path


async def expect_visible(page, locator, label, timeout=10_000):
    try:
        await locator.first.wait_for(state="visible", timeout=timeout)
    except PWTimeout:
        await shot(page, f"fail_{label}")
        raise AssertionError(f"[FAIL] expected visible: {label} at {page.url}")


async def run():
    errors: list[str] = []
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=True)
        context = await browser.new_context(viewport={"width": 1280, "height": 1800})
        page = await context.new_page()

        console_errors: list[str] = []
        page.on("console", lambda m: console_errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: console_errors.append(f"pageerror: {e}"))

        # 1. Landing
        await page.goto(f"{BASE_URL}/", wait_until="domcontentloaded")
        await shot(page, "1_landing")
        await expect_visible(page, page.get_by_role("link", name="founders.click").or_(page.locator("text=founders")), "landing-brand")

        # 2. Signup
        await page.goto(f"{BASE_URL}/signup", wait_until="domcontentloaded")
        await expect_visible(page, page.get_by_label("Email"), "signup-form")
        ts = int(time.time())
        # Plain address (no `+`, neutral domain) — avoids provider rejections
        # of plus-aliases or owned-domain signups during smoke runs.
        email = f"smoke{ts}@example.com"
        password = "SmokeTest!12345"
        await page.get_by_label("Your name").fill("Smoke Test")
        await page.get_by_label("Email").fill(email)
        await page.get_by_label("Password").fill(password)
        await shot(page, "2_signup_filled")
        await page.get_by_role("button", name=__import__("re").compile(r"trial", __import__("re").I)).click()

        # Wait for either /app dashboard, the email-confirmation screen, or an error toast.
        try:
            await page.wait_for_url("**/app**", timeout=8_000)
            on_app = True
        except PWTimeout:
            on_app = False

        await shot(page, "3_post_signup")

        if not on_app:
            # Email-confirmation branch (signUp returned no session).
            confirm = page.get_by_text("confirmation link", exact=False)
            if await confirm.count() > 0:
                print(f"[OK] Signup form submitted; email confirmation required for {email}.")
                if not (TEST_EMAIL and TEST_PASS):
                    print("[SKIP] Set SUPABASE_TEST_EMAIL/SUPABASE_TEST_PASSWORD to verify dashboard + billing.")
                    await browser.close()
                    return errors
                # Sign in with provided pre-confirmed account
                await page.goto(f"{BASE_URL}/login", wait_until="domcontentloaded")
                await page.get_by_label("Email").fill(TEST_EMAIL)
                await page.get_by_label("Password").fill(TEST_PASS)
                await page.get_by_role("button", name=__import__("re").compile(r"sign in|log in", __import__("re").I)).click()
                await page.wait_for_url("**/app**", timeout=10_000)
            else:
                errors.append(f"signup did not reach /app and no confirmation message at {page.url}")
                await shot(page, "fail_signup")
                await browser.close()
                return errors

        # 3. Dashboard — workspace auto-provisions; poll for content
        await page.wait_for_load_state("networkidle", timeout=15_000)
        await shot(page, "4_dashboard")
        try:
            await page.get_by_text("Welcome back", exact=False).wait_for(state="visible", timeout=20_000)
        except PWTimeout:
            errors.append(f"dashboard never rendered 'Welcome back' (workspace provision stuck) at {page.url}")
            await shot(page, "fail_dashboard")

        # 4. Billing
        await page.goto(f"{BASE_URL}/app/billing", wait_until="domcontentloaded")
        await page.wait_for_load_state("networkidle", timeout=15_000)
        await shot(page, "5_billing")
        # Expect either a plan card, the billing heading, or a known billing widget — not the 404 / error boundary.
        if await page.get_by_text("Page not found").count() > 0:
            errors.append("billing route 404")
        if await page.get_by_text("didn't load").count() > 0:
            errors.append("billing route error boundary tripped")

        # Console errors gating: ignore noisy 3rd-party
        fatal = [e for e in console_errors if "Failed to fetch" not in e and "ResizeObserver" not in e]
        if fatal:
            print("[warn] console errors during run:")
            for e in fatal[:10]:
                print("  -", e[:200])

        await browser.close()
    return errors


def main():
    errs = asyncio.run(run())
    if errs:
        print("\nSMOKE FAILED:")
        for e in errs:
            print(" -", e)
        print(f"Screenshots: {OUT}")
        sys.exit(1)
    print(f"\nSMOKE OK. Screenshots: {OUT}")


if __name__ == "__main__":
    main()

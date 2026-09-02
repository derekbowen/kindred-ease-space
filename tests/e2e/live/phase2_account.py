"""
Phase 2 — authentication and account lifecycle, through the public UI only.

Subcommands (run in order; the confirmation and reset emails are read from
the real inbox between steps by the operator):

  signup  <key> <email> <password>      create the account via /signup
  confirm <key> <link>                  open the confirmation link from the email
  login   <key>                         sign in, land on the dashboard, sign out, sign in again
  reset-request <key>                   request a password reset for the account's email
  reset-complete <key> <link> <newpw>   open the reset link, set a new password
  old-password <key> <oldpw>            prove the old password is now refused
  session <key>                         unauthenticated redirects, logout invalidation

Each step appends to docs/evidence/live-acceptance-2026-09-02/phase2-account/records.json.
"""
import asyncio
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from harness import Session, load_accounts, save_account, BASE  # noqa: E402

PHASE = "phase2-account"


async def signup(key: str, email: str, password: str):
    async with Session(PHASE, label=f"new visitor → account {key}") as s:
        await s.goto("/signup", settle_ms=1500)
        await s.page.get_by_label("Your name").fill(f"Live Test {key}")
        await s.page.get_by_label("Email").fill(email)
        await s.page.get_by_label("Password").fill(password)
        terms = await s.text("form")
        await s.page.get_by_role("button", name="Start free trial").click()
        await s.page.wait_for_timeout(5000)
        body = await s.text()
        toasts = await s.toasts()
        reached_confirm = "confirmation" in body.lower() or any("check your email" in t.lower() for t in toasts)
        on_app = "/app" in s.page.url
        save_account(key, email, password, created_at=__import__("datetime").datetime.utcnow().isoformat())
        await s.record(
            feature="Sign up with a new email",
            promise="Create a founders.click workspace and start a 14-day free trial (signup page)",
            actions=["open /signup", "fill name/email/password", "click Start free trial"],
            expected="Account created; told to check email for a confirmation link (or land on /app)",
            actual=("reached 'check your email' screen" if reached_confirm else ("landed on /app" if on_app else f"unexpected: {body[:200]}")) + f"; toasts={toasts}",
            status="Verified" if (reached_confirm or on_app) else "Failed",
            severity="-" if (reached_confirm or on_app) else "P0",
            impact="" if (reached_confirm or on_app) else "Customers cannot create accounts",
            extra={"terms_link_present": "Terms of Service" in terms and "Privacy Policy" in terms},
        )


async def confirm(key: str, link: str):
    async with Session(PHASE, label=f"account {key} (fresh profile, from email link)") as s:
        resp = await s.goto(link, settle_ms=4000)
        url = s.page.url
        body = await s.text()
        landed_app = "/app" in url
        err = re.search(r"(expired|invalid|error)[^.]{0,120}", body, re.I)
        await s.record(
            feature="Open the confirmation link from the real email",
            promise="Clicking the emailed link confirms the account and signs the customer in",
            actions=["open the verify URL copied from the inbox message"],
            expected="Redirect into the app (or a confirmed state that then allows login)",
            actual=f"final url={url}; http={resp.status if resp else '?'}; {'app shell visible' if landed_app else body[:200]}",
            status="Verified" if landed_app and not err else "Failed",
            severity="-" if landed_app else "P0",
            persistence="see login step",
        )


async def login(key: str):
    async with Session(PHASE, account=key) as s:
        r = await s.login(expect_ok=False)
        body = await s.text()
        welcome = "Welcome back" in body or "Dashboard" in body
        await s.record(
            feature="Log in with the confirmed account",
            promise="Sign in and reach the workspace dashboard",
            actions=["open /login", "enter email + password", "click Sign in"],
            expected="Land on /app with the dashboard rendered",
            actual=f"ok={r['ok']} url={r['url']} msg={r['message']!r} dashboard_text={'yes' if welcome else 'no'}",
            status="Verified" if r["ok"] and welcome else "Failed",
            severity="-" if r["ok"] else "P0",
        )
        if not r["ok"]:
            return
        # Log out
        await s.logout()
        await s.page.wait_for_timeout(1500)
        await s.goto("/app/billing", settle_ms=5000)
        bounced = "/login" in s.page.url
        await s.record(
            feature="Log out",
            promise="Signing out ends the session; protected pages bounce to login",
            actions=["click Sign out in the dashboard", "open /app/billing directly"],
            expected="Redirect to /login?next=/app/billing",
            actual=f"after logout, /app/billing → {s.page.url}",
            status="Verified" if bounced else "Failed",
            severity="-" if bounced else "P1",
            persistence="session cleared" if bounced else "session persisted after logout",
        )
        r2 = await s.login(expect_ok=False)
        await s.record(
            feature="Log in again after logout",
            promise="Credentials keep working across sessions",
            actions=["open /login", "sign in again"],
            expected="Dashboard again",
            actual=f"ok={r2['ok']} url={r2['url']}",
            status="Verified" if r2["ok"] else "Failed",
            severity="-" if r2["ok"] else "P0",
            persistence="new login reached dashboard" if r2["ok"] else "-",
        )


async def reset_request(key: str):
    acct = load_accounts()[key]
    async with Session(PHASE, label=f"account {key} (logged out)") as s:
        await s.goto("/reset-password", settle_ms=1200)
        await s.page.get_by_label("Email").fill(acct["email"])
        await s.page.get_by_role("button", name=re.compile("send reset", re.I)).click()
        await s.page.wait_for_timeout(4000)
        body = await s.text()
        toasts = await s.toasts()
        ok = "check your email" in body.lower() or any("email" in t.lower() for t in toasts)
        await s.record(
            feature="Request a password reset",
            promise="We'll email you a reset link",
            actions=["open /reset-password", "enter the account email", "click Send reset link"],
            expected="Confirmation that an email was sent; the email arrives in the inbox",
            actual=f"ui: {body[:160]} toasts={toasts} (inbox receipt recorded separately)",
            status="Verified" if ok else "Failed",
            severity="-" if ok else "P1",
        )


async def reset_complete(key: str, link: str, newpw: str):
    acct = load_accounts()[key]
    async with Session(PHASE, label=f"account {key} (fresh profile, from reset email)") as s:
        await s.goto(link, settle_ms=4000)
        body = await s.text()
        # The page is dual-mode; in recovery mode it shows a new-password form.
        pw_inputs = s.page.locator("input[type=password]")
        n = await pw_inputs.count()
        if n == 0:
            await s.record(
                feature="Set a new password from the reset link",
                promise="The emailed link opens a form to choose a new password",
                actions=["open the reset URL from the inbox"],
                expected="New-password form", actual=f"no password field; url={s.page.url}; {body[:200]}",
                status="Failed", severity="P1", impact="Customers who forget a password cannot recover the account",
            )
            return
        await pw_inputs.first.fill(newpw)
        if n > 1:
            await pw_inputs.nth(1).fill(newpw)
        await s.page.get_by_role("button", name=re.compile("update|set|save|reset", re.I)).first.click()
        await s.page.wait_for_timeout(4000)
        body2 = await s.text()
        toasts = await s.toasts()
        ok = "/app" in s.page.url or "/login" in s.page.url or any("updated" in t.lower() or "success" in t.lower() for t in toasts)
        if ok:
            save_account(key, acct["email"], newpw, old_password=acct["password"])
        await s.record(
            feature="Set a new password from the reset link",
            promise="Choose a new password and get back into the account",
            actions=["open the reset URL", "enter the new password", "submit"],
            expected="Password updated; redirected to the app or login",
            actual=f"url={s.page.url} toasts={toasts} {body2[:120]}",
            status="Verified" if ok else "Failed",
            severity="-" if ok else "P1",
        )


async def old_password(key: str, oldpw: str):
    acct = load_accounts()[key]
    async with Session(PHASE, label=f"account {key}") as s:
        await s.goto("/login", settle_ms=1200)
        await s.page.get_by_label("Email").fill(acct["email"])
        await s.page.get_by_label("Password").fill(oldpw)
        await s.page.get_by_role("button", name="Sign in").click()
        await s.page.wait_for_timeout(4000)
        alert = s.page.locator("[role=alert]")
        msg = (await alert.first.inner_text()).strip() if await alert.count() else ""
        refused = "/login" in s.page.url and bool(msg)
        await s.record(
            feature="Old password no longer works after reset",
            promise="A reset password replaces the previous one",
            actions=["open /login", "enter the OLD password", "click Sign in"],
            expected="Refused with 'Invalid login credentials'",
            actual=f"url={s.page.url} alert={msg!r}",
            status="Verified" if refused else "Failed",
            severity="-" if refused else "P1",
        )
        r = await s.login(expect_ok=False)
        await s.record(
            feature="New password works",
            promise="Sign in with the new password",
            actions=["sign in with the NEW password"],
            expected="Dashboard", actual=f"ok={r['ok']} url={r['url']}",
            status="Verified" if r["ok"] else "Failed", severity="-" if r["ok"] else "P1",
            persistence="new credential persisted" if r["ok"] else "-",
        )


async def session(key: str):
    async with Session(PHASE, account=key) as s:
        for path in ["/app", "/app/pages", "/app/settings"]:
            await s.goto(path, settle_ms=5000)
            bounced = "/login" in s.page.url
            await s.record(
                feature=f"Unauthenticated access to {path}",
                promise="Dashboard pages require sign-in",
                actions=[f"open {path} in a fresh profile with no session"],
                expected="Redirect to /login with next= preserved",
                actual=f"→ {s.page.url}",
                status="Verified" if bounced else "Failed",
                severity="-" if bounced else "P0",
            )
        await s.login()
        # Session survives a reload
        await s.page.reload()
        await s.page.wait_for_timeout(3000)
        still = "/app" in s.page.url and "/login" not in s.page.url
        await s.record(
            feature="Session persists across refresh",
            promise="Stay signed in when the page reloads",
            actions=["sign in", "reload /app"],
            expected="Still on the dashboard", actual=f"url={s.page.url}",
            status="Verified" if still else "Failed", severity="-" if still else "P1",
            persistence="survived reload" if still else "lost on reload",
        )
        # Token tampering: corrupt the stored session and reload
        await s.page.evaluate("() => { for (const k of Object.keys(localStorage)) if (k.includes('auth-token')) localStorage.setItem(k, '{\"access_token\":\"garbage\",\"refresh_token\":\"garbage\"}'); }")
        await s.goto("/app/billing", settle_ms=5000)
        body = await s.text()
        handled = "/login" in s.page.url or "Welcome back" not in body
        await s.record(
            feature="Expired/invalid session handling",
            promise="A dead session sends the customer back to login instead of a broken page",
            actions=["corrupt the stored auth token in localStorage", "open /app/billing"],
            expected="Redirect to /login (no half-rendered dashboard, no console crash)",
            actual=f"url={s.page.url}; body starts: {body[:120]}",
            status="Verified" if handled else "Failed", severity="-" if handled else "P2",
        )


async def main():
    cmd, *rest = sys.argv[1:]
    fn = {"signup": signup, "confirm": confirm, "login": login, "reset-request": reset_request,
          "reset-complete": reset_complete, "old-password": old_password, "session": session}[cmd]
    await fn(*rest)


asyncio.run(main())

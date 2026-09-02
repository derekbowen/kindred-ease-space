"""
Live acceptance harness: real browser sessions against the deployed product,
recorded as customer-visible evidence.

Every check writes one JSON record (the fields the acceptance protocol asks
for) plus a screenshot into the evidence folder, and captures the network
calls and console errors that happened during that check.

Usage from a phase script:

    from harness import Session, EVIDENCE
    async with Session("phase3-content", account="A") as s:
        await s.login()                       # uses creds file
        await s.goto("/app/pages")
        await s.record(
            feature="Pages list", promise="See all my pages",
            actions=["open /app/pages"], expected="table or empty state",
            actual=..., status="Verified", severity="-")

Nothing here touches the database or any admin API. Credentials come from
the scratchpad creds file and are never printed.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from playwright.async_api import async_playwright, TimeoutError as PWTimeout

BASE = os.environ.get("LIVE_BASE_URL", "https://www.founders.click").rstrip("/")
REPO = Path(__file__).resolve().parents[3]
EVIDENCE = REPO / "docs" / "evidence" / "live-acceptance-2026-09-02"
EVIDENCE.mkdir(parents=True, exist_ok=True)
CREDS_FILE = Path(os.environ.get("LIVE_CREDS_FILE", "/tmp/claude-0/-home-user-kindred-ease-space/f1564346-f9c7-5725-838f-64bdf2bf6b8b/scratchpad/live-accounts.json"))

STATUSES = {"Verified", "Failed", "Blocked", "Not implemented", "Intentionally disabled"}

# Requests worth keeping as evidence: our own server functions/APIs and Supabase.
INTERESTING = re.compile(r"(supabase\.co|/_serverFn/|/_server/|/api/|founders\.click)", re.I)
NOISE = re.compile(r"\.(js|css|png|jpg|jpeg|svg|woff2?|ico|mp4|map)(\?|$)", re.I)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def load_accounts() -> dict[str, dict[str, str]]:
    if not CREDS_FILE.exists():
        return {}
    return json.loads(CREDS_FILE.read_text())


def save_account(key: str, email: str, password: str, **extra: Any) -> None:
    accounts = load_accounts()
    accounts[key] = {"email": email, "password": password, **extra}
    CREDS_FILE.parent.mkdir(parents=True, exist_ok=True)
    CREDS_FILE.write_text(json.dumps(accounts, indent=2))
    os.chmod(CREDS_FILE, 0o600)


def redact(url: str) -> str:
    # Never persist tokens that ride in query strings or hash fragments.
    url = re.sub(r"(token|access_token|refresh_token|code|apikey)=[^&#]+", r"\1=REDACTED", url)
    return url.split("#")[0][:300]


class Session:
    def __init__(self, phase: str, account: str | None = None, *, viewport=(1366, 900),
                 mobile: bool = False, slow_network: bool = False, label: str | None = None):
        self.phase = phase
        self.account_key = account
        self.viewport = viewport
        self.mobile = mobile
        self.slow_network = slow_network
        self.label = label or (f"account {account}" if account else "anonymous")
        self.dir = EVIDENCE / phase
        self.dir.mkdir(parents=True, exist_ok=True)
        # Several scripts (and several Sessions per script) share one phase
        # folder: records append to what is already there, and screenshot
        # numbering continues from the files already present.
        self.records: list[dict[str, Any]] = []
        self._net: list[dict[str, Any]] = []
        self._console: list[str] = []
        self._shot_n = len(list(self.dir.glob("*.jpg")))

    # ---- lifecycle -------------------------------------------------------
    async def __aenter__(self):
        self._pw = await async_playwright().start()
        proxy_url = os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy")
        kw: dict[str, Any] = {"headless": True}
        if proxy_url:
            kw["proxy"] = {"server": proxy_url}
            kw["args"] = ["--disable-features=EncryptedClientHello,PostQuantumKyber", "--ssl-version-max=tls1.2"]
        exe = os.environ.get("SMOKE_CHROMIUM_PATH", "/opt/pw-browsers/chromium")
        if exe and Path(exe).exists():
            kw["executable_path"] = exe
        self.browser = await self._pw.chromium.launch(**kw)
        ctx_kw: dict[str, Any] = {
            "viewport": {"width": self.viewport[0], "height": self.viewport[1]},
            "ignore_https_errors": bool(proxy_url),
        }
        if self.mobile:
            ctx_kw.update({"is_mobile": True, "has_touch": True, "viewport": {"width": 390, "height": 844}})
        # A fresh context per Session == a separate browser profile: no shared
        # cookies, storage, or cache between accounts.
        self.context = await self.browser.new_context(**ctx_kw)
        if self.slow_network:
            cdp = await self.context.new_cdp_session(await self.context.new_page())
            await cdp.send("Network.enable")
            await cdp.send("Network.emulateNetworkConditions", {
                "offline": False, "latency": 400, "downloadThroughput": 400 * 1024 / 8, "uploadThroughput": 200 * 1024 / 8})
        self.page = await self.context.new_page()
        self._wire(self.page)
        return self

    async def __aexit__(self, *exc):
        self.flush()
        try:
            await self.context.close()
            await self.browser.close()
        finally:
            await self._pw.stop()

    def _wire(self, page):
        page.on("console", lambda m: self._console.append(f"{m.type}: {m.text[:300]}") if m.type in ("error", "warning") else None)
        page.on("pageerror", lambda e: self._console.append(f"pageerror: {str(e)[:300]}"))
        page.on("requestfailed", lambda r: self._net.append({"t": now_iso(), "method": r.method, "url": redact(r.url), "status": "FAILED", "error": r.failure}))

        async def on_response(resp):
            url = resp.url
            if NOISE.search(url) or not INTERESTING.search(url):
                return
            rec = {"t": now_iso(), "method": resp.request.method, "url": redact(url), "status": resp.status}
            if resp.status >= 400 or "/_serverFn/" in url or "/auth/v1/" in url:
                try:
                    body = await resp.text()
                    rec["body"] = re.sub(r"(access_token|refresh_token)\"?:\s*\"[^\"]+", r"\1:REDACTED", body)[:600]
                except Exception:
                    pass
            self._net.append(rec)
        page.on("response", lambda r: asyncio.ensure_future(on_response(r)))

    async def new_page(self):
        p = await self.context.new_page()
        self._wire(p)
        return p

    # ---- navigation helpers --------------------------------------------
    async def goto(self, path: str, wait: str = "domcontentloaded", settle_ms: int = 2500):
        url = path if path.startswith("http") else f"{BASE}{path}"
        resp = await self.page.goto(url, wait_until=wait, timeout=45_000)
        await self.page.wait_for_timeout(settle_ms)
        return resp

    async def text(self, selector: str = "body", timeout: int = 5000) -> str:
        try:
            t = await self.page.locator(selector).first.inner_text(timeout=timeout)
            return re.sub(r"\s+", " ", t).strip()
        except Exception:
            return ""

    async def toasts(self) -> list[str]:
        out = []
        for el in await self.page.locator("[data-sonner-toast]").all():
            try:
                out.append(re.sub(r"\s+", " ", await el.inner_text()).strip())
            except Exception:
                pass
        return out

    async def shot(self, name: str, page=None, full: bool = False) -> str:
        self._shot_n += 1
        fname = f"{self._shot_n:03d}-{re.sub(r'[^a-z0-9]+', '-', name.lower()).strip('-')[:60]}.jpg"
        path = self.dir / fname
        try:
            await (page or self.page).screenshot(path=str(path), type="jpeg", quality=55, full_page=full)
        except Exception as e:  # never let evidence capture kill a check
            return f"(screenshot failed: {e})"
        return str(path.relative_to(REPO))

    # ---- auth ------------------------------------------------------------
    async def login(self, account: str | None = None, expect_ok: bool = True) -> dict[str, Any]:
        key = account or self.account_key
        acct = load_accounts()[key]
        await self.goto("/login", settle_ms=1200)
        await self.page.get_by_label("Email").fill(acct["email"])
        await self.page.get_by_label("Password").fill(acct["password"])
        await self.page.get_by_role("button", name="Sign in").click()
        try:
            await self.page.wait_for_url("**/app**", timeout=20_000)
            ok = True
            msg = ""
        except PWTimeout:
            ok = False
            alert = self.page.locator("[role=alert]")
            msg = (await alert.first.inner_text()).strip() if await alert.count() else "; ".join(await self.toasts())
        if expect_ok and not ok:
            raise RuntimeError(f"login failed for account {key}: {msg}")
        return {"ok": ok, "message": msg, "url": self.page.url}

    async def logout(self) -> None:
        # The dashboard shell exposes sign-out in the user menu; fall back to
        # clearing storage if the control cannot be found.
        try:
            btn = self.page.get_by_role("button", name=re.compile("sign out|log out", re.I))
            if await btn.count():
                await btn.first.click()
            else:
                menu = self.page.get_by_role("button", name=re.compile("account|menu|profile", re.I))
                if await menu.count():
                    await menu.first.click()
                    await self.page.get_by_role("menuitem", name=re.compile("sign out|log out", re.I)).first.click()
            await self.page.wait_for_timeout(1500)
        except Exception:
            pass

    # ---- evidence ----------------------------------------------------------
    def drain(self) -> tuple[list[dict[str, Any]], list[str]]:
        net, con = self._net[-40:], self._console[-20:]
        self._net, self._console = [], []
        return net, con

    async def record(self, *, feature: str, promise: str, actions: list[str], expected: str,
                     actual: str, status: str, severity: str = "-", impact: str = "",
                     preconditions: str = "", persistence: str = "not checked", repro: list[str] | None = None,
                     screenshot: str | None = None, page=None, url: str | None = None, extra: dict | None = None) -> dict:
        assert status in STATUSES, f"bad status {status}"
        net, con = self.drain()
        rec = {
            "phase": self.phase, "feature": feature, "promise": promise,
            "environment": BASE, "url": url or (page or self.page).url,
            "account": self.label, "browser": "Chromium (Playwright)" + (" mobile 390x844" if self.mobile else f" {self.viewport[0]}x{self.viewport[1]}"),
            "preconditions": preconditions, "actions": actions, "expected": expected, "actual": actual,
            "screenshot": screenshot or await self.shot(feature, page=page),
            "network": net, "console_errors": con, "persistence": persistence,
            "status": status, "severity": severity, "customer_impact": impact,
            "repro": repro or [], "recorded_at": now_iso(),
        }
        if extra:
            rec["extra"] = extra
        self.records.append(rec)
        print(f"[{status:>10}] {feature} — {actual[:110]}")
        self.flush()
        return rec

    def flush(self) -> None:
        path = self.dir / "records.json"
        existing: list[dict[str, Any]] = []
        if path.exists():
            try:
                existing = json.loads(path.read_text())
            except Exception:
                existing = []
        mine = {r["recorded_at"] + r["feature"] for r in self.records}
        kept = [r for r in existing if (r.get("recorded_at", "") + r.get("feature", "")) not in mine]
        path.write_text(json.dumps(kept + self.records, indent=2))

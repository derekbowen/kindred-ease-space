"""One support ticket through the public Contact form, addressed to a test
alias, as an EmailIt delivery probe independent of the auth hook."""
import asyncio, re, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
from harness import Session

EMAIL = sys.argv[1]

async def main():
    async with Session("phase2-account", label="anonymous visitor (contact form)") as s:
        await s.goto("/help/contact", settle_ms=1500)
        form_text = await s.text("form")
        await s.page.get_by_label(re.compile("email", re.I)).first.fill(EMAIL)
        name = s.page.get_by_label(re.compile("name", re.I))
        if await name.count():
            await name.first.fill("Live acceptance test")
        subj = s.page.get_by_label(re.compile("subject", re.I))
        if await subj.count():
            await subj.first.fill("[TEST] live acceptance email-delivery probe — ignore")
        msg = s.page.get_by_label(re.compile("message|how can we help", re.I))
        await msg.first.fill("Automated live-acceptance probe from the founders.click audit. No action needed. Please ignore.")
        cat = s.page.get_by_role("combobox")
        if await cat.count():
            try:
                await cat.first.click(); await s.page.get_by_role("option").first.click()
            except Exception:
                pass
        await s.page.get_by_role("button", name=re.compile("send|submit", re.I)).first.click()
        await s.page.wait_for_timeout(5000)
        body = await s.text(); toasts = await s.toasts()
        ok = bool(re.search(r"(thanks|received|we.ll get back|ticket)", body + " ".join(toasts), re.I))
        await s.record(
            feature="Contact support (public form)",
            promise="Get in touch with the founders.click support team; we typically reply within a day (help/contact)",
            actions=["open /help/contact", "fill email/name/subject/message", "submit"],
            expected="Ticket accepted; confirmation shown; confirmation email arrives at the submitter's address",
            actual=f"ui: {body[:200]} toasts={toasts}",
            status="Verified" if ok else "Failed", severity="-" if ok else "P2",
            extra={"form_fields": form_text[:300], "delivery": "see inbox check"},
        )
asyncio.run(main())

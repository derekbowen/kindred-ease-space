"""
Completeness-critic re-runs for the UNAUTHENTICATED public phase.

The phase-11 "Help centre — article page" record is Verified, but its own
`actual` shows h1='Sharetribe Integration' (the CATEGORY name, not the article
title), 827 body chars and the 'Was this helpful' widget absent — i.e. the check
passed only because bodyLen>300 (the category listing is long enough) while the
real customer outcome (reading THE article) never happened. That directly
contradicts feature-matrix rows 120 (Not implemented, P1) and 30/32 in
advertised-but-absent. This script re-tests the article-reading journey and the
help-home → article links properly and records unauthenticated evidence.

Nothing is submitted; no account, no email, no DB. Run:
  SMOKE_CHROMIUM_PATH=/opt/pw-browsers/chromium python3 tests/e2e/live/critic_public.py
"""
from __future__ import annotations

import asyncio
import re
import sys
import traceback
from pathlib import Path
from urllib.parse import urlparse

sys.path.insert(0, str(Path(__file__).parent))
from harness import BASE, Session  # noqa: E402

PHASE = "critic-public"


async def main() -> None:
    async with Session(PHASE, label="completeness critic (anonymous, desktop 1366x900)") as s:
        p = s.page

        # ---- collect article links from the help home ----------------------
        await s.goto("/help", settle_ms=2000)
        home_links = await p.evaluate(
            """() => [...document.querySelectorAll('a[href^="/help/"]')]
                 .map(a => ({href: a.getAttribute('href'),
                             text: a.textContent.trim().replace(/\\s+/g,' ').slice(0,80)}))
                 .filter(l => l.href.split('/').length === 4
                             && !/\\/(contact|search|sitemap)/.test(l.href))"""
        )
        # de-dup by href, preserve order
        seen: dict[str, dict] = {}
        for l in home_links:
            seen.setdefault(l["href"], l)
        article_links = list(seen.values())

        # HEAD/GET each to split 200 (renderable) from 404 (dead link)
        checked = []
        for l in article_links:
            try:
                ar = await s.context.request.get(BASE + l["href"], timeout=20000)
                checked.append({**l, "status": ar.status})
            except Exception as e:  # noqa: BLE001
                checked.append({**l, "status": f"ERR {type(e).__name__}: {str(e)[:60]}"})
        live = [c for c in checked if c["status"] == 200]
        dead = [c for c in checked if c["status"] == 404]

        # ================================================================
        # (1) Do 200 article URLs actually render the ARTICLE, or the category?
        # ================================================================
        async def article_body(sample):
            findings = []
            for a in sample:
                await s.goto(a["href"], settle_ms=2000)
                info = await p.evaluate(
                    """() => {
                        const body = document.body.innerText;
                        const h1 = document.querySelector('h1')?.textContent.trim() || null;
                        const title = document.title;
                        // breadcrumb text (Help / Category / <Article title> when correct)
                        const crumb = document.querySelector('nav ol, nav[aria-label], nav')?.textContent.trim().replace(/\\s+/g,' ').slice(0,120) || null;
                        return {
                            title, h1, crumb,
                            feedback: /Was this helpful\\?/i.test(body),
                            stillNeedHelp: /Still need help\\?/i.test(body),
                            otherCategories: /OTHER CATEGORIES/i.test(body),
                            minReadMarkers: (body.match(/min read/gi) || []).length,
                            hasArticleEl: !!document.querySelector('article'),
                        };
                    }"""
                )
                # the <title> is set from the article loader → the article's real name
                article_title = (info["title"] or "").split(" — ")[0].strip()
                renders_article = (
                    info["feedback"] and info["stillNeedHelp"]
                    and info["h1"] == article_title
                    and not info["otherCategories"]
                )
                findings.append({"href": a["href"], "article_title_from_title_tag": article_title, **info,
                                 "renders_article": renders_article})
            all_broken = findings and all(not f["renders_article"] for f in findings)
            await s.record(
                feature="Help centre — article body renders (re-check of phase11 'Help centre — article page')",
                promise="Opening a help article (HTTP 200) shows THAT article: its title as the h1, its body, and the 'Was this helpful?' feedback control",
                actions=[f"open each of {[f['href'] for f in findings]} (all return HTTP 200)",
                         "compare the visible h1 with the article's own <title>; check for the article body, 'Was this helpful?' and 'Still need help?'"],
                expected="visible h1 == the article's title; article body present; 'Was this helpful?' + 'Still need help?' present; not the category listing",
                actual="; ".join(
                    f"{f['href'].split('/')[-1]}: title={f['article_title_from_title_tag']!r} but visible h1={f['h1']!r}; "
                    f"feedback={f['feedback']} stillNeedHelp={f['stillNeedHelp']} OTHER-CATEGORIES-listing={f['otherCategories']} "
                    f"min-read-rows={f['minReadMarkers']} → renders_article={f['renders_article']}" for f in findings),
                status="Failed" if all_broken else ("Verified" if findings and all(f["renders_article"] for f in findings) else "Failed"),
                severity="P1" if all_broken else "-",
                impact="Customers cannot read ANY help article: every article URL 200s with the article's <title> but the page shown is the parent CATEGORY listing (help.$category.tsx renders no <Outlet>, so the /$category/$article child never mounts). No article body, no feedback control. This contradicts the phase11 'Help centre — article page' Verified record."
                       if all_broken else "",
                repro=[f"open {findings[0]['href']} — HTTP 200, <title> is the article, but the h1 and body are the category listing ('OTHER CATEGORIES' block, {findings[0]['minReadMarkers']} article rows); no 'Was this helpful?'"] if all_broken else [],
                extra={"findings": findings,
                       "contradicts": "phase11-public record 'Help centre — article page' (Verified) — its own actual shows h1=category name, feedback widget=False",
                       "root_cause": "src/routes/help.$category.tsx has no <Outlet>; the article child route loader runs (so <title> is the article) but its component never renders."},
            )
        # sample two live articles from different categories if possible
        by_cat: dict[str, dict] = {}
        for c in live:
            cat = c["href"].split("/")[2]
            by_cat.setdefault(cat, c)
        sample = list(by_cat.values())[:2] or live[:2]
        try:
            await article_body(sample)
        except Exception:
            print(traceback.format_exc()[-1200:])

        # ================================================================
        # (2) Help home links to articles that 404 (broken journey from /help)
        # ================================================================
        async def dead_home_links():
            # Visit one dead link in the browser to capture the 404 the customer sees.
            shown = None
            if dead:
                r = await s.goto(dead[0]["href"], settle_ms=1500)
                shown = {"status": r.status, "text": (await s.text())[:120]}
            all_ok = not dead
            await s.record(
                feature="Help home article links resolve (no 404s from /help)",
                promise="Every article the help home surfaces (popular / recently updated / category cards) opens",
                actions=["collect article links (/help/<cat>/<article>) shown on /help", "GET each", "open one dead link in the browser"],
                expected="all linked articles return HTTP 200",
                actual=f"{len(checked)} article links on /help; live(200)={len(live)}; dead(404)={len(dead)} "
                       f"{[d['href'] for d in dead]}; browser-visited first dead link → {shown}",
                status="Verified" if all_ok else "Failed",
                severity="-" if all_ok else "P1",
                impact="" if all_ok else "The help home links (and the help sitemap lists) Getting-Started articles that 404 in production — a customer clicking 'Welcome to founders.click' / 'Publishing pages and getting indexed' / 'Connecting your Sharetribe marketplace' from the home page hits a 404.",
                repro=[f"open /help → click a Getting Started article → 404 (e.g. {dead[0]['href']})"] if dead else [],
                extra={"checked": checked},
            )
        try:
            await dead_home_links()
        except Exception:
            print(traceback.format_exc()[-1200:])

        print(f"\ncritic-public: {len(s.records)} records → docs/evidence/live-acceptance-2026-09-02/{PHASE}/records.json")


asyncio.run(main())

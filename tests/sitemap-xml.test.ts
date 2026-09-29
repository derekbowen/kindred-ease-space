/**
 * SITEMAP XML: escaping, UTF-8, limits, the index, and the strict reader. Run: bun tests/sitemap-xml.test.ts
 *
 * Pure functions of src/lib/sitemap.server.ts: what the generator writes
 * (escaped, valid UTF-8, within 50,000 URLs and 50 MB per file, cut in a
 * stable order) and how the Sitemap screen's check reads a sitemap back
 * (parseSitemapXml — the same reader for the generated file and the live
 * one). Offline, no database.
 */
import { harness } from "./_support/fake-postgrest";

process.env.SUPABASE_URL = "http://sitemap-xml.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test";
const sm = await import("../src/lib/sitemap.server");
const { t, done } = harness();

const utf8 = (s: string) => new TextEncoder().encode(s).length;
const strictDecode = (bytes: Uint8Array) => new TextDecoder("utf-8", { fatal: true }).decode(bytes);

// ---------------------------------------------------------------------------
console.log("\nescaping");
t("& → &amp;", sm.escapeXml("a&b") === "a&amp;b");
t("< and > → &lt; &gt;", sm.escapeXml("<b>") === "&lt;b&gt;");
t('" and \' → &quot; &apos;', sm.escapeXml(`"x'`) === "&quot;x&apos;");
t("an already-escaped & is escaped again (text, not markup)", sm.escapeXml("&amp;") === "&amp;amp;");
t("unicode passes through unchanged", sm.escapeXml("café — 東京 🏊") === "café — 東京 🏊");
t("characters XML cannot carry are dropped (NUL, controls, U+FFFE, lone surrogates)",
  sm.escapeXml("a\u0000b\u0007c\u000Bd￾e\uD800f") === "abcdef", JSON.stringify(sm.escapeXml("a\u0000b\u0007c\u000Bd￾e\uD800f")));
t("tab, LF and CR are kept", sm.escapeXml("a\tb\nc\rd") === "a\tb\nc\rd");

console.log("\nURLs are URL-escaped, then XML-escaped");
t("a normal slug is untouched", sm.sitemapLoc("pools.example", "austin-pools") === "https://pools.example/a/austin-pools");
t("unicode in a slug is percent-encoded (URLs in a sitemap are ASCII)", sm.sitemapLoc("h.example", "café") === "https://h.example/a/caf%C3%A9");
t("reserved characters are percent-encoded", sm.sitemapLoc("h.example", "a&b<c>\"'") === "https://h.example/a/a%26b%3Cc%3E%22'");
const entry = sm.urlEntryXml({ loc: "https://h.example/a/x?y=1&z=<2>\"'", lastmod: "2026-09-28T12:34:56Z" });
t("a <loc> with &, <, > and quotes is escaped in the XML",
  entry === "  <url><loc>https://h.example/a/x?y=1&amp;z=&lt;2&gt;&quot;&apos;</loc><lastmod>2026-09-28T12:34:56Z</lastmod></url>\n", entry);
t("…and reads back as the original URL", sm.parseSitemapXml(sm.URLSET_HEAD + entry + sm.URLSET_TAIL).locs[0] === "https://h.example/a/x?y=1&z=<2>\"'");
t("an entry with no lastmod has no <lastmod>", sm.urlEntryXml({ loc: "https://h/a/x", lastmod: null }) === "  <url><loc>https://h/a/x</loc></url>\n");

console.log("\nUTF-8, counted in bytes");
for (const s of ["", "ascii only", "café", "東京", "🏊 pool", "a\uD800b", "é".repeat(1000)]) {
  t(`utf8Length(${JSON.stringify(s.slice(0, 12))}) is the encoded byte length`, sm.utf8Length(s) === utf8(s), `${sm.utf8Length(s)} vs ${utf8(s)}`);
}
{
  const plan = sm.planEntries("h.example", [
    { loc: "https://h.example/a/caf%C3%A9", lastmod: "2026-09-28T00:00:00Z" },
    { loc: "https://h.example/a/東京", lastmod: null },
  ]);
  const xml = sm.renderUrlset(plan, 1);
  const bytes = new TextEncoder().encode(xml);
  t("the document declares UTF-8 and is valid UTF-8", xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n') && strictDecode(bytes) === xml);
  t("the planned size is the byte size, not the character count", plan.shards[0]!.bytes === bytes.length && bytes.length > xml.length, `${plan.shards[0]!.bytes} / ${bytes.length} / ${xml.length}`);
  t("the <urlset> is in the sitemaps namespace", xml.includes(`<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`));
  t("…and reads back well-formed with both URLs", sm.parseSitemapXml(xml).errors.length === 0 && sm.parseSitemapXml(xml).locs.length === 2);
}

console.log("\ncutting files: both limits, stable order");
{
  const e = (n: number, len = 10) => Array.from({ length: n }, (_, i) => ({ loc: `https://h/a/${"p".repeat(len)}${i}`, lastmod: `2026-01-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z` }));
  const byCount = sm.planEntries("h", e(7), { maxUrls: 3, maxBytes: sm.SITEMAP_MAX_BYTES });
  t("7 URLs at 3 per file → 3 / 3 / 1", JSON.stringify(byCount.shards.map((s) => s.end - s.start)) === "[3,3,1]");
  t("files are contiguous in the given order", byCount.shards.every((s, i) => i === 0 || s.start === byCount.shards[i - 1]!.end));
  const lineBytes = sm.utf8Length(byCount.lines[0]!);
  const frame = sm.utf8Length(sm.URLSET_HEAD) + sm.utf8Length(sm.URLSET_TAIL);
  const byBytes = sm.planEntries("h", e(10), { maxUrls: 50_000, maxBytes: frame + lineBytes * 4 });
  t("a byte limit that fits exactly 4 lines → 4 / 4 / 2", JSON.stringify(byBytes.shards.map((s) => s.end - s.start)) === "[4,4,2]", JSON.stringify(byBytes.shards));
  t("every file's planned bytes are within the limit and equal the rendered bytes",
    byBytes.shards.every((s, i) => s.bytes <= frame + lineBytes * 4 && s.bytes === utf8(sm.renderUrlset(byBytes, i + 1))));
  const oneTooMany = sm.planEntries("h", e(10), { maxUrls: 50_000, maxBytes: frame + lineBytes * 4 - 1 });
  t("one byte less → 3 per file", oneTooMany.shards.every((s) => s.end - s.start <= 3));
  const again = sm.planEntries("h", e(10), { maxUrls: 50_000, maxBytes: frame + lineBytes * 4 });
  t("the same entries always cut the same way", JSON.stringify(again.shards) === JSON.stringify(byBytes.shards));
  const empty = sm.planEntries("h", []);
  t("no URLs → one empty file (a valid, empty <urlset>)", empty.shards.length === 1 && sm.parseSitemapXml(sm.renderUrlset(empty, 1)).errors.length === 0 && sm.parseSitemapXml(sm.renderUrlset(empty, 1)).locs.length === 0);
  const huge = sm.planShards([10, 5_000, 10], { maxUrls: 50_000, maxBytes: 1_000 });
  t("an entry larger than a whole file gets a file of its own (and fails validation, below)", JSON.stringify(huge.map((s) => s.end - s.start)) === "[1,1,1]");
}

console.log("\nthe index and the page parameter");
{
  const entries = Array.from({ length: 7 }, (_, i) => ({ loc: `https://h.example/a/p${i}`, lastmod: `2026-0${(i % 3) + 1}-01T00:00:00Z` }));
  const plan = sm.planEntries("h.example", entries, { maxUrls: 3, maxBytes: sm.SITEMAP_MAX_BYTES });
  const index = sm.renderIndex(plan);
  const parsed = sm.parseSitemapXml(index);
  t("the index is a well-formed <sitemapindex>", parsed.kind === "sitemapindex" && parsed.errors.length === 0);
  t("it names /a/sitemap.xml?page=1…3 on the host", JSON.stringify(parsed.locs) === JSON.stringify([1, 2, 3].map((k) => `https://h.example/a/sitemap.xml?page=${k}`)));
  t("each part's lastmod is its newest URL's", JSON.stringify(parsed.lastmods) === JSON.stringify(["2026-03-01T00:00:00Z", "2026-03-01T00:00:00Z", "2026-01-01T00:00:00Z"]), JSON.stringify(parsed.lastmods));
  t("no page → the index", sm.sitemapDocumentFor(plan, undefined) === index);
  t("page 2 → the second file", sm.parseSitemapXml(sm.sitemapDocumentFor(plan, 2)!).locs.join() === "https://h.example/a/p3,https://h.example/a/p4,https://h.example/a/p5");
  t("page 0, 4 and 2.5 → null (404)", sm.sitemapDocumentFor(plan, 0) === null && sm.sitemapDocumentFor(plan, 4) === null && sm.sitemapDocumentFor(plan, 2.5) === null);
  const single = sm.planEntries("h.example", entries.slice(0, 2));
  t("one file: no page → the <urlset>, page 1 → the same, page 2 → null",
    sm.sitemapDocumentFor(single, undefined)!.includes("<urlset") && sm.sitemapDocumentFor(single, 1) === sm.sitemapDocumentFor(single, undefined) && sm.sitemapDocumentFor(single, 2) === null);
}

console.log("\nthe reader refuses anything that isn't a well-formed sitemap");
const NS = 'xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"';
const bad: Array<[string, string]> = [
  ["an unescaped &", `<urlset ${NS}><url><loc>https://h/a/x&y</loc></url></urlset>`],
  ["a bare < in text", `<urlset ${NS}><url><loc>https://h/a/x<y</loc></url></urlset>`],
  ["mismatched tags", `<urlset ${NS}><url><loc>https://h/a/x</url></loc></urlset>`],
  ["an unclosed root", `<urlset ${NS}><url><loc>https://h/a/x</loc></url>`],
  ["two roots", `<urlset ${NS}></urlset><urlset ${NS}></urlset>`],
  ["a DOCTYPE (entity expansion)", `<?xml version="1.0"?><!DOCTYPE urlset [<!ENTITY x "y">]><urlset ${NS}></urlset>`],
  ["text outside the root", `<urlset ${NS}></urlset>oops`],
  ["a NUL character", `<urlset ${NS}><url><loc>https://h/a/x\u0000</loc></url></urlset>`],
  ["a reference to a character XML forbids (&#0;)", `<urlset ${NS}><url><loc>https://h/a/x&#0;</loc></url></urlset>`],
  ["an unknown entity (&nbsp;)", `<urlset ${NS}><url><loc>https://h/a/x&nbsp;</loc></url></urlset>`],
  ["an unterminated comment", `<urlset ${NS}><!-- oops </urlset>`],
  ["an unquoted attribute", `<urlset xmlns=http://www.sitemaps.org/schemas/sitemap/0.9></urlset>`],
  ["an XML declaration that isn't first", `\n<urlset ${NS}><?xml version="1.0"?></urlset>`],
  ["the wrong namespace", `<urlset xmlns="http://example.com/ns"><url><loc>https://h/a/x</loc></url></urlset>`],
  ["no namespace", `<urlset><url><loc>https://h/a/x</loc></url></urlset>`],
  ["an HTML page", `<!doctype html><html><body>Not found</body></html>`],
  ["a <url> without a <loc>", `<urlset ${NS}><url><lastmod>2026-01-01</lastmod></url></urlset>`],
  ["a <url> with two <loc>s", `<urlset ${NS}><url><loc>https://h/a/x</loc><loc>https://h/a/y</loc></url></urlset>`],
  ["an empty <loc>", `<urlset ${NS}><url><loc>  </loc></url></urlset>`],
  ["a lastmod that isn't a W3C datetime", `<urlset ${NS}><url><loc>https://h/a/x</loc><lastmod>yesterday</lastmod></url></urlset>`],
  ["an unknown element in <url>", `<urlset ${NS}><url><loc>https://h/a/x</loc><title>x</title></url></urlset>`],
  ["stray text in <urlset>", `<urlset ${NS}>hello<url><loc>https://h/a/x</loc></url></urlset>`],
  ["a document declaring another encoding", `<?xml version="1.0" encoding="ISO-8859-1"?><urlset ${NS}></urlset>`],
  ["an empty document", ``],
];
for (const [label, xml] of bad) {
  const p = sm.parseSitemapXml(xml);
  t(`refused: ${label}`, p.errors.length > 0, JSON.stringify(p));
}
const good: Array<[string, string, string[]]> = [
  ["a minimal urlset", `<urlset ${NS}><url><loc>https://h/a/x</loc></url></urlset>`, ["https://h/a/x"]],
  ["with a BOM, declaration, comments and whitespace", `﻿<?xml version="1.0" encoding="utf-8"?>\n<!-- generated -->\n<urlset ${NS}>\n  <url>\n    <loc> https://h/a/x </loc>\n  </url>\n</urlset>\n<!-- end -->\n`, ["https://h/a/x"]],
  ["entities and character references", `<urlset ${NS}><url><loc>https://h/a/x?a=1&amp;b=&#50;&#x33;</loc></url></urlset>`, ["https://h/a/x?a=1&b=23"]],
  ["a CDATA <loc>", `<urlset ${NS}><url><loc><![CDATA[https://h/a/x?a=1&b=2]]></loc></url></urlset>`, ["https://h/a/x?a=1&b=2"]],
  ["changefreq, priority and an image extension", `<urlset ${NS} xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"><url><loc>https://h/a/x</loc><lastmod>2026-09-28</lastmod><changefreq>weekly</changefreq><priority>0.5</priority><image:image><image:loc>https://h/i.png</image:loc></image:image></url></urlset>`, ["https://h/a/x"]],
  ["single quotes and a self-closing empty set", `<urlset xmlns='http://www.sitemaps.org/schemas/sitemap/0.9'/>`, []],
];
for (const [label, xml, want] of good) {
  const p = sm.parseSitemapXml(xml);
  t(`read: ${label}`, p.errors.length === 0 && p.wellFormed && JSON.stringify(p.locs) === JSON.stringify(want), JSON.stringify(p));
}
t("W3C datetimes: every precision is accepted, junk is not",
  ["2026", "2026-09", "2026-09-28", "2026-09-28T12:34Z", "2026-09-28T12:34:56+02:00", "2026-09-28T12:34:56.123Z"].every((d) => sm.W3C_DATETIME_RE.test(d)) &&
    !["2026-9-28", "28/09/2026", "2026-09-28 12:34:56", "2026-09-28T12:34:56"].some((d) => sm.W3C_DATETIME_RE.test(d)));
t("the generator's lastmod format is a W3C datetime at seconds", sm.w3cDatetime(Date.UTC(2026, 8, 28, 12, 34, 56, 789)) === "2026-09-28T12:34:56Z");

console.log("\nthe in-process validation of a whole build");
{
  const urls = Array.from({ length: 7 }, (_, i) => ({ id: `id-${i}`, slug: `page-${i}`, source: "page" as const, lastmod: "2026-09-28T00:00:00Z", orderAt: i }));
  const plan = sm.planSitemap("pools.example", urls, { maxUrls: 3, maxBytes: sm.SITEMAP_MAX_BYTES });
  const expected = plan.entries.map((e) => e.loc);
  const ok = sm.validateSitemapPlan(plan, expected);
  t("a correct 3-part build validates: 7 URLs, 3 parts", ok.ok && ok.urlCount === 7 && ok.parts === 3, JSON.stringify(ok));
  const missing = sm.validateSitemapPlan(plan, [...expected, "https://pools.example/a/page-99"]);
  t("a URL the build chose but the XML lacks is caught", !missing.ok && missing.errors.some((e) => /1 missing/.test(e)));
  const extra = sm.validateSitemapPlan(plan, expected.slice(1));
  t("a URL in the XML the build didn't choose is caught", !extra.ok && extra.errors.some((e) => /1 extra/.test(e)));
  const doubled = sm.planEntries("pools.example", [...plan.entries, plan.entries[0]!]);
  t("a URL listed twice is caught", sm.validateSitemapPlan(doubled, expected).errors.some((e) => /listed twice/.test(e)));
  const offHost = sm.planEntries("pools.example", [{ loc: "https://other.example/a/page-0", lastmod: null }]);
  t("a URL on another host is caught", sm.validateSitemapPlan(offHost, ["https://other.example/a/page-0"]).errors.some((e) => /not a page URL on pools\.example/.test(e)));
  const oversize = sm.planEntries("pools.example", [{ loc: `https://pools.example/a/${"x".repeat(150)}`, lastmod: null }], { maxUrls: 50_000, maxBytes: 100 });
  t("a file over the byte limit is caught", sm.validateSitemapPlan(oversize, oversize.entries.map((e) => e.loc)).errors.some((e) => /bytes \(limit 100\)/.test(e)));
}

done();

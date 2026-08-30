import { parseRobots, isDisallowed, looksLikeSitemapUrl } from "../src/lib/opportunity/site-scan.server";
let p=0,f=0; const t=(n:string,c:boolean)=>{c?(p++,console.log("  PASS  "+n)):(f++,console.log("  FAIL  "+n));};
const robots = parseRobots(`
User-agent: AhrefsBot
Disallow: /
User-agent: *
Disallow: /profile-settings
Disallow: /l/*/checkout
Disallow: /inbox
Sitemap: https://ex.com/sitemap.xml
`);
console.log("\n=== robots parsing (real PRNM shape) ===");
t("named-bot Disallow: / does NOT apply to us", !isDisallowed("/anything", robots));
t("wildcard-group prefix rule applies", isDisallowed("/profile-settings", robots));
t("mid-path * wildcard applies", isDisallowed("/l/abc123/checkout", robots));
t("unrelated path allowed", !isDisallowed("/pool-rentals-riverside", robots));
t("Sitemap directive captured", robots.sitemaps[0] === "https://ex.com/sitemap.xml");
console.log("\n=== sitemap URL detection (the ?page=2 bug) ===");
t("plain .xml is a sitemap", looksLikeSitemapUrl("https://x.com/sitemap-a.xml"));
t(".xml?page=2 is a sitemap", looksLikeSitemapUrl("https://x.com/sitemap-a.xml?page=2"));
t(".xml.gz is a sitemap", looksLikeSitemapUrl("https://x.com/sitemap-a.xml.gz"));
t("content page is not a sitemap", !looksLikeSitemapUrl("https://x.com/pool-rentals-riverside"));
t("page with ?xml= param is not a sitemap", !looksLikeSitemapUrl("https://x.com/page?format=xml"));
console.log(`\n${p} passed, ${f} failed\n`); process.exit(f?1:0);

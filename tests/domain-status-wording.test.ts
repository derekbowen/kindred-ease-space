/**
 * DOMAIN STATUS: TWO FACTS, SAME WORDS ON BOTH SCREENS. Run: bun tests/domain-status-wording.test.ts
 *
 * Workspace Settings said "Verified" while Settings → Domains said "Issuing
 * SSL" for the same hostname. Those are two facts — ownership proven,
 * certificate not yet ready — so both screens now print both, from one helper
 * (src/components/settings/domain-status.ts). Copy only: no provisioning
 * change. Offline.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  describeDomainStatus,
  normalizeDomainInput,
  pickDomainForSettings,
} from "../src/components/settings/domain-status";

let pass = 0,
  fail = 0;
const failed: string[] = [];
function t(name: string, cond: boolean, extra = "") {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    failed.push(name);
    console.log(`  FAIL  ${name}  ${extra}`);
  }
}

// ---------------------------------------------------------------------------
console.log("\nevery status reads as ownership · certificate");

const label = (status: string, verified: boolean) => describeDomainStatus(status, verified).label;
t(
  'ssl_pending → "Ownership verified · Certificate issuing"',
  label("ssl_pending", true) === "Ownership verified · Certificate issuing",
  label("ssl_pending", true),
);
t('provisioning → "… Certificate issuing"', label("provisioning", true) === "Ownership verified · Certificate issuing");
t('active → "Ownership verified · Certificate ready" (the only green state with a certificate)', label("active", true) === "Ownership verified · Certificate ready" && describeDomainStatus("active", true).tone === "ok");
t('dns_configuration_required → "… Certificate waiting for DNS"', label("dns_configuration_required", true) === "Ownership verified · Certificate waiting for DNS");
t('verification_required → "Ownership not verified"', label("verification_required", false) === "Ownership not verified");
t('pending → "Ownership not verified"', label("pending", false) === "Ownership not verified");
t('legacy verified → "Ownership verified · Certificate not requested yet"', label("verified", true) === "Ownership verified · Certificate not requested yet");
t("error keeps the ownership fact from the row", label("error", true) === "Ownership verified · Setup needs attention" && label("error", false) === "Ownership not verified · Setup needs attention");
t('disconnected → "Disconnected"', label("disconnected", true) === "Disconnected");
t(
  "nothing but a ready certificate claims to be finished",
  ["verification_required", "pending", "verified", "dns_configuration_required", "provisioning", "ssl_pending", "error"].every(
    (s) => describeDomainStatus(s, true).tone !== "ok",
  ),
);
t(
  'no label is a bare "Verified" or the old "Issuing SSL"',
  ["verification_required", "verified", "dns_configuration_required", "ssl_pending", "active", "error"].every(
    (s) => label(s, true) !== "Verified" && !/Issuing SSL/.test(label(s, true)),
  ),
);

// ---------------------------------------------------------------------------
console.log("\nWorkspace Settings picks the same row the Domains page shows");

const rows = [
  { hostname: "seo.example.com", status: "ssl_pending", verified: true },
  { hostname: "old.example.com", status: "disconnected", verified: true },
  { hostname: "example.com", status: "active", verified: true },
];
t("the marketplace domain's own row wins", pickDomainForSettings(rows, "https://Example.com/")?.hostname === "example.com");
t("else the newest connected row", pickDomainForSettings(rows, "other.com")?.hostname === "seo.example.com");
t("disconnected rows are never described", pickDomainForSettings([rows[1]], "old.example.com") === null);
t("no rows, no badge from rows", pickDomainForSettings([], "example.com") === null);
t("typed input is normalized", normalizeDomainInput(" HTTPS://Www.Example.com:443/path?x ") === "www.example.com");

// ---------------------------------------------------------------------------
console.log("\nboth screens use the helper");

const ROOT = join(import.meta.dir, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const domains = read("src/routes/_authenticated/app.settings.domains.tsx");
const settings = read("src/routes/_authenticated/app.settings.tsx");

t("Domains: the chip is describeDomainStatus(status, verified)", /const s = describeDomainStatus\(status, verified\);/.test(domains) && /<StatusChip status=\{d\.status\} verified=\{d\.verified\} \/>/.test(domains));
t('Domains: the old one-fact map ("Issuing SSL", "Verified") is gone', !/Issuing SSL/.test(domains) && !/STATUS_LABEL/.test(domains));
// The DNS record must be on screen while the certificate waits for it: verify
// provisions the edge and lands the row in ssl_pending in one request, and the
// certificate (HTTP-validated) cannot issue until DNS points at the edge.
const dnsBlockGuard = /\{\(d\.status === "dns_configuration_required" \|\| d\.status === "ssl_pending"\) && \(/;
t("Domains: DNS instructions render for ssl_pending as well as dns_configuration_required", dnsBlockGuard.test(domains));
t("Domains: no DNS block is gated on dns_configuration_required alone", !/\{d\.status === "dns_configuration_required" && \(/.test(domains));
t("Domains: ssl_pending explains the certificate follows the DNS change", /Your security certificate is issued automatically once this record is live/.test(domains));
t("Settings: reads the same domain rows as the Domains page", /listWorkspaceDomains/.test(settings) && /setDomainRows\(r\.rows\)/.test(settings));
t("Settings: the badge prints domainFacts.label", /\{domainFacts\.label\}/.test(settings) && /describeDomainStatus\(domainRow\.status, domainRow\.verified\)/.test(settings));
t('Settings: no bare "Verified" badge any more', !/<CheckCircle2 className="h-3 w-3" \/> Verified\b/.test(settings));
t("Settings: says which domain it describes when it is not the marketplace domain", /Status shown for your connected domain \{domainRow\.hostname\}\./.test(settings));
t(
  "no provisioning code changed hands: the pages call no new server function",
  !/verifyWorkspaceDomain|activateWorkspaceDomain/.test(settings),
);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("Failed:\n  " + failed.join("\n  "));
  process.exit(1);
}

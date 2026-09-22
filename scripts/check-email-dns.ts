#!/usr/bin/env bun
/**
 * Deliverability preflight. Run: bun scripts/check-email-dns.ts [domain]
 *
 * Exits non-zero when mail sent as the domain would be discarded, so the
 * deploy pipeline can refuse to ship a build whose auth email cannot arrive.
 *
 * This check exists because the send API is not evidence. EmailIt returned
 * 200 for every auth email founders.click ever sent, while the domain had no
 * SPF and no DKIM and receivers dropped the mail on the floor. The DNS is the
 * only part of that chain we can assert cheaply and continuously.
 *
 * Set EMAILIT_DKIM_SELECTOR when the provider's selector is known — a probe
 * across common selectors can miss a real key published under another name.
 *
 * SPF is evaluated against the ENVELOPE sender, never assumed to be the apex.
 * The envelope is resolved in this order, and the first hit wins:
 *
 *   EMAILIT_RETURN_PATH_DOMAIN  the operator's declaration
 *   MAIL_FROM                   a Return-Path actually observed on sent mail
 *   EMAILIT_ESP_RETURN_PATH_DOMAIN  what the provider reports
 *   DNS discovery               a candidate that proves itself
 *   the sending domain          only if nothing delegated the envelope
 *
 * An SPF record on the apex never ends that search: if the envelope is
 * delegated, an apex record authorises nothing a receiver checks.
 */
import {
  checkSendingDomain,
  returnPathFromEnv,
  sendingDomainFromEnv,
} from "../src/lib/email-deliverability";

const explicit = process.argv[2];
const domain =
  explicit ??
  sendingDomainFromEnv({
    FROM_EMAIL: process.env.FROM_EMAIL,
    EMAILIT_SENDER_DOMAIN: process.env.EMAILIT_SENDER_DOMAIN,
  });

if (!domain) {
  console.error(
    "No sending domain. Pass one as an argument, or set FROM_EMAIL / EMAILIT_SENDER_DOMAIN.",
  );
  process.exit(2);
}

const selector = process.env.EMAILIT_DKIM_SELECTOR;
const report = await checkSendingDomain(domain, {
  dkimSelector: selector,
  ...returnPathFromEnv({
    EMAILIT_RETURN_PATH_DOMAIN: process.env.EMAILIT_RETURN_PATH_DOMAIN,
    MAIL_FROM: process.env.MAIL_FROM,
    EMAILIT_ESP_RETURN_PATH_DOMAIN: process.env.EMAILIT_ESP_RETURN_PATH_DOMAIN,
  }),
});

const mark = { pass: "OK  ", warn: "WARN", fail: "FAIL" }[report.verdict];
console.log(`\n${mark}  email deliverability for ${report.domain}\n`);

const row = (
  label: string,
  check: {
    status: "present" | "absent" | "unknown";
    value?: string;
    problem?: string;
    foundOn?: string;
  },
) => {
  const state = { present: "present", absent: "MISSING", unknown: "UNKNOWN" }[check.status];
  console.log(`  ${label.padEnd(6)} ${state.padEnd(8)} ${check.value ?? ""}`);
  // Where a record lives is the whole point for SPF: on the apex it is absent
  // and correct at the same time, provided the return path carries it.
  if (check.foundOn) console.log(`         on ${check.foundOn}`);
  if (check.problem) console.log(`         ${check.problem}`);
};

console.log(
  `  ENV    ${report.envelope.source.padEnd(8)} ${report.envelope.domain}` +
    `${report.envelope.mx ? `  (MX ${report.envelope.mx})` : ""}`,
);
row("SPF", report.spf);
// Shown whenever it differs from the envelope's, so an apex record can never
// be mistaken for the one that counts.
if (report.envelope.source !== "apex") {
  const state = { present: "present", absent: "none", unknown: "UNKNOWN" }[report.apexSpf.status];
  console.log(`  SPF@   ${state.padEnd(8)} ${report.apexSpf.value ?? ""}  (apex — not checked by receivers)`);
}
row("DKIM", report.dkim.selector ? { ...report.dkim, value: `selector "${report.dkim.selector}"` } : report.dkim);
row("DMARC", report.dmarc);

console.log("");
for (const finding of report.findings) console.log(`  - ${finding}`);

if (report.indeterminate) {
  // Do not print fix instructions: we never established that anything is wrong
  // with the DNS, only that we could not read it from here.
  console.log("\n  Could not read the DNS. Re-run from a network that can resolve it.\n");
  process.exit(1);
}

// Only ever print the records that are actually missing. Telling an operator
// to add a DKIM key they already published is how a real single-record fix
// gets mistaken for a big one and deferred.
const fixes: string[] = [];
if (!report.spf.present) {
  // Reached when the ENVELOPE sender publishes no SPF — which an apex record
  // does not fix when the envelope is delegated.
  fixes.push(
    `    SPF     TXT  @        v=spf1 include:_spf.emailit.com ~all\n` +
      `            Without it, Microsoft in particular drops mail from a domain\n` +
      `            with no sending reputation even when DKIM signs correctly.\n` +
      `            The envelope sender is ${report.envelope.domain}; publish it\n` +
      `            there, or set EMAILIT_RETURN_PATH_DOMAIN if the envelope is\n` +
      `            elsewhere. SPF on ${report.domain} does not cover a delegated\n` +
      `            envelope.`,
  );
}
if (!report.dkim.present) {
  fixes.push(
    `    DKIM    TXT  <selector>._domainkey\n` +
      `            Copy from the EmailIt dashboard — the key is account-specific.`,
  );
}
if (!report.dmarc.present) {
  fixes.push(
    `    DMARC   TXT  _dmarc   v=DMARC1; p=none; rua=mailto:dmarc@${report.domain}\n` +
      `            Start at p=none so nothing is rejected while alignment is confirmed.`,
  );
} else if (report.dmarc.value && !/rua=/i.test(report.dmarc.value)) {
  // A DMARC record with no reporting address is the reason a delivery problem
  // can persist unnoticed: receivers have nowhere to tell you what they did.
  console.log(
    `\n  NOTE  DMARC is published but sets no rua= reporting address, so receivers\n` +
      `        have no way to report what they do with your mail. Consider:\n` +
      `          ${report.dmarc.value.replace(/;?\s*$/, "")}; rua=mailto:dmarc@${report.domain}`,
  );
}

if (fixes.length > 0) {
  console.log(`\n  Publish on ${report.domain}, then re-run this check:\n`);
  for (const fix of fixes) console.log(fix + "\n");
}

if (report.verdict === "fail") process.exit(1);
if (report.verdict === "warn") {
  console.log("  Mail should authenticate, but fix the above before sending volume.\n");
}
process.exit(0);

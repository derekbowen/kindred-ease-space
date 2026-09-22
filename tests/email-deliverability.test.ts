/**
 * Email deliverability preflight. Run: bun tests/email-deliverability.test.ts
 *
 * Two opposite false verdicts are what this file exists to prevent, and both
 * have been shipped:
 *
 *   FALSE NEGATIVE — reading SPF at the apex, finding none, and calling it a
 *   hard failure on a domain that authenticates perfectly well because its
 *   envelope is delegated. That cost 22 re-checks of a record that was never
 *   required.
 *
 *   FALSE POSITIVE — reading SPF at the apex, finding one, and calling that a
 *   pass when the envelope is delegated elsewhere. Worse, because it is
 *   silent: the apex record authorises nothing a receiver checks.
 *
 * So the envelope is resolved first, by precedence, and SPF is read there.
 */
import {
  checkSendingDomain,
  returnPathFromEnv,
  sendingDomainFromEnv,
} from "../src/lib/email-deliverability";

let pass = 0, fail = 0;
const failed: string[] = [];
function t(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failed.push(name); console.log(`  FAIL  ${name}  ${extra}`); }
}

/**
 * Build a fetch stand-in serving fixed TXT and MX maps. Unlisted names return
 * NXDOMAIN. MX is served separately because it is supporting evidence for a
 * guessed envelope, and the tests need to vary it independently of SPF.
 */
function dnsStub(
  txtZone: Record<string, string[]>,
  mxZone: Record<string, string[]> = {},
): typeof fetch {
  return (async (input: any) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    const name = (url.searchParams.get("name") ?? "").replace(/\.$/, "");
    const type = url.searchParams.get("type") ?? "TXT";
    const nxdomain = new Response(JSON.stringify({ Status: 3 }), { status: 200 });

    if (type === "MX") {
      const hosts = mxZone[name];
      if (!hosts) return nxdomain;
      return new Response(
        JSON.stringify({ Answer: hosts.map((h) => ({ name, type: 15, data: `10 ${h}.` })) }),
        { status: 200 },
      );
    }

    const records = txtZone[name];
    if (!records) return nxdomain;
    return new Response(
      JSON.stringify({ Answer: records.map((r) => ({ name, type: 16, data: `"${r}"` })) }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
}

const SPF = "v=spf1 include:_spf.emailit.com ~all";
const DKIM = (n: string) => ["v=DKIM1; p=" + n.repeat(200)];
const BOUNCE_MX = "feedback-smtp.ffdc-1.emailit.com";

console.log("\n=== the founders.click failure: no SPF, no DKIM, no DMARC ===");
{
  const report = await checkSendingDomain("founders.click", { fetchImpl: dnsStub({}) });
  t("verdict is fail, not warn", report.verdict === "fail", report.verdict);
  t("spf reported absent", !report.spf.present);
  t("dkim reported absent", !report.dkim.present);
  t("dmarc reported absent", !report.dmarc.present);
  t("envelope falls back to the apex", report.envelope.source === "apex", report.envelope.source);
  t(
    "finding says mail will not arrive",
    report.findings.some((f) => /discarded|nothing will arrive/i.test(f)),
    report.findings.join(" | "),
  );
}

console.log("\n=== apex SPF + return-path SPF: the envelope wins, and is found ===");
{
  // The live founders.click arrangement since the apex record was added. The
  // apex must not stop discovery, and the envelope must be the one reported.
  let mxQueries = 0;
  const counting = ((input: any) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    if (url.searchParams.get("type") === "MX") mxQueries++;
    return dnsStub(
      {
        "founders.click": [SPF],
        "emailit.founders.click": [SPF],
        "emailit._domainkey.founders.click": DKIM("D"),
        "_dmarc.founders.click": ["v=DMARC1; p=none;"],
      },
      { "emailit.founders.click": [BOUNCE_MX] },
    )(input);
  }) as unknown as typeof fetch;

  const report = await checkSendingDomain("founders.click", {
    dkimSelector: "emailit",
    fetchImpl: counting,
  });

  t("verdict is pass", report.verdict === "pass", report.findings.join(" | "));
  t("an apex SPF record did NOT short-circuit discovery", mxQueries > 1, String(mxQueries));
  t("envelope is the delegated name", report.envelope.domain === "emailit.founders.click",
    report.envelope.domain);
  t("envelope source is discovered", report.envelope.source === "discovered");
  t("SPF is reported against the envelope", report.spf.foundOn === "emailit.founders.click");
  t("the apex record is reported separately", report.apexSpf.present && report.apexSpf.value === SPF);
  t("evidence names the bounce MX",
    report.envelope.evidence.some((e) => e.includes(BOUNCE_MX)), report.envelope.evidence.join("; "));
  t("evidence names the selector match",
    report.envelope.evidence.some((e) => /DKIM selector/.test(e)), report.envelope.evidence.join("; "));
  t("it aligns under DMARC's default relaxed policy", report.envelope.alignsRelaxed === true);
  t(
    "a finding explains that apex SPF is not required",
    report.findings.some((f) => /No SPF record is required on founders\.click/i.test(f)),
    report.findings.join(" | "),
  );
}

console.log("\n=== apex SPF + return-path SPF MISSING: apex must not rescue it ===");
{
  // The false positive. The envelope is declared, so it is believed even
  // though it publishes nothing — that is a fact about the real envelope.
  const report = await checkSendingDomain("founders.click", {
    dkimSelector: "emailit",
    returnPathDomain: "emailit.founders.click",
    fetchImpl: dnsStub(
      {
        "founders.click": [SPF],
        "emailit._domainkey.founders.click": DKIM("E"),
        "_dmarc.founders.click": ["v=DMARC1; p=none;"],
      },
      { "emailit.founders.click": [BOUNCE_MX] },
    ),
  });

  t("verdict is fail", report.verdict === "fail", report.verdict);
  t("SPF is absent at the envelope", !report.spf.present, JSON.stringify(report.spf));
  t("the apex record is still reported present", report.apexSpf.present);
  t(
    "a finding says the apex record covers nothing receivers check",
    report.findings.some((f) => /authorises nothing receivers check/i.test(f)),
    report.findings.join(" | "),
  );
  t(
    "no finding claims the domain authenticates",
    !report.findings.some((f) => /authenticates: SPF/i.test(f)),
  );
}

console.log("\n=== a bounce-shaped name with no SPF is reported even when the apex passes ===");
{
  // Heuristic path: the candidate cannot qualify (no SPF), so the envelope
  // falls back to the apex — but the near-miss is the likely real problem and
  // must not vanish.
  const report = await checkSendingDomain("founders.click", {
    dkimSelector: "emailit",
    fetchImpl: dnsStub(
      {
        "founders.click": [SPF],
        "emailit._domainkey.founders.click": DKIM("F"),
        "_dmarc.founders.click": ["v=DMARC1; p=none;"],
      },
      { "emailit.founders.click": [BOUNCE_MX] },
    ),
  });

  t("envelope falls back to the apex", report.envelope.source === "apex", report.envelope.source);
  t("the suspect is reported", report.suspectEnvelope?.domain === "emailit.founders.click",
    JSON.stringify(report.suspectEnvelope));
  t("it warns rather than passing silently", report.verdict === "warn", report.verdict);
  t(
    "the warning explains the consequence",
    report.findings.some((f) => /SPF leg fails regardless/i.test(f)),
    report.findings.join(" | "),
  );
}

console.log("\n=== envelope precedence ===");
{
  const zone = {
    "founders.click": [SPF],
    "declared.founders.click": [SPF],
    "observed.founders.click": [SPF],
    "esp.founders.click": [SPF],
    "emailit.founders.click": [SPF],
    "emailit._domainkey.founders.click": DKIM("G"),
    "_dmarc.founders.click": ["v=DMARC1; p=none;"],
  };
  const mx = {
    "declared.founders.click": [BOUNCE_MX],
    "observed.founders.click": [BOUNCE_MX],
    "esp.founders.click": [BOUNCE_MX],
    "emailit.founders.click": [BOUNCE_MX],
  };
  const call = (o: Record<string, string>) =>
    checkSendingDomain("founders.click", {
      dkimSelector: "emailit",
      fetchImpl: dnsStub(zone, mx),
      ...o,
    });

  const all = await call({
    returnPathDomain: "declared.founders.click",
    observedReturnPath: "observed.founders.click",
    espReturnPath: "esp.founders.click",
  });
  t("1. EMAILIT_RETURN_PATH_DOMAIN wins", all.envelope.domain === "declared.founders.click",
    all.envelope.domain);
  t("   and is labelled configured", all.envelope.source === "configured");

  const obs = await call({
    observedReturnPath: "observed.founders.click",
    espReturnPath: "esp.founders.click",
  });
  t("2. observed MAIL FROM beats the ESP value", obs.envelope.domain === "observed.founders.click",
    obs.envelope.domain);
  t("   and is labelled observed", obs.envelope.source === "observed");

  const esp = await call({ espReturnPath: "esp.founders.click" });
  t("3. the ESP value beats discovery", esp.envelope.domain === "esp.founders.click",
    esp.envelope.domain);
  t("   and is labelled esp", esp.envelope.source === "esp");

  const found = await call({});
  t("4. discovery is used when nothing was declared",
    found.envelope.domain === "emailit.founders.click", found.envelope.domain);
  t("   and is labelled discovered", found.envelope.source === "discovered");

  // 5. the apex, only when nothing delegated the envelope.
  const apexOnly = await checkSendingDomain("plain.example", {
    dkimSelector: "s1",
    fetchImpl: dnsStub({
      "plain.example": [SPF],
      "s1._domainkey.plain.example": DKIM("H"),
      "_dmarc.plain.example": ["v=DMARC1; p=none"],
    }),
  });
  t("5. the apex is the envelope when nothing is delegated",
    apexOnly.envelope.source === "apex" && apexOnly.envelope.domain === "plain.example",
    apexOnly.envelope.domain);
  t("   and that is a clean pass", apexOnly.verdict === "pass", apexOnly.findings.join(" | "));
  t("   with no foundOn, because it is not delegated", apexOnly.spf.foundOn === undefined);
}

console.log("\n=== what a GUESSED candidate must prove ===");
{
  // SPF is necessary. An MX alone is a mail host, not an authorisation.
  const mxNoSpf = await checkSendingDomain("example.com", {
    dkimSelector: "s1",
    fetchImpl: dnsStub(
      { "s1._domainkey.example.com": DKIM("I"), "_dmarc.example.com": ["v=DMARC1; p=none"] },
      { "mail.example.com": ["mx.example.net"] },
    ),
  });
  t("an MX without SPF is not the envelope", mxNoSpf.envelope.source === "apex");
  t("and the verdict is fail (nothing publishes SPF)", mxNoSpf.verdict === "fail");

  // SPF alone is not sufficient either: any subdomain could carry one.
  const spfNoEvidence = await checkSendingDomain("example.com", {
    dkimSelector: "s1",
    fetchImpl: dnsStub({
      "mail.example.com": [SPF],
      "s1._domainkey.example.com": DKIM("J"),
      "_dmarc.example.com": ["v=DMARC1; p=none"],
    }),
  });
  t("SPF on a subdomain with no supporting evidence is not the envelope",
    spfNoEvidence.envelope.source === "apex", spfNoEvidence.envelope.domain);
  t("so SPF is absent and the verdict is fail", spfNoEvidence.verdict === "fail");

  // MX is NOT universally required: a label matching the provider's DKIM
  // selector ties the name to mail just as well, and some ESPs publish the
  // return path without an MX we can read.
  const selectorMatch = await checkSendingDomain("example.com", {
    dkimSelector: "postal",
    fetchImpl: dnsStub({
      "postal.example.com": [SPF],
      "postal._domainkey.example.com": DKIM("K"),
      "_dmarc.example.com": ["v=DMARC1; p=none"],
    }),
  });
  t("a selector-matching label with SPF qualifies WITHOUT an MX",
    selectorMatch.envelope.domain === "postal.example.com", selectorMatch.envelope.domain);
  t("the evidence says why", selectorMatch.envelope.evidence.some((e) => /DKIM selector/.test(e)),
    selectorMatch.envelope.evidence.join("; "));
  t("no MX is recorded", selectorMatch.envelope.mx === null);
  t("and it passes", selectorMatch.verdict === "pass", selectorMatch.findings.join(" | "));

  // A plain MX is supporting evidence too — it need not be a known bounce host.
  const plainMx = await checkSendingDomain("example.com", {
    dkimSelector: "s1",
    fetchImpl: dnsStub(
      {
        "bounces.example.com": [SPF],
        "s1._domainkey.example.com": DKIM("L"),
        "_dmarc.example.com": ["v=DMARC1; p=none"],
      },
      { "bounces.example.com": ["mx.some-esp.example"] },
    ),
  });
  t("an ordinary MX plus SPF qualifies", plainMx.envelope.domain === "bounces.example.com",
    plainMx.envelope.domain);
  t("evidence names the MX", plainMx.envelope.evidence.some((e) => e.startsWith("MX ")));
  t("but not a bounce-host pattern it does not match",
    !plainMx.envelope.evidence.some((e) => /bounce-host pattern/.test(e)),
    plainMx.envelope.evidence.join("; "));
}

console.log("\n=== a declared envelope is believed even when it looks like nothing ===");
{
  // No MX, no bounce-host pattern, not a selector match. The operator said so.
  const report = await checkSendingDomain("founders.click", {
    dkimSelector: "emailit",
    returnPathDomain: "Odd-Name.Founders.Click.",
    fetchImpl: dnsStub({
      "odd-name.founders.click": [SPF],
      "emailit._domainkey.founders.click": DKIM("M"),
      "_dmarc.founders.click": ["v=DMARC1; p=none"],
    }),
  });
  t("the declared name is normalised and used",
    report.envelope.domain === "odd-name.founders.click", report.envelope.domain);
  t("no evidence is claimed for a name we were given", report.envelope.evidence.length === 0);
  t("and it passes", report.verdict === "pass", report.findings.join(" | "));
}

console.log("\n=== partial configurations ===");
{
  const spfOnly = await checkSendingDomain("example.com", {
    fetchImpl: dnsStub({ "example.com": [SPF] }),
  });
  t("SPF without DKIM still fails", spfOnly.verdict === "fail");

  const noDmarc = await checkSendingDomain("example.com", {
    dkimSelector: "s1",
    fetchImpl: dnsStub({ "example.com": [SPF], "s1._domainkey.example.com": DKIM("N") }),
  });
  t("SPF+DKIM without DMARC warns rather than fails", noDmarc.verdict === "warn", noDmarc.verdict);

  const revoked = await checkSendingDomain("example.com", {
    dkimSelector: "s1",
    fetchImpl: dnsStub({
      "example.com": ["v=spf1 ~all"],
      "s1._domainkey.example.com": ["v=DKIM1; k=rsa; p="],
      "_dmarc.example.com": ["v=DMARC1; p=reject"],
    }),
  });
  t("revoked DKIM key (empty p=) fails", revoked.verdict === "fail");

  const openSpf = await checkSendingDomain("example.com", {
    dkimSelector: "s1",
    fetchImpl: dnsStub({
      "example.com": ["v=spf1 +all"],
      "s1._domainkey.example.com": DKIM("O"),
      "_dmarc.example.com": ["v=DMARC1; p=none"],
    }),
  });
  t("SPF +all is flagged", openSpf.verdict === "warn", openSpf.verdict);

  // ...including when it is the ENVELOPE's record rather than the apex's.
  const openEnvelopeSpf = await checkSendingDomain("example.com", {
    dkimSelector: "s1",
    returnPathDomain: "bounces.example.com",
    fetchImpl: dnsStub({
      "bounces.example.com": ["v=spf1 +all"],
      "s1._domainkey.example.com": DKIM("P"),
      "_dmarc.example.com": ["v=DMARC1; p=none"],
    }),
  });
  t("+all on the envelope record is flagged too", openEnvelopeSpf.verdict === "warn",
    openEnvelopeSpf.verdict);
}

console.log("\n=== alignment: passing is not aligning ===");
{
  const offOrg = await checkSendingDomain("founders.click", {
    dkimSelector: "emailit",
    returnPathDomain: "bounces.emailit.com",
    fetchImpl: dnsStub({
      "bounces.emailit.com": [SPF],
      "emailit._domainkey.founders.click": DKIM("Q"),
      "_dmarc.founders.click": ["v=DMARC1; p=none"],
    }),
  });
  t("an envelope outside the org domain does not align",
    offOrg.envelope.alignsRelaxed === false);
  t("it warns rather than passing silently", offOrg.verdict === "warn", offOrg.verdict);
  t(
    "the warning names DKIM as the only alignment left",
    offOrg.findings.some((f) => /align.*DKIM|DKIM signature/i.test(f)),
    offOrg.findings.join(" | "),
  );

  const strict = await checkSendingDomain("founders.click", {
    dkimSelector: "emailit",
    fetchImpl: dnsStub(
      {
        "emailit.founders.click": [SPF],
        "emailit._domainkey.founders.click": DKIM("R"),
        "_dmarc.founders.click": ["v=DMARC1; p=reject; aspf=s"],
      },
      { "emailit.founders.click": [BOUNCE_MX] },
    ),
  });
  t("strict SPF alignment against a delegated envelope warns", strict.verdict === "warn",
    strict.verdict);
  t("the warning names aspf=s", strict.findings.some((f) => /aspf=s/i.test(f)),
    strict.findings.join(" | "));
}

console.log("\n=== which domain do we actually send as ===");
{
  t(
    "display-name form is parsed",
    sendingDomainFromEnv({ FROM_EMAIL: "founders.click <noreply@founders.click>" }) ===
      "founders.click",
  );
  t(
    "bare address is parsed",
    sendingDomainFromEnv({ FROM_EMAIL: "noreply@mail.founders.click" }) === "mail.founders.click",
  );
  t(
    "FROM_EMAIL wins over EMAILIT_SENDER_DOMAIN, because it is what is sent",
    sendingDomainFromEnv({
      FROM_EMAIL: "noreply@mail.founders.click",
      EMAILIT_SENDER_DOMAIN: "founders.click",
    }) === "mail.founders.click",
  );
  t(
    "falls back to the configured sender domain",
    sendingDomainFromEnv({ EMAILIT_SENDER_DOMAIN: "founders.click" }) === "founders.click",
  );
  t("no configuration yields null", sendingDomainFromEnv({}) === null);
  t("malformed FROM_EMAIL does not throw", sendingDomainFromEnv({ FROM_EMAIL: "garbage" }) === null);
}

console.log("\n=== the envelope, as configuration knows it ===");
{
  const all = returnPathFromEnv({
    EMAILIT_RETURN_PATH_DOMAIN: "Emailit.Founders.Click.",
    MAIL_FROM: "bounces+abc@em.founders.click",
    EMAILIT_ESP_RETURN_PATH_DOMAIN: "esp.founders.click",
  });
  t("the declared domain is normalised", all.returnPathDomain === "emailit.founders.click",
    String(all.returnPathDomain));
  t("MAIL FROM is reduced to its domain", all.observedReturnPath === "em.founders.click",
    String(all.observedReturnPath));
  t("the ESP value is carried", all.espReturnPath === "esp.founders.click");

  const none = returnPathFromEnv({});
  t("unset yields undefined throughout",
    none.returnPathDomain === undefined && none.observedReturnPath === undefined &&
      none.espReturnPath === undefined);
  t("blank yields undefined",
    returnPathFromEnv({ EMAILIT_RETURN_PATH_DOMAIN: "   " }).returnPathDomain === undefined);
  t("an angle-bracket MAIL FROM is handled",
    returnPathFromEnv({ MAIL_FROM: "Bounces <b@em.example.com>" }).observedReturnPath ===
      "em.example.com");
}

console.log("\n=== resolver failure is not a false all-clear ===");
{
  const broken = (async () => new Response("upstream down", { status: 502 })) as unknown as typeof fetch;
  const report = await checkSendingDomain("founders.click", { fetchImpl: broken });
  t("unresolvable DNS does not report pass", report.verdict !== "pass", report.verdict);
  t("unresolvable DNS is marked indeterminate", report.indeterminate === true);
  t("records read as unknown, not absent", report.spf.status === "unknown", report.spf.status);
  t(
    "finding says the lookup failed rather than the record is missing",
    report.findings.some((f) => /lookup itself failed|not evidence/i.test(f)),
    report.findings.join(" | "),
  );
  t(
    "does not claim records are missing",
    !report.findings.some((f) => /Neither SPF at/i.test(f)),
  );
}

console.log("\n=== a real absence is still reported as absence ===");
{
  const report = await checkSendingDomain("founders.click", { fetchImpl: dnsStub({}) });
  t("answered-but-empty is absent, not unknown", report.spf.status === "absent", report.spf.status);
  t("not marked indeterminate", report.indeterminate === false);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) { console.log("Failed: " + failed.join(", ")); process.exit(1); }

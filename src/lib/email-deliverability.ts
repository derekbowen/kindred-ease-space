/**
 * EMAIL DELIVERABILITY PREFLIGHT.
 *
 * Why this exists: for sixteen months founders.click sent auth email from
 * noreply@founders.click while that domain published no DKIM and no DMARC.
 * EmailIt accepted every send and returned 200. Microsoft and Google then
 * discarded the mail silently — unauthenticated mail from an unverified
 * domain is dropped, not bounced. The result was a platform where every
 * signup dead-ended at "check your email" and nothing anywhere reported a
 * failure, because there was no failure to report: the send genuinely
 * succeeded, the delivery did not.
 *
 * A send API returning 200 is therefore NOT evidence that mail works. The
 * only cheap standing proof is the DNS the receiving world checks.
 *
 * ON CHECKING THE RIGHT NAME. SPF authorises the RFC5321 envelope sender
 * (MAIL FROM / Return-Path), NOT the RFC5322 From header. Every serious ESP
 * delegates the envelope to a subdomain it controls; founders.click's is
 * emailit.founders.click, which carries both the bounce MX and the SPF
 * record. Two opposite mistakes follow from forgetting that, and this module
 * is built to make both impossible:
 *
 *   1. Reading SPF at the apex and calling a miss a failure. That reported a
 *      blocker on a domain which authenticated perfectly well, and cost 22
 *      re-checks of a record that was never required.
 *
 *   2. Reading SPF at the apex, FINDING it, and calling that a pass. Equally
 *      wrong and more dangerous, because it is silent: if the envelope is
 *      emailit.founders.click, an SPF record on founders.click authorises
 *      nothing the receiver will check. An apex record is false comfort.
 *
 * So the envelope domain is resolved FIRST, by explicit precedence, and SPF
 * is evaluated against whatever that resolves to. The presence of an apex SPF
 * record never short-circuits that resolution.
 *
 * Resolution is over DNS-over-HTTPS because this runs inside a Cloudflare
 * Worker, which has no UDP and therefore no ordinary resolver.
 */

const DOH_ENDPOINT = "https://cloudflare-dns.com/dns-query";

/** DKIM selectors worth probing when the operator has not named one. */
const COMMON_DKIM_SELECTORS = [
  "emailit",
  "emailit1",
  "emailit2",
  "default",
  "mail",
  "dkim",
  "k1",
  "s1",
  "s2",
] as const;

/**
 * Labels ESPs commonly use for a delegated return-path (bounce) subdomain.
 * Candidates only — see `qualifies()` for what a candidate must prove.
 */
const COMMON_RETURN_PATH_LABELS = [
  "emailit",
  "em",
  "mail",
  "mailer",
  "mta",
  "smtp",
  "bounce",
  "bounces",
  "pm-bounces",
  "mg",
  "ses",
] as const;

/**
 * MX targets that identify a bounce host rather than an ordinary mailbox
 * server. Matching one raises confidence in a heuristic pick; it is never
 * required, and never sufficient on its own.
 */
const KNOWN_BOUNCE_HOSTS: RegExp[] = [
  /^feedback-smtp\./i,
  /(^|\.)emailit\.com$/i,
  /(^|\.)amazonses\.com$/i,
  /(^|\.)pm-bounces\./i,
  /(^|\.)mailgun\.org$/i,
  /(^|\.)sendgrid\.net$/i,
  /(^|\.)mtasv\.net$/i,
];

export type RecordCheck = {
  /**
   * present — the record exists.
   * absent  — the resolver answered, and there is no such record.
   * unknown — the lookup itself failed. NOT the same as absent: a gate that
   *           reports a missing record when it simply could not ask sends the
   *           operator to fix DNS that may already be correct.
   */
  status: "present" | "absent" | "unknown";
  present: boolean;
  /** The record's value, when present. Never contains a secret — DNS is public. */
  value?: string;
  /** Populated when a record is present but unusable, or when the lookup failed. */
  problem?: string;
  /**
   * The name the record was actually found on, when that is not the sending
   * domain itself. Set for SPF read at a delegated envelope domain.
   */
  foundOn?: string;
};

/**
 * How the envelope domain was established, in precedence order. The first one
 * that yields a name wins; nothing later is consulted.
 *
 * configured — EMAILIT_RETURN_PATH_DOMAIN, set by the operator.
 * observed   — a MAIL FROM / Return-Path actually seen on sent mail.
 * esp        — the return path the provider reports for this sending domain.
 * discovered — found by probing DNS. Must prove itself; see `qualifies()`.
 * apex       — nothing delegated the envelope, so it is the sending domain.
 */
export type EnvelopeSource = "configured" | "observed" | "esp" | "discovered" | "apex";

export type EnvelopeDomain = {
  domain: string;
  source: EnvelopeSource;
  /** The bounce host its MX points at, when it has one. */
  mx: string | null;
  /** Its SPF record, when it publishes one. */
  spf: string | null;
  /** True when the SPF lookup against this name failed rather than answered. */
  spfLookupFailed?: boolean;
  /** What supported a heuristic pick. Empty for a name given to us. */
  evidence: string[];
  /**
   * True when the envelope domain sits inside the sending domain's
   * organisational domain, which is what DMARC relaxed SPF alignment (the
   * default, and what aspf=r means) requires.
   */
  alignsRelaxed: boolean;
};

export type DeliverabilityReport = {
  domain: string;
  /** The envelope domain SPF was evaluated against. Never assumed to be the apex. */
  envelope: EnvelopeDomain;
  /** SPF **at the envelope domain**. This is the one that decides the verdict. */
  spf: RecordCheck;
  /**
   * SPF at the sending domain itself, reported separately and always read.
   * When the envelope is delegated this record authorises nothing a receiver
   * checks — it is recorded so an operator can see that, not so it can pass.
   */
  apexSpf: RecordCheck;
  dkim: RecordCheck & { selector?: string };
  dmarc: RecordCheck;
  /**
   * A name that looks like a return path (bounce MX, ESP hostname) but
   * publishes no SPF, so it could not be selected. Usually the real problem.
   */
  suspectEnvelope?: { domain: string; mx: string | null; why: string };
  /**
   * pass    — mail from this domain authenticates; delivery is plausible.
   * warn    — it will authenticate, but something is set up to fail later.
   * fail    — mail will be dropped or junked. Do not expect anything to arrive.
   */
  verdict: "pass" | "warn" | "fail";
  /**
   * True when a lookup failed rather than answered. The verdict is still
   * "fail" (we cannot assert mail works), but the cause is an unreachable
   * resolver, not absent records — never print DNS fix instructions for it.
   */
  indeterminate?: boolean;
  /** Operator-facing lines explaining the verdict. Safe to display. */
  findings: string[];
  checkedAt: string;
};

type DohAnswer = { name: string; type: number; data: string };

async function queryDoh(
  name: string,
  type: "TXT" | "MX",
  fetchImpl: typeof fetch,
): Promise<DohAnswer[]> {
  const url = `${DOH_ENDPOINT}?name=${encodeURIComponent(name)}&type=${type}`;
  const res = await fetchImpl(url, { headers: { accept: "application/dns-json" } });
  if (!res.ok) throw new Error(`DoH ${res.status} for ${name}`);
  const body = (await res.json()) as { Answer?: DohAnswer[] };
  return body.Answer ?? [];
}

async function resolveTxtOverHttps(name: string, fetchImpl: typeof fetch): Promise<string[]> {
  return (await queryDoh(name, "TXT", fetchImpl))
    .filter((a) => a.type === 16)
    // DoH returns TXT quoted, and long records arrive split into chunks.
    .map((a) => a.data.replace(/^"|"$/g, "").replace(/"\s+"/g, ""));
}

async function resolveMxOverHttps(name: string, fetchImpl: typeof fetch): Promise<string[]> {
  return (await queryDoh(name, "MX", fetchImpl))
    .filter((a) => a.type === 15)
    // "10 feedback-smtp.ffdc-1.emailit.com." — priority, then the exchange.
    .map((a) => a.data.trim().split(/\s+/).slice(1).join(" ").replace(/\.$/, ""))
    .filter(Boolean);
}

/**
 * Resolve a record, preferring the platform resolver when there is one.
 *
 * A Worker has no UDP and must use DoH. CI runners and laptops do have a
 * resolver, and reaching for it first means the preflight keeps working from
 * networks where outbound DoH is blocked — which is exactly the situation
 * where a false "record missing" would be most misleading.
 *
 * Throws when the name cannot be resolved at all; returns [] for a name that
 * resolves with no records of that type.
 */
async function resolveVia<T>(
  node: () => Promise<T[]>,
  https: () => Promise<T[]>,
  usingStub: boolean,
): Promise<T[]> {
  if (!usingStub) {
    try {
      try {
        return await node();
      } catch (err: any) {
        // NXDOMAIN / NODATA are answers, not failures: the name has no record.
        if (err?.code === "ENOTFOUND" || err?.code === "ENODATA") return [];
        throw err;
      }
    } catch (err: any) {
      // Only fall through to DoH when the module itself is unavailable
      // (a Worker); a genuine resolver error must not be masked.
      if (err?.code && err.code !== "ERR_MODULE_NOT_FOUND") throw err;
    }
  }
  return https();
}

async function resolveTxt(name: string, fetchImpl?: typeof fetch): Promise<string[]> {
  return resolveVia(
    async () => {
      const dns = await import("node:dns/promises");
      const chunks = await dns.resolveTxt(name);
      return chunks.map((parts) => parts.join(""));
    },
    () => resolveTxtOverHttps(name, fetchImpl ?? fetch),
    Boolean(fetchImpl),
  );
}

async function resolveMx(name: string, fetchImpl?: typeof fetch): Promise<string[]> {
  return resolveVia(
    async () => {
      const dns = await import("node:dns/promises");
      const mx = await dns.resolveMx(name);
      return mx.map((m) => m.exchange);
    },
    () => resolveMxOverHttps(name, fetchImpl ?? fetch),
    Boolean(fetchImpl),
  );
}

const spfIn = (records: string[]): string | undefined =>
  records.find((t) => t.toLowerCase().startsWith("v=spf1"));

const normaliseName = (raw: string | undefined | null): string | undefined => {
  const n = raw?.trim().toLowerCase().replace(/\.$/, "");
  return n ? n : undefined;
};

/**
 * Is `candidate` inside `domain`'s organisational domain? That is what DMARC
 * relaxed alignment (the default, and what aspf=r means) requires of the
 * SPF-authenticated domain.
 */
const underOrgDomain = (candidate: string, domain: string): boolean =>
  candidate === domain || candidate.endsWith(`.${domain}`);

type Probe = { domain: string; mx: string[]; spf?: string; spfLookupFailed: boolean };

async function probe(name: string, fetchImpl?: typeof fetch): Promise<Probe> {
  let mx: string[] = [];
  try {
    mx = await resolveMx(name, fetchImpl);
  } catch {
    // An MX we cannot read is supporting evidence we simply do not have. It
    // never decides anything on its own, so a failure here is not fatal.
  }
  let spf: string | undefined;
  let spfLookupFailed = false;
  try {
    spf = spfIn(await resolveTxt(name, fetchImpl));
  } catch {
    spfLookupFailed = true;
  }
  return { domain: name, mx, spf, spfLookupFailed };
}

const looksLikeBounceHost = (host: string): boolean =>
  KNOWN_BOUNCE_HOSTS.some((re) => re.test(host));

/**
 * Does a GUESSED candidate prove itself?
 *
 * SPF is REQUIRED: without it there is nothing to evaluate, and picking such
 * a name would only move the false negative somewhere new.
 *
 * MX is NOT required. It is supporting evidence, and deliberately not the
 * only kind: an ESP can delegate a return path whose MX we cannot read, or
 * which is published on a CNAME target. Requiring it universally would make
 * this EmailIt-shaped rather than correct. What IS required is that something
 * beyond a bare SPF record ties the name to mail — otherwise any subdomain
 * carrying an SPF record would be mistaken for the envelope, which is the
 * same class of error in the opposite direction.
 *
 * Accepted supporting evidence, any one of which suffices:
 *   - an MX record (the name receives mail, consistent with bounce handling);
 *   - the label matches the provider's DKIM selector (ESPs name the return
 *     path with the label they sign with — emailit.founders.click is this).
 *
 * An MX matching a known bounce-host pattern is recorded as additional
 * confidence, never as the qualifying signal on its own.
 */
function qualifies(p: Probe, label: string, dkimSelector?: string): string[] | null {
  if (!p.spf) return null;
  const evidence: string[] = [];
  if (p.mx.length > 0) evidence.push(`MX ${p.mx[0]}`);
  if (p.mx.some(looksLikeBounceHost)) evidence.push("MX matches a known bounce-host pattern");
  if (dkimSelector && label === dkimSelector.trim().toLowerCase()) {
    evidence.push(`label matches the DKIM selector "${dkimSelector}"`);
  }
  // SPF plus nothing else is a subdomain with an SPF record, not an envelope.
  if (evidence.length === 0) return null;
  return evidence;
}

/**
 * Probe the guessed candidates and return the first that qualifies, plus the
 * most convincing near-miss (a bounce-looking name with no SPF), which is
 * usually the actual misconfiguration.
 */
async function discoverEnvelope(
  domain: string,
  opts: { dkimSelector?: string; fetchImpl?: typeof fetch },
): Promise<{ found?: { probe: Probe; evidence: string[] }; suspect?: Probe }> {
  const selectorLabel = normaliseName(opts.dkimSelector);
  const labels = [...(selectorLabel ? [selectorLabel] : []), ...COMMON_RETURN_PATH_LABELS];

  const seen = new Set<string>();
  const ordered = labels.filter((l) => !seen.has(l) && (seen.add(l), true));

  // One round trip rather than a dozen: the candidates are independent.
  const probes = await Promise.all(ordered.map((l) => probe(`${l}.${domain}`, opts.fetchImpl)));

  let suspect: Probe | undefined;
  for (let i = 0; i < probes.length; i++) {
    const p = probes[i]!;
    const evidence = qualifies(p, ordered[i]!, opts.dkimSelector);
    if (evidence) return { found: { probe: p, evidence }, suspect };
    // Near-miss worth reporting: it behaves like a return path but publishes
    // no SPF, so mail sent through it fails SPF outright.
    if (!suspect && !p.spf && p.mx.some(looksLikeBounceHost)) suspect = p;
  }
  return { suspect };
}

/**
 * Resolve the envelope domain by precedence, then read SPF there.
 *
 * The apex is the LAST resort, reached only when nothing delegated the
 * envelope. An SPF record on the apex is never a reason to stop looking.
 */
async function resolveEnvelope(
  domain: string,
  apex: Probe,
  opts: {
    returnPathDomain?: string;
    observedReturnPath?: string;
    espReturnPath?: string;
    dkimSelector?: string;
    fetchImpl?: typeof fetch;
  },
): Promise<{ envelope: EnvelopeDomain; suspect?: Probe }> {
  const build = (p: Probe, source: EnvelopeSource, evidence: string[]): EnvelopeDomain => ({
    domain: p.domain,
    source,
    mx: p.mx[0] ?? null,
    spf: p.spf ?? null,
    spfLookupFailed: p.spfLookupFailed,
    evidence,
    alignsRelaxed: underOrgDomain(p.domain, domain),
  });

  // 1-3: a name we were given. Taken on the giver's authority — including
  // when it turns out to publish no SPF, which is a real finding about the
  // real envelope rather than a reason to look elsewhere.
  const given: Array<[string | undefined, EnvelopeSource]> = [
    [normaliseName(opts.returnPathDomain), "configured"],
    [normaliseName(opts.observedReturnPath), "observed"],
    [normaliseName(opts.espReturnPath), "esp"],
  ];
  for (const [name, source] of given) {
    if (!name) continue;
    const p = name === apex.domain ? apex : await probe(name, opts.fetchImpl);
    return { envelope: build(p, source, []) };
  }

  // 4: heuristic discovery. Runs whether or not the apex publishes SPF.
  const { found, suspect } = await discoverEnvelope(domain, {
    dkimSelector: opts.dkimSelector,
    fetchImpl: opts.fetchImpl,
  });
  if (found) return { envelope: build(found.probe, "discovered", found.evidence), suspect };

  // 5: nothing delegated the envelope, so the apex is the envelope.
  return { envelope: build(apex, "apex", []), suspect };
}

function toRecordCheck(spf: string | undefined, lookupFailed: boolean): RecordCheck {
  if (lookupFailed) {
    return { status: "unknown", present: false, problem: "lookup failed" };
  }
  if (!spf) return { status: "absent", present: false };
  const check: RecordCheck = { status: "present", present: true, value: spf };
  // "+all" authorises the entire internet, which is the same as no SPF for
  // anti-abuse purposes and is treated as a failure by some receivers.
  if (/[+]all\b/.test(spf)) {
    check.problem = 'ends in "+all", which authorises every sender on the internet';
  }
  return check;
}

/**
 * Read the authentication records the receiving world will check for `domain`.
 *
 * `dkimSelector` skips the guesswork when the provider's selector is known;
 * otherwise a short list of common selectors is probed. A miss there is
 * reported as "not found", never as "absent" — an unprobed selector may exist.
 *
 * The envelope options take precedence over each other in the order listed on
 * `EnvelopeSource`. Supplying any of them disables discovery entirely.
 */
export async function checkSendingDomain(
  domain: string,
  opts: {
    dkimSelector?: string;
    /** EMAILIT_RETURN_PATH_DOMAIN — the operator's declaration. */
    returnPathDomain?: string;
    /** A MAIL FROM / Return-Path actually observed on sent mail. */
    observedReturnPath?: string;
    /** The return path the provider reports for this sending domain. */
    espReturnPath?: string;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<DeliverabilityReport> {
  // Deliberately not defaulted: an undefined impl means "use the platform
  // resolver if there is one", which resolveTxt handles.
  const fetchImpl = opts.fetchImpl;
  const findings: string[] = [];

  const dkim: RecordCheck & { selector?: string } = { status: "absent", present: false };
  const dmarc: RecordCheck = { status: "absent", present: false };

  // The apex is always read — as the last-resort envelope, and so an operator
  // can see an apex record that authorises nothing a receiver checks.
  const apex = await probe(domain, fetchImpl);
  const apexSpf = toRecordCheck(apex.spf, apex.spfLookupFailed);

  const { envelope, suspect } = await resolveEnvelope(domain, apex, {
    returnPathDomain: opts.returnPathDomain,
    observedReturnPath: opts.observedReturnPath,
    espReturnPath: opts.espReturnPath,
    dkimSelector: opts.dkimSelector,
    fetchImpl,
  });

  const spf = toRecordCheck(envelope.spf ?? undefined, Boolean(envelope.spfLookupFailed));
  if (envelope.domain !== domain) spf.foundOn = envelope.domain;

  // --- DKIM: cryptographically signs the message --------------------------
  const selectors = opts.dkimSelector ? [opts.dkimSelector] : [...COMMON_DKIM_SELECTORS];
  let dkimLookupError: string | undefined;
  for (const selector of selectors) {
    try {
      const txt = await resolveTxt(`${selector}._domainkey.${domain}`, fetchImpl);
      const record = txt.find((t) => t.toLowerCase().includes("v=dkim1") || t.includes("p="));
      if (record) {
        dkim.status = "present";
        dkim.present = true;
        dkim.selector = selector;
        // The public key itself is not worth echoing back; length is enough
        // to distinguish a real key from a revoked (p=) placeholder.
        dkim.value = `v=DKIM1 (${record.length} chars)`;
        if (/[;\s]p=\s*(?:;|$)/.test(record)) {
          dkim.problem = `selector "${selector}" publishes an empty key (p=), which revokes it`;
        }
        break;
      }
    } catch (err) {
      // A selector that does not resolve is the normal case for all but one,
      // so this is only notable if every probe errored rather than answered.
      dkimLookupError = err instanceof Error ? err.message : String(err);
    }
  }
  if (!dkim.present && dkimLookupError) {
    dkim.status = "unknown";
    dkim.problem = `lookup failed: ${dkimLookupError}`;
  }

  // --- DMARC: tells receivers what to do when the above fail --------------
  try {
    const txt = await resolveTxt(`_dmarc.${domain}`, fetchImpl);
    const record = txt.find((t) => t.toLowerCase().startsWith("v=dmarc1"));
    if (record) {
      dmarc.status = "present";
      dmarc.present = true;
      dmarc.value = record;
    }
  } catch (err) {
    dmarc.status = "unknown";
    dmarc.problem = `lookup failed: ${err instanceof Error ? err.message : String(err)}`;
  }

  const suspectEnvelope = suspect
    ? {
        domain: suspect.domain,
        mx: suspect.mx[0] ?? null,
        why: "has a bounce-host MX but publishes no SPF record",
      }
    : undefined;

  const base = { domain, envelope, spf, apexSpf, dkim, dmarc, suspectEnvelope };

  // --- Verdict ------------------------------------------------------------
  let verdict: DeliverabilityReport["verdict"] = "pass";

  // A lookup that never got an answer is reported as its own state. It still
  // blocks (we cannot claim mail works), but it must not read as "your DNS is
  // missing" — that sends the operator to re-add records that may be fine.
  const indeterminate =
    spf.status === "unknown" || dkim.status === "unknown" || dmarc.status === "unknown";
  if (indeterminate) {
    const which = [
      spf.status === "unknown" ? "SPF" : null,
      dkim.status === "unknown" ? "DKIM" : null,
      dmarc.status === "unknown" ? "DMARC" : null,
    ].filter(Boolean);
    return {
      ...base,
      verdict: "fail",
      indeterminate: true,
      findings: [
        `Could not resolve ${which.join(", ")} for ${domain} — the DNS lookup itself failed, ` +
          `so this is not evidence that the records are missing. Re-run from a network that ` +
          `can resolve DNS before changing anything.`,
        ...[spf.problem, dkim.problem, dmarc.problem].filter((p): p is string => !!p),
      ],
      checkedAt: new Date().toISOString(),
    };
  }

  const where =
    envelope.source === "apex"
      ? `${domain} (the envelope is not delegated)`
      : `${envelope.domain} (envelope, ${envelope.source})`;

  if (!spf.present && !dkim.present) {
    verdict = "fail";
    findings.push(
      `Neither SPF at ${where} nor DKIM at ${domain} is published. Mail sent as this ` +
        `domain will be discarded by Gmail and Microsoft, usually without a bounce. ` +
        `Nothing will arrive.`,
    );
  } else {
    if (!spf.present) {
      verdict = "fail";
      findings.push(
        `No SPF record at ${where}. Receivers check SPF against the envelope sender, ` +
          `so this is the record that decides the SPF leg.`,
      );
    }
    if (!dkim.present) {
      verdict = "fail";
      findings.push(
        opts.dkimSelector
          ? `No DKIM key at "${opts.dkimSelector}._domainkey.${domain}".`
          : `No DKIM key found at any common selector (${COMMON_DKIM_SELECTORS.join(", ")}). ` +
            `If the provider uses a different selector, pass it explicitly before trusting this.`,
      );
    }
  }

  // The false-comfort case, stated explicitly: an apex record that authorises
  // nothing a receiver will check, next to an envelope that has none.
  if (!spf.present && apexSpf.present && envelope.source !== "apex") {
    findings.push(
      `${domain} does publish SPF, but the envelope sender is ${envelope.domain}, so that ` +
        `record authorises nothing receivers check. It is not a substitute for SPF on ` +
        `${envelope.domain}.`,
    );
  }

  // SPF on a delegated envelope is the normal ESP arrangement, not a
  // shortfall — say so plainly, because the opposite reading is what made an
  // earlier version of this check raise a blocker over nothing.
  if (spf.present && envelope.source !== "apex") {
    const via = envelope.evidence.length ? `; ${envelope.evidence.join("; ")}` : "";
    findings.push(
      `SPF is published on ${envelope.domain}, the envelope sender (${envelope.source}${via}), ` +
        `not on ${domain}. That is where it belongs: SPF authenticates the envelope, and ` +
        `${domain} is only the From header. No SPF record is required on ${domain} itself` +
        `${apexSpf.present ? ", though one is published" : ""}.`,
    );
  }

  if (spf.problem) {
    verdict = verdict === "fail" ? "fail" : "warn";
    findings.push(`SPF: ${spf.problem}`);
  }
  if (dkim.problem) {
    verdict = "fail";
    findings.push(`DKIM: ${dkim.problem}`);
  }

  // A name that behaves like a return path but publishes no SPF is usually
  // the real misconfiguration, even when something else satisfied the check.
  if (suspectEnvelope) {
    verdict = verdict === "fail" ? "fail" : "warn";
    findings.push(
      `${suspectEnvelope.domain} ${suspectEnvelope.why} (MX ${suspectEnvelope.mx}). If mail ` +
        `actually leaves with that envelope, the SPF leg fails regardless of what ` +
        `${envelope.domain} publishes.`,
    );
  }

  // Alignment: SPF passing is not the same as SPF aligning for DMARC.
  if (spf.present && envelope.source !== "apex") {
    if (!envelope.alignsRelaxed) {
      verdict = verdict === "fail" ? "fail" : "warn";
      findings.push(
        `The envelope ${envelope.domain} is outside ${domain}, so the SPF leg cannot align ` +
          `for DMARC under any policy. DMARC will pass only on the DKIM signature — confirm ` +
          `the provider signs with d=${domain}.`,
      );
    } else if (dmarc.present && /aspf\s*=\s*s/i.test(dmarc.value ?? "")) {
      verdict = verdict === "fail" ? "fail" : "warn";
      findings.push(
        `DMARC sets aspf=s (strict), but the envelope is ${envelope.domain} rather than ` +
          `${domain}, so the SPF leg will not align. Either relax it to aspf=r or rely on ` +
          `DKIM alone for DMARC.`,
      );
    }
  }

  if (!dmarc.present && verdict !== "fail") {
    verdict = "warn";
    findings.push(
      `${domain} publishes no DMARC policy. Gmail and Microsoft require one from bulk ` +
        `senders; without it delivery degrades over time even when SPF and DKIM pass.`,
    );
  } else if (!dmarc.present) {
    findings.push(`${domain} publishes no DMARC policy.`);
  }

  if (verdict === "pass" && findings.length === 0) {
    findings.push(`${domain} authenticates: SPF, DKIM and DMARC all present.`);
  }

  return { ...base, verdict, indeterminate: false, findings, checkedAt: new Date().toISOString() };
}

/**
 * The domain mail is actually sent as — parsed from the same env the sender
 * uses, so this checks reality rather than an assumption.
 *
 * Accepts both `user@example.com` and `Display Name <user@example.com>`.
 */
export function sendingDomainFromEnv(env: {
  FROM_EMAIL?: string;
  EMAILIT_SENDER_DOMAIN?: string;
}): string | null {
  const from = env.FROM_EMAIL?.trim();
  if (from) {
    const match = from.match(/<([^>]+)>/);
    const address = (match ? match[1] : from).trim();
    const at = address.lastIndexOf("@");
    if (at > -1 && at < address.length - 1) return address.slice(at + 1).toLowerCase();
  }
  const configured = env.EMAILIT_SENDER_DOMAIN?.trim();
  return configured ? configured.toLowerCase() : null;
}

/**
 * The envelope domain as configuration knows it, in precedence order. Each is
 * a domain, or an address whose domain part is taken — MAIL_FROM in
 * particular is naturally written as an address.
 */
export function returnPathFromEnv(env: {
  EMAILIT_RETURN_PATH_DOMAIN?: string;
  MAIL_FROM?: string;
  EMAILIT_ESP_RETURN_PATH_DOMAIN?: string;
}): {
  returnPathDomain?: string;
  observedReturnPath?: string;
  espReturnPath?: string;
} {
  const asDomain = (raw?: string): string | undefined => {
    const v = raw?.trim();
    if (!v) return undefined;
    const inner = v.match(/<([^>]+)>/)?.[1]?.trim() ?? v;
    const at = inner.lastIndexOf("@");
    const host = at > -1 && at < inner.length - 1 ? inner.slice(at + 1) : inner;
    return normaliseName(host);
  };
  return {
    returnPathDomain: asDomain(env.EMAILIT_RETURN_PATH_DOMAIN),
    observedReturnPath: asDomain(env.MAIL_FROM),
    espReturnPath: asDomain(env.EMAILIT_ESP_RETURN_PATH_DOMAIN),
  };
}

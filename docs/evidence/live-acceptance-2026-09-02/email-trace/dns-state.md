# Email trace — Task B: DNS and sending-domain state for founders.click

Recorded 2026-09-05 05:58–06:03 UTC. All lookups via DNS-over-HTTPS
(`https://cloudflare-dns.com/dns-query`, `accept: application/dns-json`); the
five load-bearing records were re-queried through a second resolver
(`https://dns.google/resolve`) and agree. Every raw response is saved verbatim
in `dns-raw/<name>__<type>.json` (Cloudflare) and `dns-raw/google-doh__*.json`
(Google). Provider documentation extracts are in `dns-raw/emailit-docs-extract.md`.

Scope: what public DNS says, what EmailIt documents as required, and whether
SPF/DKIM/DMARC would pass for `From: founders.click <noreply@founders.click>`
(the default in `src/lib/email.server.ts:90`). This task cannot see the EmailIt
dashboard, the EmailIt API (no key), or Worker logs; where a conclusion needs
those, it says so.

## 0. Headline

| # | Finding | Confidence |
|---|---|---|
| 1 | **Every DNS record EmailIt documents as *required* for a sending domain named `founders.click` is present and correctly formed**: SPF TXT + feedback MX at `emailit.founders.click`, DKIM TXT at `emailit._domainkey.founders.click` (valid 2048-bit RSA key), plus the optional DMARC at `_dmarc.founders.click`. Public DNS is **not** the reason nothing is delivered. | High (records) / Medium-high (interpretation, see #6) |
| 2 | For mail from `noreply@founders.click` via EmailIt, **SPF passes and is DMARC-aligned (relaxed)**, **DKIM passes and is aligned (strict)**, **DMARC passes** — provided EmailIt actually signs with `d=founders.click` and uses `emailit.founders.click` as MAIL FROM, which is exactly what its DNS layout implies. Gmail's "SPF or DKIM" (all senders) and "SPF + DKIM + DMARC + aligned From" (bulk) requirements are met on the DNS side; EmailIt's sending IPs have forward-confirmed PTRs. | Medium-high |
| 3 | The apex `founders.click` has **no SPF TXT and no MX**. The missing apex SPF is *not* an EmailIt requirement (EmailIt puts SPF on the `emailit.` subdomain) and is not what blocks delivery; it is a posture gap only. The missing MX, however, means **`support@founders.click` cannot receive mail**: the staff-notification email (`src/lib/help.server.ts:389`) and every `Reply-To: support@founders.click` (`help.server.ts:404`, `help-tickets.functions.ts:165`, `email-templates.functions.ts:173`) point at a dead address unless `SUPPORT_INBOX_EMAIL` is overridden in the Worker. | High (DNS) / Medium (env unknown) |
| 4 | `go.emailitmail.com.founders.click MX 10 inbound.emailitmail.com` is an operator paste error: the *value* of EmailIt's optional tracking CNAME (`go.emailitmail.com`) was typed into the Name field of EmailIt's optional inbound MX (`inbound.emailitmail.com`). The intended record was `inbound.founders.click MX 10 inbound.emailitmail.com`. It is inert for outbound mail and cannot explain non-delivery. | High |
| 5 | `go.founders.click` is a **Cloudflare-proxied** CNAME to EmailIt's tracking host `go.emailitmail.com` (HTTPS through it returns EmailIt's exact 3-byte body `:-)` behind `via: 1.1 Caddy`). Because it is proxied, public DNS shows Cloudflare A records rather than a CNAME, so EmailIt's DNS check for tracking will report `missing`. Optional feature; not a verification blocker. | High |
| 6 | The only DNS-consistent ways this could still be a "domain" problem are on EmailIt's side and invisible here: (a) the domain was never marked verified in the workspace ("Check DNS" never run / stuck), or (b) the domain was created in EmailIt under a different name than `founders.click`. EmailIt's docs are internally inconsistent about where the SPF/MX go relative to the domain name, so the observed records fit either `founders.click` (per the Creating-a-Domain guide) or `emailit.founders.click` (per one API sample). If (b), EmailIt rejects every send with HTTP 422 `From/Sender domain is not valid or not verified` (status code per `provider-docs.md` §5), and the hook swallows it (`auth-send-email.ts:89-98`). Discriminator: `GET https://api.emailit.com/v2/domains` — the `name`, `verified_at`, `spf_status`, `dkim_status`, `mx_status`, `return_path_status` fields. | Medium |
| 7 | Scope limit: DNS/sending-domain state only matters for sends that actually reach EmailIt. `tail-observations.md` shows the 05:59:28Z signup produced **zero** requests to this Worker's hook, so the auth-confirmation path may not touch EmailIt (or this DNS) at all; the support-ticket receipt path (`help.server.ts` → `sendEmail()`) does. | High (as a bound on this task) |

## 1. Full record dump

Legend: `NOERROR/empty` = name exists in the zone but has no record of that
type; `NXDOMAIN` = name does not exist at all. Zone is on Cloudflare
(`NS anna.ns.cloudflare.com`, `max.ns.cloudflare.com`; SOA serial
`2413555945`, SOA TTL 1800). Resolver: Cloudflare DoH unless marked `[G]`
(Google DoH cross-check).

### 1.1 Apex `founders.click`

| Type | Result | Exact value | TTL |
|---|---|---|---|
| TXT | **NOERROR/empty — no TXT at apex (no SPF, no verification strings)** [G agrees] | — | — |
| MX | **NOERROR/empty — no MX (domain cannot receive mail)** [G agrees] | — | — |
| A | 2 answers | `104.21.75.79`, `172.67.217.144` (Cloudflare proxy anycast) | 300 |
| AAAA | 2 answers | `2606:4700:3030::ac43:d990`, `2606:4700:3031::6815:4b4f` | 300 |
| NS | 2 answers | `anna.ns.cloudflare.com.`, `max.ns.cloudflare.com.` | 86400 |
| SOA | 1 | `anna.ns.cloudflare.com. dns.cloudflare.com. 2413555945 10000 2400 604800 1800` | 1800 |
| CAA | NOERROR/empty | — | — |

### 1.2 DMARC `_dmarc.founders.click`

| Type | Result | Exact value | TTL |
|---|---|---|---|
| TXT | 1 answer [G agrees] | `v=DMARC1; p=none;` | 300 |
| CNAME | NOERROR/empty | — | — |

Parse: valid DMARC1; `p=none` (monitor only, no enforcement); no `sp=`, so
subdomains inherit `none`; no `rua=`/`ruf=` — **nobody receives aggregate
reports**; `adkim`/`aspf` absent → both default to **relaxed** alignment;
`pct` default 100. Matches EmailIt's suggested optional value byte-for-byte
(`"v=DMARC1; p=none;"` in the API sample).

### 1.3 DKIM `emailit._domainkey.founders.click`

| Type | Result | TTL |
|---|---|---|
| TXT | 1 answer, served as two quoted strings (255 + remainder; receivers concatenate) [G returns it joined] | 300 |
| CNAME | NOERROR/empty | — |

Full record (concatenated):

```
v=DKIM1; t=s; h=sha256; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAxsHzFSsAfyb8sP3GxJwuxxDJQH4gAV9r9SJrVqZkYWE2PuhsI26aHiecaBhPEySVu8sdpdBMuyTQW8GuDk34xn+No9szFWvdAsW/myUyPnLRX4M+O3C87hN250jboLtdM7qKkYv1m6Uz+oIGznZaLeO4zZYJv01XwLAQmz0Ht5z77ii+vzyVFUdPuwWJ8EijlqrxVoc5HlFkRe6fMFBt5xNRTh/2I81t6YVzOsZ+2HcOnMLTGCnj6YZkAUrPFqOcqU3QwSkYmPG1ZFNyGiBUMCouE47Qt+Yv/NFkCM0AbU2fiBNjJqVZPFJ4E+f7MUEDJ79BxhNUHoJA2sK/RqWokQIDAQAB;
```

Tags: `v=DKIM1`; **`t=s`** = strict identity: the signature's `i=` domain must
equal `d=` exactly (no sub-domain identities) — harmless when EmailIt signs
`d=founders.click`; **`h=sha256`** = only SHA-256 hashes accepted (rsa-sha256
is what every modern signer uses); no `t=y` (not test mode); no `k=` (defaults
rsa). Key check: `openssl rsa -pubin -text` on the `p=` value decodes cleanly
as **RSA 2048-bit** (`Public-Key: (2048 bit)`, modulus begins
`00:c6:c1:f3:15:2b:00:7f:26...`), base64 length 392. The tag layout
`v=DKIM1; t=s; h=sha256; p=…;` is identical to the record EmailIt's own API
sample emits, so this key was generated by EmailIt for this domain.
`default._domainkey.founders.click` → NXDOMAIN (no other selector).

### 1.4 `www.founders.click`

| Type | Result | Exact value |
|---|---|---|
| CNAME | NOERROR/empty (proxied records never expose a CNAME) | — |
| A | `172.67.217.144`, `104.21.75.79` (same Cloudflare pair as apex; served by the `founders-click` Worker per `docs/DEPLOYMENT.md`) | TTL 300 |
| AAAA | `2606:4700:3030::ac43:d990`, `2606:4700:3031::6815:4b4f` | TTL 300 |

### 1.5 Return-path / EmailIt-style subdomain candidates

| Name | TXT | CNAME | MX | A | Verdict |
|---|---|---|---|---|---|
| **`emailit.founders.click`** | **`v=spf1 include:_spf.emailit.com ~all`** [G agrees] | empty | **`10 feedback-smtp.ffdc-1.emailit.com.`** [G agrees] | empty (AAAA empty too) | **This is EmailIt's return-path ("email feedback") subdomain — present and correct** |
| `go.founders.click` | empty | empty (masked by proxy) | empty | `104.21.75.79`, `172.67.217.144` (Cloudflare proxy) | Proxied CNAME to `go.emailitmail.com` (EmailIt tracking host) — see §5 |
| `em.founders.click` | NXDOMAIN | NXDOMAIN | NXDOMAIN | NXDOMAIN | absent |
| `mail.founders.click` | NXDOMAIN | NXDOMAIN | NXDOMAIN | NXDOMAIN | absent |
| `send.founders.click` | NXDOMAIN | NXDOMAIN | NXDOMAIN | NXDOMAIN | absent |
| `bounce.founders.click` / `bounces.` | NXDOMAIN | NXDOMAIN | NXDOMAIN | NXDOMAIN | absent |
| `mta.founders.click` | NXDOMAIN | NXDOMAIN | NXDOMAIN | NXDOMAIN | absent |
| `tr.founders.click` (EmailIt's documented tracking name) | NXDOMAIN | NXDOMAIN | — | NXDOMAIN | absent (tracking was created as `go` instead) |
| `inbound.founders.click` (EmailIt's documented inbound name) | — | NXDOMAIN | NXDOMAIN | NXDOMAIN | absent (see malformed record) |
| `track.` / `click.` | — | NXDOMAIN | — | — | absent |
| `_dmarc.emailit.founders.click` | NXDOMAIN | — | — | — | none (policy discovery falls back to `_dmarc.founders.click`, fine) |

### 1.6 The malformed record `go.emailitmail.com.founders.click`

| Type | Result | Exact value | TTL |
|---|---|---|---|
| **MX** | 1 answer [G agrees] | **`10 inbound.emailitmail.com.`** | 300 |
| TXT | NOERROR/empty | — | — |
| CNAME | NOERROR/empty | — | — |
| A / AAAA | NOERROR/empty | — | — |
| NS | NOERROR/empty | — | — |
| ANY | refused by resolver (`EDE(21): Not Supported`) | — | — |

`NOERROR` (not `NXDOMAIN`) on the other types proves the name exists in the
zone with the MX as its only record. Interpretation in §5.

### 1.7 Other names in the zone that matter for the email story

| Name | Type | Value | Note |
|---|---|---|---|
| `_lovable.founders.click` | TXT | `lovable_verify=39e8c39c92e8ca4b7c9f4123ce2af10f070ea70cce072ba421245b9afc0fbfcc` | Lovable-era ownership proof (TTL 3600) |
| `_lovable-email.founders.click` | TXT | NXDOMAIN | Listed in `docs/DEPLOYMENT.md:134` as present — it is gone |
| `notify.www.founders.click` | NS | `ns5.lovable.cloud.`, `ns6.lovable.cloud.` | Delegated to Lovable |
| `notify.www.founders.click` | MX | `10 mxa.eu.mailgun.org.`, `10 mxb.eu.mailgun.org.` | Lovable's Mailgun notification subdomain — a *second, legacy* sending domain unrelated to EmailIt |
| `_mta-sts.founders.click`, `_smtp._tls.founders.click` | TXT | NXDOMAIN | No MTA-STS / TLS-RPT (optional) |
| `support.founders.click`, `api.founders.click` | any | NXDOMAIN | — |

### 1.8 EmailIt infrastructure referenced by the records (all resolve)

| Name | Type | Value |
|---|---|---|
| `_spf.emailit.com` | TXT | `v=spf1 ip4:96.9.126.0/24 ip4:77.78.86.181 ip4:77.78.86.180 ip4:77.78.86.179 ip4:10.10.40.51 ~all` (1 DNS lookup deep; the `10.10.40.51` RFC1918 entry is EmailIt's sloppiness, harmless) |
| `feedback-smtp.ffdc-1.emailit.com` | A | `77.78.86.180` (the return-path MX target; no MX of its own) |
| `inbound.emailitmail.com` | A | `77.78.86.180` |
| `go.emailitmail.com` | A | `96.9.126.5` (inside `_spf.emailit.com`'s /24); HTTPS → `HTTP/2 200`, `content-type: text/plain`, `content-length: 3`, body `:-)`, `via: 1.1 Caddy` |
| `ffdc-1.emailit.com` | A | `77.78.86.181` |
| `emailitmail.com` (EmailIt's own shared sending domain) | TXT / MX | `v=spf1 include:_spf.emailit.com ~all` / `10 feedback-smtp.ffdc-1.emailit.com.` — the **same pattern** as `emailit.founders.click`, confirming the layout is EmailIt's standard |
| `_dmarc.emailitmail.com` / `_dmarc.emailit.com` | TXT | `v=DMARC1; p=quarantine;` / `v=DMARC1; p=none; rua=mailto:jiri.zizka@funfirst.cz` |
| PTR `96.9.126.5` → `a-5.emailitmail.com` → A `96.9.126.5` | | forward-confirmed |
| PTR `77.78.86.181/180/179` → `mta-a/b/c.funfirstmail.com` → A `77.78.86.181/180/179` | | forward-confirmed |

### 1.9 Recipient domains (normal)

| Domain | MX |
|---|---|
| `gmail.com` | `5 gmail-smtp-in.l.google.com.`, `10 alt1…`, `20 alt2…`, `30 alt3…`, `40 alt4.gmail-smtp-in.l.google.com.` (TTL 1198) |
| `outlook.com` | `5 outlook-com.olc.protection.outlook.com.` (TTL 220, DNSSEC AD=1) |
| `hotmail.com` | `2 hotmail-com.olc.protection.outlook.com.` |

Nothing unusual on the receiving side.

## 2. What EmailIt documents as required

Sources fetched 2026-09-05 (extracts saved in `dns-raw/emailit-docs-extract.md`):

- `https://emailit.com/docs/guides/creating-a-domain/` — "To send emails using
  your domain, you need to add DNS records … Add a TXT record for DKIM
  verification. Add a TXT record for SPF verification. Add a MX record for
  email feedback. (Optional) Add a DMARC record … **All these records are setup
  on a subdomain of the chosen domain. For example, if you choose
  mail.example.com as your domain, you need to add the records to
  emailit.mail.example.com.** … It can take up to 24 hours for the records to
  be verified." (Verification is triggered by the dashboard's "Check DNS"
  button or `POST /domains/{id}/verify`.)
- `https://emailit.com/docs/api-reference/domains/get/` — the domain object
  carries `dkim_identifier_string: "emailit._domainkey"` and a `dns_records`
  array. Sample for a domain named `mail.yourdomain.com`:

  | required | type | name | value |
  |---|---|---|---|
  | true | MX | `mail.yourdomain.com` | `feedback-smtp.ffdc-1.emailit.com` (priority 10) |
  | true | TXT | `mail.yourdomain.com` | `v=spf1 include:_spf.emailit.com ~all` |
  | true | TXT | `emailit._domainkey.yourdomain.com` | `v=DKIM1; t=s; h=sha256; p=…` |
  | false | TXT | `_dmarc.yourdomain.com` | `v=DMARC1; p=none;` |
  | false | CNAME | `tr.yourdomain.com` (one sample says `go.yourdomain.com`) | `go.emailitmail.com` |
  | false | MX | `inbound.yourdomain.com` | `inbound.emailitmail.com` (priority 10) |

  "Verification Process: The endpoint checks all required DNS records (MX, SPF,
  DKIM). Optional DMARC record is also checked but not required for
  verification. The domain is considered verified only when all required
  records pass. The verified_at timestamp is set when all required checks
  pass." Per-record status values: `ok`, `pending`, `failed`, `missing`;
  domain-level fields `spf_status`, `dkim_status`, `mx_status`,
  `return_path_status`, `dmarc_status`, `tracking_status`, `inbound_status`.
- `https://emailit.com/docs/api-reference/emails/send/` — error sample for an
  unverified sender: `{"error": "From/Sender domain is not valid or not
  verified", "details": "The domain from email address
  'sender@unverified.com' is not verified in your workspace"}`.
- `https://emailit.com/docs/guides/sending-using-smtp/` — "From: Any Name
  <{any_address}@{verified_sending_domain}> … You also need to use the verified
  sending domain, otherwise the email will not be accepted."
- `https://emailit.com/docs/api-reference/authentication/` — "Your API keys
  can either have full permission, or be limited to a sending domain."

Note the inconsistency: the guide says SPF/MX live at `emailit.<domain>`;
the API sample puts them at `<domain>` itself with DKIM at the *parent*. Both
readings are evaluated in §4.

## 3. Requirements vs actual

| EmailIt record | Required? | Expected (domain = `founders.click`, per guide) | Actual in DNS | Status |
|---|---|---|---|---|
| Feedback / return-path MX | **yes** | `emailit.founders.click MX 10 feedback-smtp.ffdc-1.emailit.com` | `emailit.founders.click MX 10 feedback-smtp.ffdc-1.emailit.com.` | **present, exact match** |
| SPF TXT | **yes** | `emailit.founders.click TXT "v=spf1 include:_spf.emailit.com ~all"` | `"v=spf1 include:_spf.emailit.com ~all"` | **present, exact match** |
| DKIM TXT | **yes** | `emailit._domainkey.founders.click TXT "v=DKIM1; t=s; h=sha256; p=…"` | present; valid 2048-bit RSA; EmailIt's tag layout | **present, well-formed** (only EmailIt can confirm the key matches the one in the workspace) |
| DMARC TXT | optional | `_dmarc.founders.click TXT "v=DMARC1; p=none;"` | `"v=DMARC1; p=none;"` | **present, exact match** |
| Tracking CNAME | optional | `tr.founders.click` (or `go.`) `CNAME go.emailitmail.com`, **DNS-only** | `tr.` absent; `go.founders.click` exists but **proxied** → resolves to Cloudflare A records, no CNAME visible | **malformed for EmailIt's check** (will read `missing`); functionally proxies to EmailIt |
| Inbound MX | optional | `inbound.founders.click MX 10 inbound.emailitmail.com` | absent; instead `go.emailitmail.com.founders.click MX 10 inbound.emailitmail.com` | **missing; a mis-named orphan exists** |
| Apex SPF | not required by EmailIt | — | none | gap (posture only, §4.4) |
| Apex MX | not required by EmailIt | — | none | gap (receiving, §6) |

Net: **3 of 3 required records present and correct; 1 of 1 optional
authentication record present; the two optional feature records (tracking,
inbound) are mis-entered.** Nothing in DNS should keep the domain from
verifying, and nothing in DNS should cause Gmail or Outlook to refuse or
junk correctly-signed mail. If the EmailIt workspace nevertheless shows the
domain unverified, the failure is in EmailIt's stored state (never checked,
stale key, different `name`), not in what the public resolvers serve today.

## 4. Would SPF / DKIM / DMARC pass for `noreply@founders.click` sent by EmailIt?

Assumptions stated explicitly: EmailIt's MAIL FROM (envelope / Return-Path)
uses the feedback subdomain `emailit.founders.click` (this is what the MX "for
email feedback" plus SPF-on-that-name layout is for — the same design as Amazon
SES custom MAIL FROM, down to the `feedback-smtp.<region>` naming), and EmailIt
signs with `d=founders.click; s=emailit`. No delivered message exists to read
headers from, so these are inferred from the DNS layout and EmailIt's docs.

### 4.1 SPF

- Checked domain: MAIL FROM domain `emailit.founders.click`.
- Record: `v=spf1 include:_spf.emailit.com ~all` → `_spf.emailit.com` lists
  `96.9.126.0/24`, `77.78.86.179-181` (EmailIt MTAs; PTRs `a-N.emailitmail.com`,
  `mta-a/b/c.funfirstmail.com`, forward-confirmed). Lookup count 1 of 10.
- Result: **pass** for any EmailIt MTA.
- DMARC SPF alignment: organizational domain of `emailit.founders.click` is
  `founders.click` = From domain → **aligned under relaxed** (`aspf` not set →
  relaxed). Would *not* align under `aspf=s`; do not add that tag.
- If instead EmailIt used the apex as MAIL FROM: apex has no SPF → result
  `none` (not fail); DMARC would then rest on DKIM alone.

### 4.2 DKIM

- Selector `emailit`, `d=founders.click` → record found, valid RSA-2048,
  `h=sha256` compatible with rsa-sha256, `t=s` satisfied when `i=` is
  `@founders.click` or omitted.
- Result: **pass** (assuming the private key EmailIt holds matches this public
  key — only EmailIt's "Check DNS"/`dkim_status` proves that).
- Alignment: `d=` equals From domain exactly → **aligned under strict and
  relaxed**.

### 4.3 DMARC

- Policy record present and syntactically valid; `p=none`.
- Result: **pass** (SPF-aligned pass *and* DKIM-aligned pass; either suffices).
  Even a failure would only be *reported*, not enforced, and with no `rua=`
  it would be reported to nobody.

### 4.4 Gmail / Outlook sender requirements

Gmail (`https://support.google.com/mail/answer/81126`, fetched today):
- All senders: "Set up SPF **or** DKIM email authentication for your sending
  domains. Ensure that sending domains or IPs have valid forward and reverse
  DNS records … Use a TLS connection". → DNS side **met** (DKIM + SPF; FCrDNS
  on EmailIt IPs verified). TLS is EmailIt's MTA behaviour, not checkable here.
- 5,000+/day: "Set up SPF **and** DKIM … Set up DMARC … Your DMARC enforcement
  policy can be set to none … the domain in the sender's From: header must be
  aligned with either the SPF domain or the DKIM domain." → DNS side **met**
  (both aligned). founders.click is nowhere near that volume (4 sends in 3
  days).
- Missing apex SPF: Gmail evaluates SPF on the envelope domain, so it does not
  cause a failure; it only means an `@founders.click` forgery gets SPF `none`
  rather than `fail`, and Outlook's legacy Sender-ID/PRA check sees `none`.
  Recommended but not the blocker: `founders.click TXT "v=spf1
  include:_spf.emailit.com -all"` (no other apex sender exists — Lovable's
  Mailgun lives on `notify.www`, and Supabase's built-in SMTP is bypassed by
  the hook).

Microsoft's 2025 high-volume requirements (SPF + DKIM + DMARC p≥none aligned)
are the same triad and are likewise met on the DNS side; that page was not
fetched in this task.

## 5. The `go.emailitmail.com.founders.click` record and the `go` host

What exists: an MX-only name `go.emailitmail.com.founders.click` →
`10 inbound.emailitmail.com`.

What EmailIt asks for (both optional): `tr.<domain>` (or `go.<domain>`)
**CNAME** → `go.emailitmail.com`; `inbound.<domain>` **MX 10** →
`inbound.emailitmail.com`.

Reading: the operator filled one Cloudflare "Add record" form with the
*target* of the tracking CNAME (`go.emailitmail.com`) in the **Name** box and
the *target* of the inbound MX (`inbound.emailitmail.com`) as the **Content**,
type MX. Cloudflare always appends the zone to whatever is typed in Name (a
trailing dot does not make it absolute in the Cloudflare UI, and the API will
not accept a name outside the zone), hence the doubled hostname. The
`POST_LAUNCH_BACKLOG.md:133-145` suggestion to "recreate as
`go.emailitmail.com.` WITH the trailing dot" is therefore not achievable and
not what was intended. **Intended record: `inbound` MX 10
`inbound.emailitmail.com`** (only if inbound parsing is wanted; the app has no
inbound-email route). Effect on outbound: none — it is a name nobody sends to,
it is not consulted for SPF/DKIM/DMARC, and EmailIt's verifier does not look
at it. Safe to delete.

Separately, a tracking record *was* created — as `go.founders.click`
**with the Cloudflare proxy on**. Evidence: `https://go.founders.click/`
answers `HTTP/2 200`, `content-type: text/plain`, `content-length: 3`, body
`:-)`, `via: 1.1 Caddy`, `server: cloudflare`, `cf-cache-status: DYNAMIC` —
byte-identical to `https://go.emailitmail.com/` minus the Cloudflare headers —
while DNS shows only the zone's Cloudflare anycast pair (`104.21.75.79`,
`172.67.217.144`). A proxied CNAME is the only Cloudflare configuration that
produces that. Consequence: EmailIt's DNS check looks for a CNAME and finds A
records → `tracking_status: "missing"` / "There are no CNAME records at …".
That is cosmetic for delivery (tracking is optional), but if link tracking is
enabled in the EmailIt domain settings and EmailIt refuses to rewrite links
without a verified tracking host, links simply stay un-tracked. Fix if wanted:
set `go` (or `tr`) to DNS-only (grey cloud).

## 6. Other DNS facts that bear on the email trace

1. **`founders.click` has no MX at all.** SMTP falls back to the A record
   (RFC 5321 §5.1) — `104.21.75.79`, a Cloudflare HTTP proxy that does not
   listen on 25 — so any message *to* `@founders.click` times out and bounces.
   Affected code paths: new-ticket notification `to: SUPPORT_INBOX_EMAIL`
   (`src/lib/help.server.ts:389`, default `support@founders.click` at
   `src/lib/email.server.ts:360`) and every user-facing `Reply-To:
   support@founders.click` (`help.server.ts:404`,
   `src/lib/help-tickets.functions.ts:165`,
   `src/lib/email-templates.functions.ts:173`). Unless the Worker sets
   `SUPPORT_INBOX_EMAIL` to a real mailbox (`scripts/required-secrets.txt:47`
   says it merely "defaults to support@founders.click"), staff never receive
   ticket notifications and customers who "just reply to this email" reply
   into a void. This is independent of the outbound P0 but is the same
   customer promise. Cloudflare Email Routing is *not* enabled (it would have
   added `route1/2/3.mx.cloudflare.net` MX records).
2. **DMARC has no `rua=`.** Adding
   `rua=mailto:<mailbox>` would give the founder independent, provider-neutral
   evidence within 24 h of whether Google ever *received* anything from
   `founders.click` — the cheapest possible external witness for this trace.
3. **A second sending domain exists**: `notify.www.founders.click` is delegated
   to Lovable (`ns5/ns6.lovable.cloud`) with Mailgun EU MX. It is not used by
   the current code and is not in any of the observed send paths; noted so it
   is not mistaken for EmailIt infrastructure.
4. `docs/DEPLOYMENT.md:134` lists `_lovable-email` TXT as present; it is
   NXDOMAIN now. Harmless; the doc is stale on that point.
5. Earlier audit notes proposed "add SPF for founders.click" as the delivery
   fix (`docs/LIVE_ACCEPTANCE_TEST_2026-09-02.md:294`,
   `phase2-account/records.json` preconditions). Per EmailIt's docs SPF belongs
   on `emailit.founders.click`, where it already is; adding an apex SPF is good
   hygiene but will not change EmailIt verification or Gmail's SPF result.

## 7. What DNS cannot settle, and the exact checks that would

DNS is clean for a domain named `founders.click`. The residual "domain"
hypotheses all live inside the EmailIt workspace:

| Hypothesis | Why DNS can't exclude it | Exact discriminator |
|---|---|---|
| Domain exists in EmailIt but was never verified (Check DNS never run, or run before records propagated and never re-run) | verification state is stored in EmailIt, not DNS | `GET https://api.emailit.com/v2/domains` (Bearer `EMAILIT_API_KEY`) → `verified_at`, `dns_checked_at`, `spf_status`, `dkim_status`, `mx_status`, `return_path_status`; or dashboard → Domains → Check DNS |
| Domain was created under a different `name` (e.g. `emailit.founders.click`, `www.founders.click`), so `noreply@founders.click` is not a verified sender | EmailIt's own docs disagree on whether SPF/MX sit at `<name>` or `emailit.<name>`; the observed layout fits `founders.click` (guide) *and* `emailit.founders.click` (API sample) | same call → `name` field. If not exactly `founders.click`, every send returns `From/Sender domain is not valid or not verified` (4xx) and `auth-send-email.ts:89-98` still answers 200 |
| DKIM public key in DNS does not match the private key EmailIt holds (domain deleted and re-created in EmailIt after the DNS record was written) | a well-formed key is not proof of a matching pair | `dkim_status` from the same call; or the `Authentication-Results` header of any delivered message |
| API key is domain-scoped to a different domain | EmailIt keys "can … be limited to a sending domain" | `GET /v2/api-keys` or dashboard |

None of these is a DNS change. If the domain list shows `founders.click`
with `verified_at` set and all four statuses `ok`, the sending domain is
eliminated as a cause and the trace moves entirely to the API call / account
(Task A/C).

Bound on relevance: per `tail-observations.md`, Supabase did not call this
Worker's send-email hook for the 05:59:28Z signup, so for the *auth* emails
the EmailIt path in this repository (and therefore this DNS) may never have
been exercised. The DNS findings above apply with certainty only to the
in-repo `sendEmail()` callers that demonstrably run: ticket receipts / staff
notifications (`src/lib/help.server.ts:366-405`), ticket status changes, help
feedback follow-ups, and the welcome email. The AUP rule quoted in
`provider-docs.md` §8 ("APEX of the sending domains need to have a working
website") is satisfied: the apex resolves and redirects to `www`.

## 7a. Reconciliation with sibling notes in this folder

- `provider-docs.md` §8 and `dns-observations.md` reach the same conclusion on
  the three required records and DMARC (present, exact values). They describe
  the optional tracking CNAME and inbound MX as "absent". This task refines
  that: tracking **was** created, as `go.founders.click` with the Cloudflare
  proxy on (§5), and the inbound MX **was** attempted but landed on the
  mis-named `go.emailitmail.com.founders.click` (§1.6, §5). Neither changes
  the verification verdict; both are cosmetic for delivery.
- `dns-observations.md` does not cover the apex MX consequence for
  `support@founders.click` / `Reply-To` (§6.1), the DKIM key decode, the
  Google-resolver cross-check, PTR/FCrDNS of EmailIt's MTAs, or the
  guide-vs-API-sample ambiguity about which EmailIt domain `name` the observed
  layout corresponds to (§7). Those are additive, not contradictory.
- The earlier Phase-2 precondition "NO SPF record on founders.click" is
  literally true and materially misleading; both DNS notes now say so.

## 8. Raw evidence index

- `dns-raw/*.json` — 108 DoH responses (Cloudflare) + 7 Google cross-checks
  (`google-doh__*`), file name = `<qname>__<qtype>.json`.
- `dns-raw/emailit-docs-extract.md` — verbatim extracts of the EmailIt guide,
  the `dns_records` sample object, verification semantics, and the
  unverified-domain error.
- Reproduce any row: `curl -sS -H 'accept: application/dns-json'
  'https://cloudflare-dns.com/dns-query?name=<name>&type=<type>'`.
- DKIM key check: paste the `p=` value between `-----BEGIN PUBLIC KEY-----` /
  `-----END PUBLIC KEY-----` (64-col wrapped) and run
  `openssl rsa -pubin -in dkim.pem -text -noout`.
- `go` host probe: `curl -sSD - https://go.founders.click/` vs
  `curl -sSD - https://go.emailitmail.com/`.

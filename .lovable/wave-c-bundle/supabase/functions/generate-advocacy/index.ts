// One-shot generator for empty host_advocacy_state and host_advocacy_hub pages.
// Run by curling this function. No auth required (admin-gated by default URL secrecy).
// Returns a streamed line-per-page log.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY")!;
const MODEL = "google/gemini-2.5-pro";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const STATE_FROM_SLUG: Record<string, string> = {
  alabama: "Alabama", alaska: "Alaska", arizona: "Arizona", arkansas: "Arkansas",
  california: "California", florida: "Florida", georgia: "Georgia", indiana: "Indiana",
  louisiana: "Louisiana",
  colorado: "Colorado", connecticut: "Connecticut", delaware: "Delaware",
  hawaii: "Hawaii", idaho: "Idaho", illinois: "Illinois", iowa: "Iowa",
  kansas: "Kansas", kentucky: "Kentucky", maine: "Maine", maryland: "Maryland",
  massachusetts: "Massachusetts", michigan: "Michigan", minnesota: "Minnesota",
  mississippi: "Mississippi", missouri: "Missouri", montana: "Montana",
  nebraska: "Nebraska", nevada: "Nevada", "new-hampshire": "New Hampshire",
  "new-mexico": "New Mexico", "new-york": "New York", "north-carolina": "North Carolina",
  "north-dakota": "North Dakota", ohio: "Ohio", oklahoma: "Oklahoma", oregon: "Oregon",
  pennsylvania: "Pennsylvania", "rhode-island": "Rhode Island",
  "south-carolina": "South Carolina", "south-dakota": "South Dakota",
  tennessee: "Tennessee", texas: "Texas", utah: "Utah", vermont: "Vermont",
  virginia: "Virginia", washington: "Washington", "west-virginia": "West Virginia",
  wisconsin: "Wisconsin", wyoming: "Wyoming",
  "pa-what-every-host-needs-to-know": "Pennsylvania",
  "new-jersey": "New Jersey",
};

const HUB_PROMPT = `You are writing the national hub page for pool host advocacy on poolrentalnearme.com — a peer-to-peer pool rental marketplace. This is the parent page that links out to all 50 state-specific guides.

Audience: any US homeowner considering listing their pool. They want a national-level overview of what hosting involves, what rules look like across the US, and how to find their state.

Write a complete, ~600-word hub page in markdown.

# Pool host advocacy hub

(Intro: 2 to 3 sentences. Renting your pool is legal in every US state, but rules vary widely by state, county, and HOA. This hub helps you find what applies to you.)

## What host advocacy means

(1 paragraph. Mention $2M liability insurance per booking and the 10% flat host fee, vs Swimply's 15% plus.)

## What is the same across all 50 states

(4 to 6 bullets covering: no federal law specifically regulates pool rental, state-level pool fence and barrier codes, lodging tax treatment varying by city, common homeowner insurance gaps, alcohol and noise rules typically being local.)

## What varies by state

(1 short paragraph plus 3 to 5 bullets: HOA prevalence, pool barrier specifics, short-term rental laws, climate and season length, market saturation.)

## Find your state guide

(1 sentence telling readers to choose their state from the list below. Do not list states; the page renders that list separately.)

## Insurance and liability basics

(1 short paragraph. $2M per-booking liability included. Recommend calling your homeowner insurer before listing.)

## Get started as a host

(2 sentences inviting the reader to pick their state above or start listing now.)

VOICE RULES:
- Sentence case headings.
- Second person.
- No em dashes anywhere.
- Banned words: leverage, utilize, seamlessly, robust, dive into, elevate, game-changer, unlock, journey, landscape, bustling, thriving, vibrant, state-of-the-art, cutting-edge.
- Banned phrases: in this article, in conclusion, it's worth noting, thousands of hosts.
- Real numbers only.

Return ONLY the markdown body starting with "# Pool host advocacy hub". No preamble.`;

const STATE_PROMPT = (state: string) => `You are writing a state-specific pool host advocacy guide for poolrentalnearme.com — a peer-to-peer pool rental marketplace where homeowners earn $3K to $10K per month renting their backyard pool by the hour.

Audience: a homeowner in ${state} considering listing their pool. They want practical, real information about whether they can do this in ${state}, what laws and HOA dynamics look like, what they can earn, and what insurance and permits to check.

Write a complete, topical, roughly 700-word guide for ${state} in markdown. Use this exact structure:

# ${state} Pool Host Guide

(2 to 3 sentence intro about the ${state} pool rental market: climate, season length, demand drivers. Be honest if it's a short-season market.)

## The ${state} market overview

(1 paragraph naming 2 to 3 actual metro areas in ${state}, climate season, demand level vs other states. No invented stats.)

## Income expectations

(A short markdown table with 3 to 4 rows: Region | Typical Hourly Rate | Notes. Realistic ranges in $40 to $150 per hour. Below the table, 2 sentences on monthly income potential at typical occupancy.)

## ${state} regulations to check

(3 to 5 bullets covering: state pool fence and barrier code, short-term rental tax and lodging treatment if applicable, liability and insurance, alcohol on premises rules, noise ordinances. Only cite specific laws if you actually know them — otherwise use general phrasing like "check your local building code".)

## HOA and neighborhood considerations

(1 paragraph: how HOAs typically treat hourly pool rentals in ${state}, what to look for in CC&Rs, how to talk to neighbors.)

## Insurance and liability

(1 paragraph: Pool Rental Near Me includes $2M liability insurance per booking. Hosts should still verify their homeowner policy doesn't exclude commercial pool use.)

## Tips for ${state} hosts

(4 to 6 short bullet tips specific to ${state}: climate, season timing, pricing strategy, amenities that work well, common ${state} guest expectations.)

## Get started

(Closing 2 sentences inviting the reader to list their ${state} pool.)

VOICE RULES:
- Sentence case headings.
- Second person ("you", "your pool").
- No em dashes anywhere.
- Banned words: leverage, utilize, seamlessly, robust, dive into, elevate, game-changer, unlock, journey, landscape, bustling, thriving, vibrant, state-of-the-art, cutting-edge.
- Banned phrases: in this article, in conclusion, it's worth noting, thousands of hosts.
- Numbers under 10 spelled out, 10+ as numerals.
- Dollar amounts as $X per hour or $X/hour.
- Real numbers only. Hourly rates $40 to $150. Never invent statistics.
- Mention naturally: 10% flat host fee (vs Swimply's 15% plus), $2M liability insurance included.

Return ONLY the body_markdown string starting with "# ${state} Pool Host Guide". No preamble.`;

async function callAI(prompt: string): Promise<string> {
  const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: prompt }] }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`gateway ${res.status}: ${t.slice(0, 300)}`);
  }
  const json = await res.json();
  return json?.choices?.[0]?.message?.content?.trim() ?? "";
}

function meta(stateName: string | null) {
  if (!stateName) return {
    title: "Pool Host Advocacy Hub | Pool Rental Near Me",
    seoTitle: "Pool Host Advocacy Hub | Pool Rental Near Me",
    seoDesc: "Find your state's pool host advocacy guide. Laws, HOA rules, insurance, and income expectations for pool owners renting their pool by the hour.",
  };
  return {
    title: `${stateName} Pool Host Guide | Rent Your Pool in ${stateName} | Pool Rental Near Me`,
    seoTitle: `${stateName} Pool Host Advocacy Guide | Pool Rental Near Me`,
    seoDesc: `Complete guide for ${stateName} pool owners considering hourly pool rentals. HOA guidance, income estimates, regulations, and host tips for ${stateName}.`,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  // Require shared driver token to prevent unauthenticated AI cost burn.
  const expectedToken = Deno.env.get("DRIVE_TOKEN") ?? "";
  if (!expectedToken) {
    return new Response("Server misconfigured: DRIVE_TOKEN not set", { status: 500, headers: corsHeaders });
  }
  const reqUrl0 = new URL(req.url);
  const provided = req.headers.get("x-driver-token")
    ?? req.headers.get("authorization")?.replace(/^Bearer\s+/i, "")
    ?? reqUrl0.searchParams.get("token")
    ?? "";
  if (provided !== expectedToken) {
    return new Response("Unauthorized", { status: 401, headers: corsHeaders });
  }

  const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const url = new URL(req.url);
  const limit = Math.max(1, Math.min(15, Number(url.searchParams.get("limit") ?? "6")));

  const { data: rows, error } = await sb
    .from("content_pages")
    .select("id, url_path, slug, template_type, body_markdown, title, seo_title, seo_description")
    .in("template_type", ["host_advocacy_state", "host_advocacy_hub"])
    .order("url_path");
  if (error) return new Response(`db error: ${error.message}`, { status: 500, headers: corsHeaders });

  const allTodo = (rows ?? []).filter((r: any) => (r.body_markdown?.length ?? 0) < 200);
  const todo = allTodo.slice(0, limit);
  const log: string[] = [`Generating ${todo.length} of ${allTodo.length} remaining (limit=${limit}) with ${MODEL}`];
  let ok = 0, failed = 0;

  for (const r of todo as any[]) {
    const isHub = r.template_type === "host_advocacy_hub";
    const stateSlug = isHub ? null : r.slug.replace(/^host-advocacy-/, "");
    const stateName = isHub ? null : (STATE_FROM_SLUG[stateSlug!] ?? null);
    if (!isHub && !stateName) {
      log.push(`skip   ${r.url_path} (unknown slug)`);
      continue;
    }
    try {
      const md = await callAI(isHub ? HUB_PROMPT : STATE_PROMPT(stateName!));
      if (!md || md.length < 400) { failed++; log.push(`short  ${r.url_path} (${md.length}b)`); continue; }
      const m = meta(stateName);
      const { error: upErr } = await sb.from("content_pages").update({
        body_markdown: md,
        title: r.title || m.title,
        seo_title: r.seo_title || m.seoTitle,
        seo_description: r.seo_description || m.seoDesc,
        status: "published",
        scraped_at: new Date().toISOString(),
      }).eq("id", r.id);
      if (upErr) { failed++; log.push(`fail   ${r.url_path} ${upErr.message}`); continue; }
      ok++;
      log.push(`ok ${md.length}b  ${r.url_path}`);
    } catch (e) {
      failed++;
      log.push(`fail   ${r.url_path} ${(e as Error).message}`);
    }
  }
  log.push(`\nDONE ok=${ok} failed=${failed}`);
  return new Response(log.join("\n"), { headers: { ...corsHeaders, "Content-Type": "text/plain" } });
});

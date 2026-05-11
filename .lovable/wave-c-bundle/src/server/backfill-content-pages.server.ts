import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

/**
 * Admin-triggered batch: fill blank /p/* content_pages with AI-generated copy
 * via the Lovable AI Gateway, then mark them published.
 *
 * Slug-driven templates:
 *   A) become-(a-)(swimming-)?pool-host-{city}-{state}  → host recruitment city
 *   B) {state}-pool-host-advocacy-guide                 → state advocacy
 *   C) anything else                                    → resource article
 *
 * Idempotent: skips rows already with body_markdown >= 200 chars.
 */

type Row = {
  id: string;
  slug: string | null;
  url_path: string;
  category: string;
  template_type: string | null;
};

type Generated = {
  title: string;
  seo_title: string;
  seo_description: string;
  body_markdown: string;
};

const STATE_NAMES: Record<string, string> = {
  al: "Alabama", ak: "Alaska", az: "Arizona", ar: "Arkansas", ca: "California",
  co: "Colorado", ct: "Connecticut", de: "Delaware", fl: "Florida", ga: "Georgia",
  hi: "Hawaii", id: "Idaho", il: "Illinois", in: "Indiana", ia: "Iowa",
  ks: "Kansas", ky: "Kentucky", la: "Louisiana", me: "Maine", md: "Maryland",
  ma: "Massachusetts", mi: "Michigan", mn: "Minnesota", ms: "Mississippi",
  mo: "Missouri", mt: "Montana", ne: "Nebraska", nv: "Nevada", nh: "New Hampshire",
  nj: "New Jersey", nm: "New Mexico", ny: "New York", nc: "North Carolina",
  nd: "North Dakota", oh: "Ohio", ok: "Oklahoma", or: "Oregon", pa: "Pennsylvania",
  ri: "Rhode Island", sc: "South Carolina", sd: "South Dakota", tn: "Tennessee",
  tx: "Texas", ut: "Utah", vt: "Vermont", va: "Virginia", wa: "Washington",
  wv: "West Virginia", wi: "Wisconsin", wy: "Wyoming", dc: "District of Columbia",
};
const STATE_LONG_TO_CODE = Object.fromEntries(
  Object.entries(STATE_NAMES).map(([code, name]) => [
    name.toLowerCase().replace(/\s+/g, "-"),
    code.toUpperCase(),
  ]),
);

function titleCase(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

function classify(slug: string): {
  kind: "host_city" | "state_advocacy" | "resource";
  city?: string;
  stateCode?: string;
  stateName?: string;
  topic?: string;
} {
  // host city: become-a-pool-host-{...}-{state}  OR  become-a-swimming-pool-host-{...}-{state}
  const hostMatch = slug.match(
    /^become-a-(?:swimming-)?pool-host-+(.+?)-(?:([a-z]{2})|([a-z-]+))$/i,
  );
  if (hostMatch) {
    const cityRaw = hostMatch[1].replace(/^-+|-+$/g, "");
    const stateCode = hostMatch[2]?.toUpperCase();
    const stateLong = hostMatch[3];
    let code = stateCode;
    let name = stateCode ? STATE_NAMES[stateCode.toLowerCase()] : undefined;
    if (!code && stateLong && STATE_LONG_TO_CODE[stateLong]) {
      code = STATE_LONG_TO_CODE[stateLong];
      name = titleCase(stateLong.replace(/-/g, " "));
    }
    if (code) {
      return {
        kind: "host_city",
        city: titleCase(cityRaw.replace(/-/g, " ")),
        stateCode: code,
        stateName: name || code,
      };
    }
  }
  // state advocacy
  const advMatch = slug.match(/^([a-z-]+)-pool-host-advocacy-guide$/i);
  if (advMatch) {
    const long = advMatch[1].toLowerCase();
    const code = STATE_LONG_TO_CODE[long];
    if (code) {
      return {
        kind: "state_advocacy",
        stateCode: code,
        stateName: titleCase(long.replace(/-/g, " ")),
      };
    }
  }
  return { kind: "resource", topic: titleCase(slug.replace(/-/g, " ")) };
}

function buildPrompt(row: Row): { system: string; user: string } {
  const slug = row.slug || row.url_path.replace(/^\/p\//, "");
  const cls = classify(slug);

  const sharedRules = `
You write SEO content for Pool Rental Near Me (PRNM), a marketplace where homeowners rent out their private pools by the hour.
Differentiators to mention naturally: 10% flat host fee (vs Swimply's 15%+), $2M liability insurance included, 5,100+ city pages.
Markdown only. Use H2 (##) and H3 (###). Short paragraphs. Real, useful content — no filler, no "in this article we will". Do not invent statistics.
Internal links allowed: /s, /s?address={City%2C+ST}, /p/hosting, /p/all-locations, /p/earnings-calculator, /p/how-it-works, /p/waivers, /p/hoa-pool-rental-defense-kit.
List Your Pool CTA URL: /l/draft/00000000-0000-0000-0000-000000000000/new/details
Return your answer ONLY by calling the write_page tool.
`.trim();

  if (cls.kind === "host_city") {
    return {
      system: sharedRules,
      user: `Write a host-recruitment landing page for ${cls.city}, ${cls.stateCode}.

Title: "Become a Pool Host in ${cls.city}, ${cls.stateCode}"
Length: 800-1200 words.

Required sections (use ## headings, paraphrase the heading text — don't copy verbatim):
1. Opening hook on the local pool-rental opportunity in ${cls.city}, ${cls.stateName}
2. What pools rent best here (architectural styles, heated/saltwater/spa, capacity)
3. Best seasons & peak demand windows for ${cls.city}'s climate
4. Realistic pricing tips ($/hour ranges, weekend premiums, peak vs shoulder)
5. Why list on PRNM — 10% flat fee vs Swimply's 15%+, $2M insurance, fast payouts. Link to /p/earnings-calculator and /p/hosting.
6. Nearby cities also strong for hosting (mention 3-5 real cities near ${cls.city} the host could also serve)
7. FAQ — 5 questions specific to ${cls.city}/${cls.stateName} hosting (insurance, neighbors/HOA, taxes, season, getting started)

End with a one-sentence CTA linking to /l/draft/00000000-0000-0000-0000-000000000000/new/details ("List your pool free").

seo_title (≤60 chars): "Become a Pool Host in ${cls.city}, ${cls.stateCode} | PRNM"
seo_description (≤155 chars): mention earnings, 10% fee, ${cls.city}.`,
    };
  }

  if (cls.kind === "state_advocacy") {
    return {
      system: sharedRules,
      user: `Write a Pool Host Advocacy & Legality guide for ${cls.stateName} (${cls.stateCode}).

Title: "Pool Host Advocacy & Legality in ${cls.stateName}"
Length: 1000-1500 words. Be factual; if uncertain, use cautious language ("typically", "in most jurisdictions") and tell hosts to confirm with their city/county.

Required sections:
1. Is short-term pool rental legal in ${cls.stateName}? (general status — most states have no statewide ban; regulation is municipal)
2. Permits & business licenses commonly required at the city/county level
3. HOA & deed restrictions — how to defend your right to host (link to /p/hoa-pool-rental-defense-kit)
4. Insurance requirements — note PRNM's included $2M liability
5. Tax implications — Schedule E vs Schedule C, lodging tax, sales tax
6. How to operate compliantly — waivers (link /p/waivers), capacity limits, neighbor relations
7. FAQ — 5 questions specific to ${cls.stateName} hosts

End with CTA linking to /l/draft/00000000-0000-0000-0000-000000000000/new/details.

seo_title (≤60 chars), seo_description (≤155 chars) optimized for "${cls.stateName} pool rental laws".`,
    };
  }

  // resource
  return {
    system: sharedRules,
    user: `Write a genuinely useful article on the topic implied by the URL slug: "${slug}".
The slug IS the topic — interpret it literally. Topic phrase: "${cls.topic}".

Length: 800-1500 words.
Use ## section headings. Include practical, specific tips. If the topic is host-facing, link to /p/hosting and /p/all-locations and the List Your Pool CTA. If the topic is renter-facing, link to /s and /p/how-it-works. Include 3-5 internal links naturally in the body.

End with a short CTA paragraph appropriate to the topic.

seo_title (≤60 chars), seo_description (≤155 chars) targeting the literal topic.`,
  };
}

const TOOL_SCHEMA = {
  type: "function" as const,
  function: {
    name: "write_page",
    description: "Return the generated page content.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Human-readable page title (H1)" },
        seo_title: { type: "string", description: "≤60 chars" },
        seo_description: { type: "string", description: "≤155 chars" },
        body_markdown: { type: "string", description: "Full markdown body, no frontmatter" },
      },
      required: ["title", "seo_title", "seo_description", "body_markdown"],
      additionalProperties: false,
    },
  },
};

async function callAI(row: Row, model: string): Promise<Generated> {
  const apiKey = process.env.LOVABLE_API_KEY;
  if (!apiKey) throw new Error("LOVABLE_API_KEY not set");
  const { system, user } = buildPrompt(row);

  let attempt = 0;
  while (true) {
    attempt++;
    const resp = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        tools: [TOOL_SCHEMA],
        tool_choice: { type: "function", function: { name: "write_page" } },
      }),
    });

    if (resp.status === 429 && attempt <= 3) {
      const wait = 2000 * attempt;
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    if (resp.status === 402) {
      throw new Error("AI credits exhausted (402). Add funds in Settings → Workspace → Usage.");
    }
    if (!resp.ok) {
      const t = await resp.text();
      throw new Error(`AI gateway ${resp.status}: ${t.slice(0, 300)}`);
    }
    const data = await resp.json();
    const tc = data?.choices?.[0]?.message?.tool_calls?.[0];
    if (!tc?.function?.arguments) {
      throw new Error("AI response missing tool call");
    }
    const parsed = JSON.parse(tc.function.arguments) as Generated;
    if (!parsed.body_markdown || parsed.body_markdown.length < 400) {
      throw new Error(`Generated body too short (${parsed.body_markdown?.length ?? 0} chars)`);
    }
    return parsed;
  }
}

const CATEGORY_ORDER: Record<string, number> = {
  "Host Acquisition (Hub)": 0,
  "Host Advocacy (State Guide)": 1,
  "Host Acquisition (City pSEO)": 2,
  "Resource/Article Page": 3,
  "Event/City Guide": 4,
};

export type BackfillInput = {
  adminToken: string;
  limit?: number;
  model?: string;
  dryRun?: boolean;
};

export async function runBackfillContentPages(input: BackfillInput) {
  const data = z
    .object({
      adminToken: z.string().min(8),
      limit: z.number().int().min(1).max(50).default(10),
      model: z.string().default("openai/gpt-5"),
      dryRun: z.boolean().default(false),
    })
    .parse(input);

  const expected = process.env.BACKFILL_ADMIN_TOKEN || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!expected || data.adminToken !== expected) {
    throw new Error("Unauthorized");
  }
  {

    // Pull a wider candidate set, sort in JS by our composite rank.
    const { data: rows, error } = await supabaseAdmin
      .from("content_pages")
      .select("id, slug, url_path, category, template_type, body_markdown, status, priority")
      .like("url_path", "/p/%")
      .neq("status", "published")
      .order("priority", { ascending: false, nullsFirst: false })
      .limit(300);

    if (error) throw new Error(`select failed: ${error.message}`);

    const candidates = (rows || [])
      .filter((r) => !!r.url_path && (!r.body_markdown || (r.body_markdown as string).length < 200))
      .sort((a, b) => {
        const pa = (a.priority as number) ?? 0;
        const pb = (b.priority as number) ?? 0;
        if (pa !== pb) return pb - pa;
        const ca = CATEGORY_ORDER[a.category] ?? 99;
        const cb = CATEGORY_ORDER[b.category] ?? 99;
        if (ca !== cb) return ca - cb;
        return (a.url_path ?? "").localeCompare(b.url_path ?? "");
      })
      .slice(0, data.limit);

    if (data.dryRun) {
      return {
        dryRun: true,
        count: candidates.length,
        slugs: candidates.map((r) => ({
          url_path: r.url_path ?? "",
          category: r.category,
          classified: classify(r.slug || (r.url_path ?? "").replace(/^\/p\//, "")).kind,
        })),
      };
    }

    const results: Array<{ url_path: string; ok: boolean; words?: number; error?: string }> = [];
    for (const row of candidates) {
      try {
        const gen = await callAI(row as Row, data.model);
        const { error: upErr } = await supabaseAdmin
          .from("content_pages")
          .update({
            title: gen.title,
            seo_title: gen.seo_title.slice(0, 70),
            seo_description: gen.seo_description.slice(0, 160),
            body_markdown: gen.body_markdown,
            status: "published",
            updated_at: new Date().toISOString(),
          })
          .eq("id", row.id);
        if (upErr) throw new Error(upErr.message);
        results.push({
          url_path: row.url_path ?? "",
          ok: true,
          words: gen.body_markdown.split(/\s+/).length,
        });
      } catch (e) {
        results.push({
          url_path: row.url_path ?? "",
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        });
      }
      // gentle pacing
      await new Promise((r) => setTimeout(r, 1200));
    }

    return {
      dryRun: false,
      attempted: results.length,
      succeeded: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      results,
    };
  }
}

// Backwards-compatible alias (used by existing imports, no longer an RPC).
export const backfillContentPages = async ({ data }: { data: BackfillInput }) =>
  runBackfillContentPages(data);

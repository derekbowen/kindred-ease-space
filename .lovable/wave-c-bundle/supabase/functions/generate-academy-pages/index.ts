// One-shot generator for the 8 empty academy pages linked from the homepage.
// POST { slug } -> generates title/SEO/body via Lovable AI, updates content_pages.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const ALLOWED_SLUGS: Record<string, { h1: string; kind: "course" | "hub_index" | "hub_certs" }> = {
  "learning-academy": {
    h1: "Pool Host Academy: 100+ Free Courses for Hosts",
    kind: "hub_index",
  },
  "host-training-academy": {
    h1: "Pool Host Training & Certification Academy",
    kind: "hub_certs",
  },
  "elearning-academy-tax-deduction-tracking-guide-pool-hosts": {
    h1: "Taxes & Pool Rental Income: Deductions, Tracking, and Filing for Hosts",
    kind: "course",
  },
  "elearning-academy-dealing-with-difficult-scenarios-pool-hosts": {
    h1: "Difficult Guest Scenarios: A Pool Host's Playbook",
    kind: "course",
  },
  "elearning-academy-hoa-navigation-guide-pool-hosts": {
    h1: "HOA Navigation: Renting Your Pool Without Getting Fined",
    kind: "course",
  },
  "elearning-academy-dealing-with-neighbor-complaints-in-real-time": {
    h1: "Handling Neighbor Complaints in Real Time",
    kind: "course",
  },
  "elearning-academy-content-marketing-for-pool-rentals": {
    h1: "Content Marketing for Pool Rentals: TikTok, Instagram, and SEO",
    kind: "course",
  },
  "elearning-academy-listing-optimization-photography-conversion": {
    h1: "Listing Optimization & Photography: 3x Your Pool Rental Bookings",
    kind: "course",
  },
};

const SYSTEM_COURSE = `You write expert long-form course content for Pool Rental Near Me (PRNM), a US peer-to-peer pool rental marketplace. Tone: founder-mentor talking to a homeowner who wants to make $3K-$10K/month renting their backyard pool.

ABSOLUTE RULES:
- 100% original, no fluff, second person ("you")
- Real numbers ($40-150/hour typical, 10% PRNM host fee, $2M liability included, payouts in 24h)
- Sentence case headings, no em dashes
- Never use: "leverage", "utilize", "seamlessly", "robust", "dive into", "elevate", "in this article", "in conclusion", "it's worth noting", "thriving", "vibrant", "bustling"
- Marketplace links use relative paths: /s, /signup, /login, /l/draft/00000000-0000-0000-0000-000000000000/new/details
- Internal links allowed: /p/hosting, /p/free-host-tools, /p/faq, /p/learning-academy, /p/host-training-academy
- Numbers under 10 spelled out, 10+ as numerals; dollar amounts as $X/hour

Return ONLY a JSON object via the tool call.`;

const SYSTEM_HUB = `You write a hub/landing page for the Pool Rental Near Me Host Academy. Same voice rules as course content (founder-mentor, no fluff, real numbers, sentence case, no banned words). Return ONLY a JSON object via the tool call.`;

const COURSE_TOOL = {
  type: "function",
  function: {
    name: "emit_course_page",
    description: "Emit a complete course page with metadata and full markdown body (1800-2400 words).",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Page title, sentence case" },
        seo_title: { type: "string", description: "<60 chars, ends with '| Pool Rental Near Me'" },
        seo_description: { type: "string", description: "<160 chars" },
        description: { type: "string", description: "1-sentence summary, ~200 chars" },
        body_markdown: {
          type: "string",
          description:
            "Full markdown body. MUST start with '# {H1}'. 1800-2400 words. Sections in order: 150-word intro; 4-6 H2 sections each 250-400 words with at least one numbered list and one markdown table where appropriate; '## How this affects your hosting income' (200 words mentioning $500-$1500/month earnings on PRNM); '## Frequently asked questions' with 6-8 ### Q: items; '## Related guides' bullet links to /p/free-host-tools, /p/hosting, /p/learning-academy; final CTA paragraph linking to /p/hosting and /signup.",
        },
      },
      required: ["title", "seo_title", "seo_description", "description", "body_markdown"],
      additionalProperties: false,
    },
  },
};

const HUB_TOOL = {
  type: "function",
  function: {
    name: "emit_hub_page",
    description: "Emit a hub landing page with metadata and full markdown body (1200-1600 words).",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string" },
        seo_title: { type: "string" },
        seo_description: { type: "string" },
        description: { type: "string" },
        body_markdown: {
          type: "string",
          description:
            "Markdown body starting with '# {H1}'. Sections: 150-word intro (the academy is 100+ free courses, English & Español, no other platform offers this); '## What you'll learn' bullet categories (Safety & rescue, Marketing & pricing, AI & automation, Occasion playbooks, Legal & insurance, Switching from Swimply); '## Featured courses' listing 6 courses with one-line descriptions; '## Earn certifications' (200 words, shareable host certificates); '## How it works' numbered list; '## Frequently asked questions' with 5 ### Q: items; final CTA linking to /signup and /p/hosting.",
        },
      },
      required: ["title", "seo_title", "seo_description", "description", "body_markdown"],
      additionalProperties: false,
    },
  },
};

Deno.serve(async (req) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, content-type, apikey",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });

  // Auth gate: require DRIVE_TOKEN to prevent anonymous AI credit burn / DB writes.
  const expectedToken = Deno.env.get("DRIVE_TOKEN") ?? "";
  if (!expectedToken) {
    return new Response("Server misconfigured: DRIVE_TOKEN not set", { status: 500, headers: cors });
  }
  const provided = req.headers.get("x-driver-token")
    ?? req.headers.get("authorization")?.replace(/^Bearer\s+/i, "")
    ?? new URL(req.url).searchParams.get("token")
    ?? "";
  if (provided !== expectedToken) {
    return new Response("Unauthorized", { status: 401, headers: cors });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const slug = String(body.slug ?? "");
    if (!slug) {
      return new Response(JSON.stringify({ error: "slug required" }), {
        status: 400,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    // Allowlisted slugs use a curated H1; any other elearning-academy-* slug
    // gets an H1 derived from the slug itself (Title Case of the trailing path).
    let spec = ALLOWED_SLUGS[slug];
    if (!spec) {
      if (!slug.startsWith("elearning-academy-")) {
        return new Response(JSON.stringify({ error: `slug not allowed: ${slug}` }), {
          status: 400,
          headers: { ...cors, "Content-Type": "application/json" },
        });
      }
      const topic = slug
        .replace(/^elearning-academy-/, "")
        .split("-")
        .map((w) => (w.length > 2 ? w[0].toUpperCase() + w.slice(1) : w))
        .join(" ")
        .replace(/\bFor Pool Hosts\b/i, "for Pool Hosts")
        .replace(/\bAnd\b/g, "and")
        .replace(/\bThe\b/g, "the")
        .replace(/\bOf\b/g, "of")
        .replace(/\bIn\b/g, "in");
      const h1 =
        topic.charAt(0).toUpperCase() +
        topic.slice(1) +
        (/(guide|playbook|checklist|tips|hosts|hosting)/i.test(topic)
          ? ""
          : ": A Pool Host's Guide");
      spec = { h1, kind: "course" };
    }

    const KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!KEY) throw new Error("LOVABLE_API_KEY missing");

    const isCourse = spec.kind === "course";
    const tool = isCourse ? COURSE_TOOL : HUB_TOOL;
    const system = isCourse ? SYSTEM_COURSE : SYSTEM_HUB;
    const user = isCourse
      ? `Write a course page.\n\nSlug: ${slug}\nH1 (use exactly as the # heading): ${spec.h1}\nDerive the topic from the H1.\n\nReturn JSON via the tool call. body_markdown MUST start with '# ${spec.h1}'.`
      : `Write the ${spec.h1} hub/landing page.\n\nSlug: ${slug}\nH1: ${spec.h1}\nThis is a ${spec.kind === "hub_index" ? "course catalog index" : "certifications and training overview"} page.\n\nReturn JSON via the tool call. body_markdown MUST start with '# ${spec.h1}'.`;

    const r = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-2.5-pro",
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        tools: [tool],
        tool_choice: { type: "function", function: { name: tool.function.name } },
      }),
    });

    if (!r.ok) {
      const text = await r.text();
      return new Response(JSON.stringify({ error: `gateway ${r.status}: ${text}` }), {
        status: 500,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }
    const data = await r.json();
    const args = data.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
    const content = typeof args === "string" ? JSON.parse(args) : args;
    if (!content?.body_markdown) {
      return new Response(JSON.stringify({ error: "no content returned", raw: data }), {
        status: 500,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    const sb = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const { error: upErr } = await sb
      .from("content_pages")
      .update({
        title: content.title,
        seo_title: content.seo_title,
        seo_description: content.seo_description,
        description: content.description,
        body_markdown: content.body_markdown,
        status: "published",
        updated_at: new Date().toISOString(),
      })
      .eq("slug", slug);
    if (upErr) throw upErr;

    return new Response(
      JSON.stringify({
        ok: true,
        slug,
        title: content.title,
        body_chars: content.body_markdown.length,
      }),
      { headers: { ...cors, "Content-Type": "application/json" } },
    );
  } catch (e) {
    console.error(e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : String(e) }),
      { status: 500, headers: { ...cors, "Content-Type": "application/json" } },
    );
  }
});

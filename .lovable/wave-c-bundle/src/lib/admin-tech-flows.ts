// Diagrams + step-by-step data flows for the admin technical docs page.
// Mermaid syntax — rendered client-side by <Mermaid />.

export type FlowDiagram = {
  id: string;
  title: string;
  blurb: string;
  diagram: string; // mermaid source
  steps: { name: string; detail: string }[];
};

export const ADMIN_FLOWS: FlowDiagram[] = [
  {
    id: "scrape",
    title: "Content page scraping",
    blurb:
      "How a pasted Yelp / Google Maps / BBB / Angi / Houzz / Thumbtack URL becomes a pending provider row.",
    diagram: `flowchart LR
  A[Admin pastes URLs<br/>/admin/scrape-import] --> B{Per-URL loop}
  B --> C[adminScrapeProviderUrl<br/>server fn]
  C --> D[Firecrawl API<br/>FIRECRAWL_API_KEY]
  D --> E[Parse: name, phone,<br/>address, photos, hours]
  E --> F[supabaseAdmin INSERT<br/>providers status=pending]
  E --> G[supabaseAdmin INSERT<br/>scrape_jobs row]
  F --> H[/admin/directory<br/>moderation queue/]
  G --> I[/admin/scrape-import<br/>recent jobs panel/]
  classDef ext fill:#fef3c7,stroke:#b45309
  classDef db fill:#dbeafe,stroke:#1e40af
  class D ext
  class F,G db`,
    steps: [
      { name: "1. Paste URLs", detail: "Admin pastes one URL per line into /admin/scrape-import. Client filters to http(s) only." },
      { name: "2. Loop on the client", detail: "The page calls adminScrapeProviderUrl({ url, autoCreate: true }) one URL at a time so progress can be reported." },
      { name: "3. Server scrape", detail: "The server fn calls Firecrawl with FIRECRAWL_API_KEY, then runs site-specific extractors for Yelp, Google Maps, BBB, Angi, Houzz, Thumbtack." },
      { name: "4. Persist provider", detail: "On success, supabaseAdmin inserts a row into providers with status='pending' and is_published=false." },
      { name: "5. Persist job log", detail: "Every attempt (success or failure) inserts into scrape_jobs with status, source_type, source_url, and error message if any." },
      { name: "6. Moderate", detail: "The new pending provider shows up in /admin/directory for human review before publishing." },
    ],
  },
  {
    id: "status",
    title: "Content page status transitions",
    blurb:
      "Lifecycle of a row in content_pages: scraped → draft → pending → published, with admin actions along the way.",
    diagram: `stateDiagram-v2
  [*] --> scraped: Imported by scraper /<br/>backfill job
  scraped --> draft: Quick page builder /<br/>generate-content edits
  draft --> pending: Admin marks ready<br/>(/admin/content-pages)
  pending --> published: Admin publishes
  published --> draft: Admin unpublishes<br/>(needs more work)
  pending --> draft: Rejected in review
  published --> [*]: Optionally archived<br/>(out of sitemap)
  draft --> scraped: Reset to source<br/>(rare, manual)`,
    steps: [
      { name: "scraped", detail: "Raw row created by an import (Firecrawl scrape, GSC backfill, CSV import). Not in sitemap, not served at /p/{slug}." },
      { name: "draft", detail: "AI generation has populated title, body, FAQs, schema. Still hidden from production. Visible in /admin/content-pages with status filter 'Unpublished (draft)'." },
      { name: "pending", detail: "Marked ready for human review. Sitemap still excludes it. Reviewer can publish or send back to draft." },
      { name: "published", detail: "is_published=true. Included in /sitemap.xml via getCanonicalUrl, served at /p/{slug}, eligible for Google indexing." },
      { name: "Unpublish", detail: "Flipping back to draft removes it from the sitemap on next regen and serves a 410/404 fallback at /p/{slug}." },
    ],
  },
  {
    id: "publish",
    title: "Publishing a page (request flow)",
    blurb:
      "What happens between the admin clicking Publish and Googlebot fetching the live URL.",
    diagram: `sequenceDiagram
  participant A as Admin (browser)
  participant SF as Server fn<br/>(admin-tools.functions.ts)
  participant DB as supabaseAdmin
  participant SM as Sitemap builder
  participant N as nginx (EC2)
  participant G as Googlebot
  A->>SF: publishPage({ slug })
  SF->>DB: UPDATE content_pages<br/>SET is_published=true,<br/>status='published'
  DB-->>SF: row
  SF->>DB: UPSERT redirect_aliases<br/>(if slug changed)
  SF-->>A: { ok, canonicalUrl }
  Note over SM: Sitemap regenerated on<br/>next request via getCanonicalUrl
  G->>N: GET /sitemap.xml
  N->>SM: forward (Host: poolrentalnearme.com)
  SM-->>G: absolute /p/{slug} URLs
  G->>N: GET /p/{slug}
  N->>SF: forward to fresh-web<br/>X-Forwarded-Host preserved
  SF->>DB: SELECT content_pages<br/>WHERE slug=$1 AND is_published`,
    steps: [
      { name: "1. Admin clicks Publish", detail: "Bulk page editor calls a server fn (admin-only, gated by has_role('admin'))." },
      { name: "2. Update row", detail: "supabaseAdmin sets status='published' and is_published=true. RLS bypassed because we're on the service-role client." },
      { name: "3. Alias if needed", detail: "If the slug changed during the workflow, an entry is added to redirect_aliases so the old URL 301s to the new one." },
      { name: "4. Sitemap reflects", detail: "Sitemap is built per request from is_published=true rows; getCanonicalUrl(request, '/p/'+slug) emits absolute production URLs only." },
      { name: "5. Googlebot fetches", detail: "Hits poolrentalnearme.com/sitemap.xml; nginx forwards to fresh-web with X-Forwarded-Host=poolrentalnearme.com so canonicals are correct." },
      { name: "6. Page render", detail: "/p/{slug} server route loads the row via supabaseAdmin and returns SSR HTML with canonical = https://www.poolrentalnearme.com/p/{slug}." },
    ],
  },
  {
    id: "redirects",
    title: "Redirects & aliases",
    blurb:
      "How a request for an old or legacy URL ends up at the right canonical /p/{slug}.",
    diagram: `flowchart TD
  R[Incoming request<br/>poolrentalnearme.com/some/path] --> N[nginx on EC2]
  N -->|forwards /p/* to fresh-web| FW[fresh-web TanStack route]
  FW --> M{Slug match in<br/>content_pages?}
  M -->|hit & published| HTML[Render SSR page<br/>200 OK]
  M -->|miss| AL{Match in<br/>redirect_aliases?}
  AL -->|hit| RD[301 to canonical /p/{new-slug}]
  AL -->|miss| LL{Match in<br/>legacy-redirects.ts?}
  LL -->|hit| RD2[301 to mapped path]
  LL -->|miss| LOG[INSERT content_404_log<br/>+ render 404 page]
  LOG --> MP[/admin/missing-pages<br/>surfaces the URL/]
  N -.->|/s, /l, /login, /inbox<br/>etc./| ST[Sharetribe<br/>marketplace]
  classDef route fill:#dbeafe,stroke:#1e40af
  classDef warn fill:#fee2e2,stroke:#b91c1c
  class HTML,RD,RD2 route
  class LOG warn`,
    steps: [
      { name: "1. nginx routes the host", detail: "Production traffic hits nginx on EC2. /p/*, /, /landing-page, /fw-assets/* and sitemaps go to fresh-web. Marketplace paths go to Sharetribe." },
      { name: "2. Slug lookup", detail: "fresh-web's /p/$slug route loads the row from content_pages via supabaseAdmin (server-only — RLS denies anon)." },
      { name: "3. Alias fallback", detail: "Miss? Check redirect_aliases for an old→new slug mapping. If matched, return a 301 to /p/{new-slug}." },
      { name: "4. Legacy table", detail: "Still no match? Check the static legacy-redirects.ts map (covers pre-/p/ URLs). If matched, 301 to the mapped path." },
      { name: "5. Log the 404", detail: "If nothing matched, insert into content_404_log and render the 404 page. The URL surfaces at /admin/missing-pages so an admin can write the missing content." },
      { name: "6. Canonical wins", detail: "All hops use getCanonicalUrl(request) so 301 targets and the rendered canonical tag use https://www.poolrentalnearme.com — never lovable.app." },
    ],
  },
];

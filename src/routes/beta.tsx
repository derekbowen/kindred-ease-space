import { createFileRoute, Link } from "@tanstack/react-router";
import { GENERATION_DAILY_CAP } from "@/lib/generation-limits";
import { SiteHeader } from "@/components/site/SiteHeader";
import { SiteFooter } from "@/components/site/SiteFooter";
import { canonicalUrl } from "@/lib/canonical";
import { PAGE_PLANS, PAGE_ADDON, TRIAL_PAGE_LIMIT } from "@/lib/plan-catalog";

const LAST_UPDATED = "September 22, 2026";
const TITLE = "Free beta — what's included — founders.click";
const DESCRIPTION =
  "What the founders.click beta includes for Sharetribe marketplaces: what is free, what costs money, what happens when access ends, and how your data is handled.";

/**
 * The public statement of the beta deal. Every number here is read from the
 * plan catalog so the page cannot say one thing while checkout charges
 * another; a tenant's own grant size is shown in the app, not here, because
 * grants differ per marketplace.
 */
export const Route = createFileRoute("/beta")({
  head: () => ({
    meta: [
      { title: TITLE },
      { name: "description", content: DESCRIPTION },
      { property: "og:title", content: TITLE },
      { property: "og:description", content: DESCRIPTION },
      { property: "og:type", content: "website" },
      { property: "og:url", content: canonicalUrl("/beta") },
      { name: "robots", content: "index, follow" },
    ],
    links: [{ rel: "canonical", href: canonicalUrl("/beta") }],
  }),
  component: BetaPage,
});

function BetaPage() {
  const cheapest = PAGE_PLANS[0];
  const dearest = PAGE_PLANS[PAGE_PLANS.length - 1];
  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      <SiteHeader />
      <main className="mx-auto max-w-3xl px-6 py-12 flex-1 w-full">
        <p className="font-mono text-[11px] font-medium uppercase tracking-[0.22em] text-brand">
          Free beta
        </p>
        <h1 className="mt-3 text-4xl font-bold tracking-tight">What the beta includes</h1>
        <p className="mt-2 text-sm text-muted-foreground">Last updated: {LAST_UPDATED}</p>

        <article className="prose prose-neutral dark:prose-invert mt-8 max-w-none prose-headings:scroll-mt-20 prose-headings:tracking-tight prose-h2:mt-10 prose-h2:text-2xl prose-a:text-brand prose-a:no-underline hover:prose-a:underline">
          <p>
            founders.click is in beta. We are working with a small number of Sharetribe marketplaces
            to publish SEO landing pages generated from their real listings, hosted on their own
            domains. This page says plainly what is free, what costs money, what happens when access
            ends, and what we do with your data. If anything here is unclear,{" "}
            <Link to="/help/contact">ask us</Link>.
          </p>

          <h2 id="whats-free">What's free</h2>
          <ul>
            <li>
              <strong>Beta grant.</strong> A marketplace accepted into the beta receives a set
              number of published pages at no charge. The number is written into your workspace and
              shown on your dashboard and billing page — it is not a trial that silently converts to
              a paid plan, and no card is asked for.
            </li>
            <li>
              <strong>Trial.</strong> Any workspace that is not on a beta grant gets a 14-day trial
              with up to {TRIAL_PAGE_LIMIT} published pages, no card required.
            </li>
            <li>
              <strong>Drafts.</strong> Unlimited and always free. Only a page you set live uses a
              publishing slot.
            </li>
            <li>
              {/* "currently": the enforced cap is a platform_settings knob ops can
                  lower without a deploy (src/lib/generation-limits.ts). Scoped to
                  the grant: a trial is metered after its starter allowance, so it
                  must not be promised included generation. */}
              <strong>AI generation.</strong> Included with a beta grant, within a fair-use cap
              (currently {GENERATION_DAILY_CAP} generated pages per workspace per day). Trial
              workspaces get a starter allowance. Generating a draft never uses a publishing slot.
            </li>
          </ul>

          <h2 id="what-costs-money">What costs money</h2>
          <p>
            Only a paid plan, and only if you choose one. Plans are priced by published-page
            capacity — every core feature is available on every plan:
          </p>
          <ul>
            {PAGE_PLANS.map((p) => (
              <li key={p.key}>
                <strong>{p.name}</strong> — ${p.monthlyPrice}/month for{" "}
                {p.includedPages.toLocaleString()} published pages.
              </li>
            ))}
            <li>
              <strong>Extra capacity</strong> — ${PAGE_ADDON.monthlyPrice}/month per{" "}
              {PAGE_ADDON.pagesPerUnit.toLocaleString()} pages, on top of any plan.
            </li>
            <li>
              <strong>Add-ons</strong> — Affiliate Programs and DM Champ are optional monthly add-ons,
              priced separately on the Add-ons page in the app. They only start after a checkout you
              complete.
            </li>
          </ul>
          <p>
            That is ${cheapest.monthlyPrice} to ${dearest.monthlyPrice} per month. Nothing is
            charged without a checkout you complete yourself, and a beta grant does not turn into a
            subscription when it ends.
          </p>

          <h2 id="when-access-ends">What happens when access ends</h2>
          <p>
            If your beta grant or trial ends and you have not picked a plan, your published pages{" "}
            <strong>pause</strong>: they stop being served on your domain. Nothing is deleted.
          </p>
          <ul>
            <li>Drafts, settings, templates and your connected domain are kept.</li>
            <li>
              You can export your pages and listing data at any time from Data Export in the app.
            </li>
            <li>
              Pick a plan at any later date and every paused page returns at its original URL.
            </li>
            <li>You can reconnect or disconnect your Sharetribe marketplace at any time.</li>
          </ul>
          <p>
            A beta grant's end date is shown on your dashboard and billing page from the day it is
            set. We may extend, resize or end the beta program
            itself; if we do, the same rules apply — pages pause, nothing is deleted, and you keep
            your data.
          </p>

          <h2 id="data-handling">How we handle your Sharetribe data</h2>
          <ul>
            <li>
              <strong>Marketplace API client ID.</strong> This is what connects your marketplace. It
              gives read-only access to your <em>public</em> listing data — the same data any
              visitor to your marketplace can already see. We store your public listing data
              (titles, descriptions, categories, locations, images) to build and refresh your pages.
            </li>
            <li>
              <strong>Integration API secret.</strong> Optional, and only if you choose to add it.
              It is stored encrypted, used only for the integration features you turn on, and
              deleted when you disconnect.
            </li>
            <li>
              <strong>Disconnecting.</strong> Disconnecting your marketplace deletes the listing
              data we hold for it. Pages already generated from that data are yours and remain as
              drafts or published pages until you delete them.
            </li>
            <li>
              <strong>Deleting your account.</strong> Disconnect your marketplace, then email{" "}
              <a href="mailto:support@founders.click">support@founders.click</a> from the address on
              the account and we will delete the workspace, its pages and its data.
            </li>
          </ul>
          <p>
            Our <Link to="/privacy">Privacy Policy</Link> and <Link to="/terms">Terms</Link> apply
            throughout the beta.
          </p>

          <h2 id="no-guarantees">No guarantees about rankings</h2>
          <p>
            We generate, host and maintain pages. We do not control search engines and make no
            promise about rankings, traffic, indexing speed or revenue. Results depend on your
            listings, your market and your domain's history.
          </p>

          <h2 id="report-problems">How to report a problem</h2>
          <p>
            Use the <Link to="/help/contact">contact form</Link> — it files a ticket that reaches
            our support inbox — or email{" "}
            <a href="mailto:support@founders.click">support@founders.click</a>. Include your
            workspace name and, if it concerns a page, the page URL. During the beta we read every
            report; feature requests and rough edges are exactly what we want to hear.
          </p>

          <h2 id="independence">Independence</h2>
          <p>
            founders.click is an independent product and is not affiliated with or endorsed by
            Sharetribe. Sharetribe is a trademark of its owner, used here only to describe the
            marketplaces our product works with.
          </p>
        </article>
      </main>
      <SiteFooter />
    </div>
  );
}

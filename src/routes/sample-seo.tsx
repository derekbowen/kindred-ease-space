import { createFileRoute, Link } from "@tanstack/react-router";
import { CityHub } from "@/components/templates/CityHub";
import { SAMPLE_SEO_DATA } from "@/components/site/sample-seo-data";
import { canonicalUrl } from "@/lib/canonical";

export const Route = createFileRoute("/sample-seo")({
  head: () => ({
    meta: [
      { title: "Sample SEO page | founders.click" },
      { name: "description", content: SAMPLE_SEO_DATA.page.metaDescription! },
      { name: "robots", content: "noindex, follow" },
    ],
    links: [{ rel: "canonical", href: canonicalUrl("/sample-seo") }],
  }),
  component: SampleSeoPage,
});

function SampleSeoPage() {
  return (
    <>
      <aside
        aria-label="About this sample"
        className="border-b border-orange-300 bg-orange-50 px-5 py-5 text-slate-900"
      >
        <div className="mx-auto flex max-w-6xl flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="max-w-3xl">
            <p className="font-semibold">Sample SEO page · fictional marketplace</p>
            <p className="mt-1 text-sm leading-relaxed">
              The real Founders.click City Hub template with illustrative listings and artwork. No
              live inventory, prices or bookings. This sample is excluded from search indexing.
            </p>
          </div>
          <Link
            to="/"
            className="shrink-0 rounded-lg px-3 py-2 text-sm font-semibold underline underline-offset-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-orange-600"
          >
            Back to founders.click
          </Link>
        </div>
      </aside>
      <CityHub {...SAMPLE_SEO_DATA} basePath={null} demo />
      <section
        aria-label="Create your own page"
        className="bg-slate-950 px-5 py-10 text-center text-white"
      >
        <p className="mb-5 text-lg">Start with your own marketplace listings.</p>
        <Link
          to="/signup"
          className="inline-flex rounded-xl bg-orange-500 px-6 py-3 font-semibold text-black hover:bg-orange-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-orange-400"
        >
          Start your free trial
        </Link>
        <p className="mt-4 text-sm text-slate-300">
          Review and edit your draft before publishing. Domain setup is required for publishing on
          your verified domain.
        </p>
      </section>
    </>
  );
}

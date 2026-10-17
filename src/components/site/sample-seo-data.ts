import type { TemplateData } from "@/components/templates/types";

/** Public, fictional fixture. Never connected to a customer's workspace or inventory. */
export const SAMPLE_SEO_DATA: TemplateData = {
  branding: { name: "Harbor Workspaces · example marketplace", color: "#0f766e", logoUrl: null },
  marketplace: { homeUrl: null, browseUrl: null },
  page: {
    id: null,
    kind: "city_hub",
    slug: "workspaces-in-portland",
    title: "Workspaces in Portland",
    seoTitle: "Workspaces in Portland | Harbor Workspaces — sample",
    h1: "Find your next workspace in Portland",
    metaDescription:
      "An illustrative city page showing how Founders.click presents marketplace listings alongside an editable local guide.",
    intro:
      "A quiet desk for focused work, a shared studio for a creative afternoon, or a room for your next team session. See how a city page brings a marketplace's listings together.",
    bodyMarkdown:
      "## A space that fits your working day\n\nStart with the kind of work you need to do. A desk suits an individual work session; a meeting room gives a team room to collaborate. Compare the location and workspace details before deciding.\n\n## What to check before booking\n\nOn a real marketplace, open each listing to confirm its amenities, accessibility, house rules, price and availability with the host. The three listings above are fictional examples and cannot be booked.\n\n## From inventory to a useful city page\n\nThis example uses the same City Hub component as the product. In your workspace, the page draws on your own marketplace inventory; you review and edit the draft before publishing on your verified domain.",
    noindex: true,
    publishedAt: null,
    updatedAt: null,
    place: { city: "Portland", region: "OR", country: "US" },
    category: null,
    listingNoun: "workspaces",
    matchingListings: null,
    legacy: false,
  },
  listings: [
    {
      id: "sample-desk",
      title: "Quiet window desk · sample",
      location: "Portland, OR · illustrative",
      url: null,
      image: {
        url: "/samples/workspace-desk.svg",
        alt: "Illustration of a desk by a window; not a real listing photo",
        width: 640,
        height: 480,
      },
      price: null,
    },
    {
      id: "sample-studio",
      title: "Shared creative studio · sample",
      location: "Portland, OR · illustrative",
      url: null,
      image: {
        url: "/samples/workspace-studio.svg",
        alt: "Illustration of a shared studio; not a real listing photo",
        width: 640,
        height: 480,
      },
      price: null,
    },
    {
      id: "sample-meeting",
      title: "Team meeting room · sample",
      location: "Portland, OR · illustrative",
      url: null,
      image: {
        url: "/samples/workspace-meeting.svg",
        alt: "Illustration of a meeting table; not a real listing photo",
        width: 640,
        height: 480,
      },
      price: null,
    },
  ],
  related: [],
};

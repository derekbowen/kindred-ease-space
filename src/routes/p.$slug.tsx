import { createFileRoute, redirect } from "@tanstack/react-router";

// Legacy prefix. /a/ is the canonical public path for tenant pages (the
// Founders edge routes /a/* on customer domains); permanent-redirect old links
// and any indexed /p/ URLs so link equity consolidates on /a/. The slug is
// re-encoded so a decoded "/", "?" or "#" can never reshape the target.
export const Route = createFileRoute("/p/$slug")({
  loader: ({ params, location }) => {
    throw redirect({
      href: `/a/${encodeURIComponent(params.slug)}${location.searchStr ?? ""}`,
      statusCode: 301,
    });
  },
});

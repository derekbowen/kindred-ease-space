import { createFileRoute } from "@tanstack/react-router";
import { workspaceIdForHost } from "@/lib/sitemap.server";

// Domain-activation probe. After a customer domain's edge routing is
// configured, the provisioning service fetches https://{domain}/a/founders-domain-test
// and expects this exact marker — proving the request traversed the customer's
// DNS → edge router → Founders origin and that the host maps to a verified
// tenant. Static segment, so it wins over the /a/$slug dynamic route.
export const Route = createFileRoute("/a/founders-domain-test")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const host = (
          request.headers.get("x-forwarded-host") ||
          request.headers.get("host") ||
          ""
        )
          .split(",")[0]!
          .trim()
          .toLowerCase()
          .replace(/:\d+$/, "");
        const workspaceId = host ? await workspaceIdForHost(host) : null;
        const body = [
          "founders-click-domain-test: OK",
          `host: ${host || "unknown"}`,
          `tenant: ${workspaceId ? "resolved" : "not-connected"}`,
        ].join("\n");
        return new Response(body, {
          status: workspaceId ? 200 : 404,
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "no-store",
            "X-Robots-Tag": "noindex",
          },
        });
      },
    },
  },
});

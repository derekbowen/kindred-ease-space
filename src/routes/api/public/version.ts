/**
 * WHICH BUILD IS SERVING, ASKED DIRECTLY.
 *
 * CI compares this to the commit it just deployed, and a human can read it
 * without a Cloudflare login. Both matter: "the deploy went green" has already
 * been wrong here — the Lovable relay reported successful publishes while
 * shipping a tree eleven commits old, and nothing contradicted it. A build that
 * names its own commit is the only claim that cannot be stale, because the SHA
 * is compiled into the bundle rather than read at runtime (see build-info.ts).
 *
 * Why a dedicated route when /api/public/edge-health already answers GET with
 * the same three fields: that endpoint exists to receive stale-config reports
 * from the edge Worker, and it answers GET with build identity as a convenience.
 * Deployment tooling should not have to know that. A telemetry sink that
 * doubles as the version oracle is one refactor away from taking the version
 * check down with it, and the deploy workflow's propagation gate depends on
 * this answer being available. The two are kept deliberately separate; the GET
 * on edge-health stays where it is so existing callers keep working.
 *
 * NOTHING SENSITIVE. A commit SHA, a timestamp, and which environment answered.
 * No branch name, no token, no configuration, no dependency versions — the
 * question "which build is this" must never become "what is this Worker
 * configured with". It is unauthenticated because CI reads it before it can
 * prove anything, and because a public build identity is not a secret: the
 * repository it names is private, and the SHA discloses nothing on its own.
 */
import { createFileRoute } from "@tanstack/react-router";
import { buildInfo } from "@/lib/build-info";

/**
 * The host decides the label, not the build. The same artifact is promoted
 * rather than rebuilt per environment, so asking the bundle which environment
 * it is would answer with wherever it was built. Asking the request is honest:
 * this response came from this hostname.
 */
function environmentFor(request: Request): "production" | "preview" | "development" {
  let host = "";
  try {
    host = new URL(request.url).hostname.toLowerCase();
  } catch {
    return "development";
  }
  if (host === "founders.click" || host.endsWith(".founders.click")) return "production";
  if (host === "localhost" || host === "127.0.0.1" || host.endsWith(".local")) return "development";
  return "preview";
}

export const Route = createFileRoute("/api/public/version")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const info = buildInfo();
        return new Response(
          JSON.stringify({
            sha: info.sha,
            shaShort: info.shaShort,
            builtAt: info.builtAt,
            environment: environmentFor(request),
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              // Never cache: a cached version answer is indistinguishable from
              // a deploy that did not take, which is the exact failure this
              // endpoint exists to detect.
              "Cache-Control": "no-store, max-age=0",
            },
          },
        );
      },
    },
  },
});

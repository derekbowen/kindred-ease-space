/**
 * Bun preload that lets a Supabase Edge Function (Deno) be imported and driven
 * offline. Rewrites its remote imports onto the installed npm packages and
 * local fakes, and provides a Deno global whose serve() hands us the handler.
 *
 * Run: bun --preload ./tests/_preload/deno-edge-function.ts tests/<suite>.test.ts
 */
import { plugin } from "bun";
import { join } from "node:path";

const FAKES = join(import.meta.dir, "fakes");

plugin({
  name: "deno-edge-function-shims",
  setup(build) {
    build.onResolve({ filter: /^https:\/\/esm\.sh\/stripe@/ }, () => ({
      path: join(FAKES, "stripe.ts"),
    }));
    build.onResolve({ filter: /^https:\/\/esm\.sh\/@supabase\/supabase-js@/ }, () => ({
      path: join(FAKES, "supabase-js.ts"),
    }));
  },
});

type Handler = (req: Request) => Promise<Response> | Response;
const g = globalThis as unknown as {
  Deno?: unknown;
  __edgeHandler?: Handler;
  __edgeEnv: Record<string, string | undefined>;
};
g.__edgeEnv = {};
g.Deno = {
  env: { get: (k: string) => g.__edgeEnv[k] },
  serve: (h: Handler) => {
    g.__edgeHandler = h;
  },
};

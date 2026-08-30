// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - tanstackStart, viteReact, tailwindcss, tsConfigPaths, cloudflare (build-only),
//     componentTagger (dev-only), VITE_* env injection, @ path alias, React/TanStack dedupe,
//     error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... } }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

// Build identity, compiled into the bundle so the running Worker can name the
// commit it was built from. CI deploys, then asks production which build it is
// and compares against the SHA it just shipped. A green deploy log is not
// evidence — the previous pipeline produced those while serving stale code.
//
// GITHUB_SHA is set by GitHub Actions. Locally these fall back to "dev".
const BUILD_SHA = process.env.GITHUB_SHA || process.env.BUILD_SHA || "dev";
const BUILD_TIME = process.env.GITHUB_SHA ? new Date().toISOString() : "dev";

// Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
// @cloudflare/vite-plugin builds from this — wrangler.jsonc main alone is insufficient.
export default defineConfig({
  tanstackStart: {
    server: { entry: "server" },
  },
  vite: {
    define: {
      __BUILD_SHA__: JSON.stringify(BUILD_SHA),
      __BUILD_TIME__: JSON.stringify(BUILD_TIME),
    },
  },
});

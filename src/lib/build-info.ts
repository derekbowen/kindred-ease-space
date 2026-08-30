/**
 * BUILD IDENTITY.
 *
 * Values are substituted at build time by Vite's `define` (see vite.config.ts),
 * so they are baked into the bundle rather than read from the environment. A
 * Worker cannot lie about which build it is: the string is literally compiled in.
 *
 * This exists because "the deploy went green" turned out not to mean "the new
 * code is serving". The Lovable relay reported successful publishes while
 * shipping a tree eleven commits old, and nothing anywhere contradicted it.
 * Checking that a route EXISTS is not enough either — a route added three
 * releases ago still exists. The only trustworthy check is the running build
 * naming its own commit and CI comparing that to the commit it just deployed.
 */

declare const __BUILD_SHA__: string;
declare const __BUILD_TIME__: string;

function readDefine(read: () => string, fallback: string): string {
  // In dev, and in any context where the define did not apply, the identifier
  // is undefined rather than replaced — hence the guarded read.
  try {
    const v = read();
    return typeof v === "string" && v.length > 0 ? v : fallback;
  } catch {
    return fallback;
  }
}

/** Full git SHA of the commit this bundle was built from, or "dev". */
export const BUILD_SHA: string = readDefine(() => __BUILD_SHA__, "dev");

/** ISO timestamp of the build, or "dev". */
export const BUILD_TIME: string = readDefine(() => __BUILD_TIME__, "dev");

export const BUILD_SHA_SHORT: string =
  BUILD_SHA === "dev" ? "dev" : BUILD_SHA.slice(0, 7);

export type BuildInfo = {
  sha: string;
  shaShort: string;
  builtAt: string;
};

export function buildInfo(): BuildInfo {
  return { sha: BUILD_SHA, shaShort: BUILD_SHA_SHORT, builtAt: BUILD_TIME };
}

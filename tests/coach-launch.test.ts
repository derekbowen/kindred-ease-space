/**
 * THE COACH IS DEFERRED. Run: bun tests/coach-launch.test.ts
 *
 * Launch hid the Coach chat behind a switch (coach-availability.ts): its nav
 * entry was `launch: false`, every entry point asked that switch, and
 * ?showStubs=1 brought them all back for internal testing. The MVP scope
 * (owner, 2026-09-28) defers the Coach AND the daily briefing outright, for
 * every workspace — the founder / internal unlimited one included — so the
 * switch itself is gone:
 *
 *   - no sidebar entry for /app/coach or /app/seo-coach, and nothing that
 *     can reveal one (no ?showStubs=1, no founder flag);
 *   - no entry point renders: the floating launcher is gone from the shell,
 *     InlineCoach renders nothing whatever it is given, the dashboard has no
 *     Coach card and no daily briefing, and no screen links to /app/coach;
 *   - both routes redirect to /app before they load;
 *   - the panel still makes no network call, and nothing calls coach-chat;
 *   - the server refuses: every Coach and briefing handler asks the feature
 *     gate first (tests/mvp-surface.test.ts drives the gate itself).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { isRedirect } from "@tanstack/react-router";
import { NAV_SECTIONS, visibleNavSections } from "../src/lib/app-nav";
import { InlineCoach } from "../src/components/coach/InlineCoach";

let pass = 0,
  fail = 0;
const failed: string[] = [];
function t(name: string, cond: boolean, extra = "") {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    failed.push(name);
    console.log(`  FAIL  ${name}  ${extra}`);
  }
}

const ROOT = join(import.meta.dir, "..");
const read = (rel: string) =>
  existsSync(join(ROOT, rel)) ? readFileSync(join(ROOT, rel), "utf8") : "";
/** Source without comments: what runs, not what the prose mentions. */
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(relative(ROOT, p));
  }
  return out;
}
const components = walk(join(ROOT, "src/components"));
const routes = walk(join(ROOT, "src/routes"));
const src = walk(join(ROOT, "src"));
const ui = [...routes, ...components];

/** Run `fn` with a browser-like window whose URL query is `search`. */
function withUrl<T>(search: string, fn: () => T): T {
  const g = globalThis as { window?: unknown };
  const had = "window" in g;
  const prev = g.window;
  g.window = { location: { search } };
  try {
    return fn();
  } finally {
    if (had) g.window = prev;
    else delete g.window;
  }
}

// ---------------------------------------------------------------------------
console.log("\nno sidebar entry, and nothing can reveal one");

const COACH_ROUTES = ["/app/coach", "/app/seo-coach"];
t(
  "the nav catalog has no Coach or SEO Coach entry",
  NAV_SECTIONS.every((s) => s.items.every((i) => !COACH_ROUTES.includes(i.to))),
);
for (const platformAdmin of [false, true]) {
  for (const search of ["", "?showStubs=1"]) {
    const visible = withUrl(search, () =>
      visibleNavSections({ platformAdmin }).flatMap((s) => s.items.map((i) => i.to)),
    );
    t(
      `platformAdmin ${platformAdmin}, URL "${search || "(none)"}": no Coach entry`,
      COACH_ROUTES.every((r) => !visible.includes(r)),
      visible.join(","),
    );
  }
}
t(
  "the reveal switch is gone (coach-availability.ts and CoachLauncher.tsx deleted)",
  !existsSync(join(ROOT, "src/components/coach/coach-availability.ts")) &&
    !existsSync(join(ROOT, "src/components/coach/CoachLauncher.tsx")),
);
const importers = src.filter((f) => /coach-availability|CoachLauncher|useCoachEnabled|isCoachEnabled/.test(code(read(f))));
t("nothing imports or calls it", importers.length === 0, importers.join(", "));
const showStubs = src.filter((f) => /showStubs/.test(code(read(f))));
t("no source reads ?showStubs any more", showStubs.length === 0, showStubs.join(", "));

// ---------------------------------------------------------------------------
console.log("\nno entry point renders");

for (const label of ["Ask coach about sync", "Ask coach about SEO", "Coach", undefined]) {
  for (const search of ["", "?showStubs=1"]) {
    const html = withUrl(search, () =>
      renderToStaticMarkup(
        createElement(InlineCoach, { workspaceId: "ws-1", ...(label ? { label } : {}) }),
      ),
    );
    t(`InlineCoach "${label ?? "(default)"}" renders nothing (URL "${search || "(none)"}")`, html === "", html);
  }
}
const inline = code(read("src/components/coach/InlineCoach.tsx"));
t(
  "InlineCoach returns null unconditionally: no panel, no button, no hook",
  /return null;/.test(inline) && !/CoachPanel|<Button|useState|useEffect/.test(inline),
);
const shell = code(read("src/routes/_authenticated/app.tsx"));
t("the shell mounts no Coach component", !/components\/coach/.test(shell) && !/<Coach/.test(shell));
const panelUsers = ui.filter(
  (f) => f !== "src/components/coach/CoachPanel.tsx" && /<CoachPanel\b/.test(code(read(f))),
);
t("CoachPanel is mounted by nothing", panelUsers.length === 0, panelUsers.join(", "));
const coachLinks = ui.filter(
  (f) =>
    f !== "src/routes/_authenticated/app.coach.tsx" &&
    f !== "src/routes/_authenticated/app.seo-coach.tsx" &&
    /["'`]\/app\/(seo-)?coach["'`]/.test(code(read(f))),
);
t("no screen links to /app/coach or /app/seo-coach", coachLinks.length === 0, coachLinks.join(", "));
const askCoach = ui.filter((f) => /Ask [Cc]oach/.test(code(read(f))));
t(
  '"Ask coach" survives only as a label handed to the no-op InlineCoach',
  askCoach.every((f) => /<InlineCoach\b/.test(read(f))),
  askCoach.join(", "),
);

const dash = read("src/routes/_authenticated/app.index.tsx");
t("the dashboard imports no Coach component", !/components\/coach/.test(dash));
t("the dashboard renders no daily briefing and no Coach card", !/DailyBriefing|coachEnabled|Ask Coach/.test(code(dash)));
const briefingUsers = ui.filter(
  (f) => f !== "src/components/coach/DailyBriefing.tsx" && /DailyBriefing/.test(code(read(f))),
);
t(
  "DailyBriefing.tsx is kept as dormant code but mounted nowhere",
  existsSync(join(ROOT, "src/components/coach/DailyBriefing.tsx")) && briefingUsers.length === 0,
  briefingUsers.join(", "),
);

// ---------------------------------------------------------------------------
console.log("\nboth routes redirect to /app before they load");

for (const file of ["app.coach", "app.seo-coach"]) {
  const mod = await import(`../src/routes/_authenticated/${file}.tsx`);
  const beforeLoad = mod.Route?.options?.beforeLoad as undefined | ((ctx: unknown) => unknown);
  let thrown: unknown = null;
  try {
    await beforeLoad?.({});
  } catch (e) {
    thrown = e;
  }
  const to = (thrown as { options?: { to?: string } } | null)?.options?.to;
  t(`${file}: beforeLoad throws a redirect to /app`, isRedirect(thrown) && to === "/app", String(to));
}

// ---------------------------------------------------------------------------
console.log("\nthe panel makes no network call; nothing in src/components calls coach-chat");

const panel = code(read("src/components/coach/CoachPanel.tsx"));
t("CoachPanel shows a plain 'Coach is coming soon' state", /Coach is coming soon\./.test(panel));
for (const [label, re] of [
  ["fetch()", /\bfetch\s*\(/],
  ["coach-chat", /coach-chat/],
  ["an edge-function URL", /functions\/v1/],
  ["the Supabase client", /supabase/i],
  ["coach server functions", /@\/lib\/coach/],
  ["useQuery", /\buseQuery\b/],
  ["useMutation", /\buseMutation\b/],
  ["useServerFn", /\buseServerFn\b/],
  ["XMLHttpRequest / sendBeacon / EventSource", /XMLHttpRequest|sendBeacon|EventSource/],
] as const) {
  t(`CoachPanel has no ${label}`, !re.test(panel));
}
const callers = components.filter((f) => /coach-chat|functions\/v1\/coach/.test(code(read(f))));
t("no file under src/components calls coach-chat", callers.length === 0, callers.join(", "));

// ---------------------------------------------------------------------------
console.log("\nthe server refuses: every Coach and briefing handler asks the gate first");

const coachFns = read("src/lib/coach.functions.ts");
const handlers = [...coachFns.matchAll(/export const (\w+) = createServerFn\(/g)].map((m) => m[1]!);
t("coach.functions.ts still has its eight handlers", handlers.length === 8, handlers.join(","));
for (const name of handlers) {
  const at = coachFns.indexOf(`export const ${name} = createServerFn(`);
  const next = coachFns.indexOf("\nexport ", at + 1);
  const block = coachFns.slice(at, next < 0 ? undefined : next);
  t(
    `${name}: the first statement is assertFeatureAvailable("coach" | "briefing")`,
    /\.handler\(async \([^)]*\)[^{]*=> \{\s*await assertFeatureAvailable\("(coach|briefing)"\);/.test(block),
  );
}
const briefingServer = read("src/lib/coach-briefing.server.ts");
for (const fn of ["refreshBriefing", "requestBriefing"]) {
  const at = briefingServer.indexOf(`export async function ${fn}(`);
  const body = briefingServer.slice(at, briefingServer.indexOf("\n}", at));
  t(
    `${fn} asks the gate before anything else`,
    at > 0 && /\): Promise<BriefingRequestResult> \{\s*await assertFeatureAvailable\("briefing", deps\.features\);/.test(body),
  );
}

// MVP: the page editor has no coach at all (the coach is deferred).
t(
  "the page editor mounts no coach",
  !/InlineCoach|CoachPanel|CoachLauncher/.test(
    read("src/routes/_authenticated/app.pages.$id.edit.tsx"),
  ),
);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("Failed:\n  " + failed.join("\n  "));
  process.exit(1);
}

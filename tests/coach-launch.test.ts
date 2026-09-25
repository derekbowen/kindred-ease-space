/**
 * COACH IS OFF FOR LAUNCH. Run: bun tests/coach-launch.test.ts
 *
 * The Coach chat is not part of launch and its backend (the coach-chat edge
 * function) is being removed. Its sidebar entry was already `launch: false`,
 * but other entry points still rendered in the launch build: the floating
 * launcher (orange sparkle, bottom-right, ⌘J) on every app page, "Ask coach
 * about sync" on the Sharetribe page, "Ask coach about SEO", the page
 * editor's "Coach" button and the dashboard's "Ask Coach" link — and the
 * panel they open posted to coach-chat.
 *
 * Pinned here: every entry point follows the Coach's own nav entry through
 * the sidebar's rule (coach-availability.ts), none renders in a launch build,
 * the panel makes no network call at all, no component calls coach-chat, and
 * the DailyBriefing card stays on the dashboard.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { isNavItemVisible } from "../src/lib/app-nav";
import {
  COACH_ROUTE,
  coachNavItem,
  isCoachEnabled,
  showStubsInUrl,
} from "../src/components/coach/coach-availability";
import { CoachLauncher } from "../src/components/coach/CoachLauncher";
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
console.log("\nthe switch is the Coach's nav entry, read the sidebar's way");

const item = coachNavItem();
t("the Coach nav entry, if any, points at /app/coach", !item || item.to === COACH_ROUTE);
t("the Coach is not a launch item", !item || !item.launch);
t("a customer's launch build: Coach off", isCoachEnabled({ showStubs: false }) === false);
t(
  "the internal dogfood workspace: Coach off too",
  isCoachEnabled({ showStubs: false, isInternal: true }) === false,
);
t(
  "the switch agrees with isNavItemVisible for every combination",
  [false, true].every((showStubs) =>
    [false, true].every(
      (isInternal) =>
        isCoachEnabled({ showStubs, isInternal }) ===
        (item ? isNavItemVisible(item, { showStubs, isInternal }) : false),
    ),
  ),
);
t("no ?showStubs=1 in the URL → not revealed", withUrl("", () => showStubsInUrl()) === false);
t("?showStubs=1 is read from the URL", withUrl("?showStubs=1", () => showStubsInUrl()) === true);
t("?showStubs=0 does not reveal", withUrl("?showStubs=0", () => showStubsInUrl()) === false);
t("no window (SSR) → not revealed", showStubsInUrl() === false);

// ---------------------------------------------------------------------------
console.log("\nno entry point renders in the launch build");

const launcherHtml = renderToStaticMarkup(createElement(CoachLauncher, { workspaceId: "ws-1" }));
t("the floating launcher renders nothing", launcherHtml === "", launcherHtml);
for (const label of ["Ask coach about sync", "Ask coach about SEO", "Coach", undefined]) {
  const html = renderToStaticMarkup(
    createElement(InlineCoach, { workspaceId: "ws-1", ...(label ? { label } : {}) }),
  );
  t(`InlineCoach "${label ?? "Ask coach"}" renders nothing`, html === "", html);
}
const revealedFirstPaint = withUrl("?showStubs=1", () =>
  renderToStaticMarkup(createElement(CoachLauncher, { workspaceId: "ws-1" })),
);
t(
  "even with ?showStubs=1 the first render is empty (decided after mount: no hydration mismatch)",
  revealedFirstPaint === "",
  revealedFirstPaint,
);

const availability = read("src/components/coach/coach-availability.ts");
t("useCoachEnabled starts false", /useState\(false\)/.test(availability));
t(
  "useCoachEnabled decides from the nav rule and the URL",
  /setEnabled\(isCoachEnabled\(\{ showStubs: showStubsInUrl\(\) \}\)\)/.test(availability) &&
    /isNavItemVisible\(/.test(availability),
);

const launcher = read("src/components/coach/CoachLauncher.tsx");
const launcherGate = launcher.indexOf("if (!enabled || !workspaceId) return null;");
t(
  "CoachLauncher asks the switch before rendering",
  /const enabled = useCoachEnabled\(\);/.test(launcher) && launcherGate > 0,
);
t(
  "the ⌘J shortcut is registered only by the rendered button, never while the Coach is off",
  launcher.indexOf('addEventListener("keydown"') >
    launcher.indexOf("function CoachLauncherButton") &&
    launcher.indexOf("function CoachLauncherButton") > launcherGate,
);
const inline = read("src/components/coach/InlineCoach.tsx");
t(
  "InlineCoach asks the switch before rendering",
  /const enabled = useCoachEnabled\(\);/.test(inline) &&
    /if \(!enabled \|\| !workspaceId\) return null;/.test(inline),
);

console.log("\nevery entry point goes through the switch");
const panelUsers = ui.filter((f) => /<CoachPanel\b/.test(read(f)));
t(
  "CoachPanel is opened only by the gated launcher and InlineCoach",
  panelUsers.every(
    (f) =>
      f === "src/components/coach/CoachLauncher.tsx" ||
      f === "src/components/coach/InlineCoach.tsx",
  ),
  panelUsers.join(", "),
);
const coachLinks = ui.filter(
  (f) => f !== "src/routes/_authenticated/app.coach.tsx" && /to="\/app\/coach"/.test(read(f)),
);
t(
  "every link to /app/coach is behind the switch",
  coachLinks.every(
    (f) =>
      /useCoachEnabled\(\)/.test(read(f)) &&
      /\{coachEnabled && \(\s*<Button[\s\S]*?to="\/app\/coach"/.test(read(f)),
  ),
  coachLinks.join(", "),
);
const askCoach = ui.filter((f) => /Ask [Cc]oach/.test(read(f)));
t(
  '"Ask coach" appears only as an InlineCoach label or behind the switch',
  askCoach.every(
    (f) =>
      f === "src/components/coach/InlineCoach.tsx" ||
      /<InlineCoach\b/.test(read(f)) ||
      /useCoachEnabled\(\)/.test(read(f)),
  ),
  askCoach.join(", "),
);
const shell = read("src/routes/_authenticated/app.tsx");
t(
  "the shell mounts the gated launcher, not the panel",
  shell.includes('import { CoachLauncher } from "@/components/coach/CoachLauncher";') &&
    !/<CoachPanel\b/.test(shell),
);
for (const f of [
  "src/routes/_authenticated/app.settings.integrations.sharetribe.tsx",
  "src/routes/_authenticated/app.seo.content-health.tsx",
  "src/routes/_authenticated/app.pages.$id.edit.tsx",
]) {
  const src = read(f);
  t(
    `${f} uses the gated InlineCoach`,
    !src ||
      (src.includes('import { InlineCoach } from "@/components/coach/InlineCoach";') &&
        !/<CoachPanel\b/.test(src)),
  );
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
t(
  "CoachPanel has no send box to type into",
  !/<Textarea\b/.test(panel) && !/\bsend\s*\(/.test(panel),
);
const callers = components.filter((f) => /coach-chat|functions\/v1\/coach/.test(code(read(f))));
t("no file under src/components calls coach-chat", callers.length === 0, callers.join(", "));

// ---------------------------------------------------------------------------
console.log("\nthe DailyBriefing card stays");

const dash = read("src/routes/_authenticated/app.index.tsx");
t(
  "DailyBriefing.tsx is still there",
  existsSync(join(ROOT, "src/components/coach/DailyBriefing.tsx")),
);
t(
  "the dashboard still renders it, not behind the Coach switch",
  /\{workspaceId && <DailyBriefing workspaceId=\{workspaceId\} \/>\}/.test(dash) &&
    !/coachEnabled && <DailyBriefing/.test(dash),
);
t(
  "DailyBriefing is not gated by the chat switch",
  !/useCoachEnabled/.test(read("src/components/coach/DailyBriefing.tsx")),
);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("Failed:\n  " + failed.join("\n  "));
  process.exit(1);
}

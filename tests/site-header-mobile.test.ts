/**
 * PHONE VISITORS CAN REACH SIGN IN AND HELP. Run: bun tests/site-header-mobile.test.ts
 *
 * The public header hid Help below `md` and Sign in (and the language
 * switcher) below `sm`, with no menu button, so a phone had no way to sign in.
 * The header now has a disclosure menu for small screens. Offline: source
 * assertions over the header and the public pages that render it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

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
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const collapse = (s: string) => s.replace(/\s+/g, " ");

const header = read("src/components/site/SiteHeader.tsx");
const flat = collapse(header);

/** Every opening JSX tag of one element name, attributes flattened. */
function tags(name: string): string[] {
  return flat.match(new RegExp(`<${name}\\b[^>]*>`, "g")) ?? [];
}
const classOf = (tag: string) => tag.match(/className="([^"]*)"/)?.[1] ?? "";
/** Hidden on phones: a bare `hidden` or `hidden` gated only at sm/md and up. */
const hiddenOnPhones = (cls: string) => /(^|\s)hidden(\s|$)/.test(cls);

// ---------------------------------------------------------------------------
console.log("\nthe menu button");

const button = tags("button").find((b) => b.includes("aria-controls"));
t("a button with aria-controls exists", !!button, tags("button").join(" | "));
t("it is a real button (type=button)", !!button && /type="button"/.test(button));
t("it reports aria-expanded from state", !!button && /aria-expanded=\{open\}/.test(button));
t(
  "aria-controls names the panel id",
  !!button && /aria-controls=\{SITE_MOBILE_MENU_ID\}/.test(button) &&
    /export const SITE_MOBILE_MENU_ID = "site-mobile-menu"/.test(header),
);
t("it has an accessible name", !!button && /aria-label=\{open \? "Close menu" : "Open menu"\}/.test(button));
t(
  "it shows below md (where Help leaves the bar) and never shrinks away",
  !!button && /\bmd:hidden\b/.test(classOf(button)) && !hiddenOnPhones(classOf(button).replace("md:hidden", "")) &&
    /\bshrink-0\b/.test(classOf(button)),
  button ? classOf(button) : "",
);
t("it toggles the menu", /onClick=\{\(\) => setOpen\(\(o\) => !o\)\}/.test(flat));

// ---------------------------------------------------------------------------
console.log("\nthe panel");

const panelTag = tags("div").find((d) => /id=\{SITE_MOBILE_MENU_ID\}/.test(d));
t("the panel carries the controlled id", !!panelTag);
t("the panel is hidden until opened", !!panelTag && /hidden=\{!open\}/.test(panelTag));
t(
  "the panel is visible on phones (only md:hidden, no bare hidden class)",
  !!panelTag && /\bmd:hidden\b/.test(classOf(panelTag)) && !hiddenOnPhones(classOf(panelTag)),
);
const panel = flat.slice(flat.indexOf("id={SITE_MOBILE_MENU_ID}"));
const panelLinks = (panel.match(/<Link\b[^>]*>/g) ?? []) as string[];
const panelSignIn = panelLinks.find((l) => /to="\/login"/.test(l));
t("the panel has a Sign in link", !!panelSignIn && panel.includes('{t("nav.signin")}'));
t(
  "that Sign in link is not behind an sm/md breakpoint",
  !!panelSignIn && !/\b(sm|md|lg):/.test(classOf(panelSignIn)) && !hiddenOnPhones(classOf(panelSignIn)),
  panelSignIn ?? "",
);
t("the panel has a Help link", panelLinks.some((l) => /to="\/help"/.test(l)));
t("the panel offers the language switcher", /<LanguageSwitcher \/>/.test(panel));
t("following a panel link closes the menu", panelLinks.every((l) => /onClick=\{close\}/.test(l)));

// ---------------------------------------------------------------------------
console.log("\nkeyboard and focus");

t("Escape closes the menu", /e\.key === "Escape"/.test(header) && /setOpen\(false\)/.test(header));
t("Escape returns focus to the button", /buttonRef\.current\?\.focus\(\)/.test(header));
t(
  "opening moves focus into the panel",
  /panelRef\.current\?\.querySelector<HTMLElement>\("a, button, select"\)\?\.focus\(\)/.test(header),
);
t("a tap outside the header closes it", /pointerdown/.test(header) && /contains\(e\.target as Node\)/.test(header));
t("a new page closes it", /useRouterState\(\{ select: \(s\) => s\.location\.pathname \}\)/.test(header));
t(
  "listeners are removed when it closes",
  /removeEventListener\("keydown", onKey\)/.test(header) &&
    /removeEventListener\("pointerdown", onPointer\)/.test(header),
);

// ---------------------------------------------------------------------------
console.log("\nthe desktop bar is unchanged");

const barSignIn = tags("Link").find((l) => /to="\/login"/.test(l) && /hidden sm:inline-flex/.test(l));
t("desktop Sign in still shows from sm up", !!barSignIn);
t("desktop Help nav still shows from md up", /<nav className="hidden md:flex/.test(flat));
t(
  "the trial button truncates rather than covering the menu button",
  /<Button asChild size="sm" className="min-w-0">/.test(flat) &&
    /<span className="truncate">\{t\("nav\.trial"\)\}<\/span>/.test(flat),
);

// ---------------------------------------------------------------------------
console.log("\nevery public page with a header uses this one");

for (const rel of [
  "src/routes/index.tsx",
  "src/routes/beta.tsx",
  "src/components/LegalLayout.tsx",
  "src/components/help/HelpHeader.tsx",
]) {
  const src = read(rel);
  t(
    `${rel} renders <SiteHeader />`,
    src.includes('import { SiteHeader } from "@/components/site/SiteHeader";') &&
      src.includes("<SiteHeader />"),
  );
}
t("/terms uses LegalLayout", read("src/routes/terms.tsx").includes("LegalLayout"));
t("/privacy uses LegalLayout", read("src/routes/privacy.tsx").includes("LegalLayout"));
t("/help's layout uses HelpHeader", read("src/routes/help.tsx").includes("<HelpHeader />"));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("Failed:\n  " + failed.join("\n  "));
  process.exit(1);
}

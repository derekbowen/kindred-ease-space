/**
 * DEPENDENCY SOURCES — every package from registry.npmjs.org.
 * Run: bun tests/dependency-registry.test.ts
 *
 * bun.lock used to resolve 181 of its 804 packages from Lovable's private npm
 * cache (europe-west{1,4}-npm.pkg.dev/lovable-core-prod/sandbox-npm-cache), so
 * every CI install — and therefore every release, hotfix and redeploy —
 * depended on a registry founders.click does not control. The entries were
 * re-pointed at the public registry with unchanged versions and byte-identical
 * sha512 integrity values (verified against registry.npmjs.org for all 180
 * distinct name@version, then a frozen install from an empty cache with every
 * host but registry.npmjs.org unreachable).
 *
 * This suite runs scripts/check-dependency-registry.mjs against the checkout,
 * and then proves the checker is not inert: each kind of foreign source it
 * exists to refuse must make it fail, and a lockfile it cannot read must exit
 * 2, never 0. Offline.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkRepo,
  isRegistrySpec,
  lockfileProblems,
  MIN_LOCK_PACKAGES,
  NPM_REGISTRY,
  packageJsonProblems,
  parseBunLock,
  registryConfigProblems,
  workflowProblems,
} from "../scripts/check-dependency-registry.mjs";

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
const SCRIPT = join(ROOT, "scripts/check-dependency-registry.mjs");

// ---------------------------------------------------------------------------
console.log("\nthis checkout");

const lockText = read("bun.lock");
const repo = checkRepo(ROOT);
t("the check ran (not fatal)", repo.fatal === null, String(repo.fatal));
t(
  "no dependency source problems",
  repo.problems.length === 0,
  repo.problems.slice(0, 5).join(" | "),
);
const lock = parseBunLock(lockText);
const entries = Object.entries(lock.packages as Record<string, unknown[]>);
t(
  `the lockfile parsed to a real tree (${entries.length} packages ≥ ${MIN_LOCK_PACKAGES})`,
  entries.length >= MIN_LOCK_PACKAGES && repo.packages === entries.length,
);
t(
  "bun.lock never mentions pkg.dev / lovable-core-prod / sandbox-npm-cache",
  !/pkg\.dev|lovable-core-prod|sandbox-npm-cache/i.test(lockText),
);
t(
  "every entry resolves from the default registry or registry.npmjs.org",
  entries.every(([, v]) => v[1] === "" || String(v[1]).startsWith(NPM_REGISTRY)),
);
t(
  "every entry is sha512-pinned",
  entries.every(([, v]) => /^sha512-/.test(String(v[3]))),
);
// The build wrapper stays only because it is a public npm package.
const wrapper = entries.find(([k]) => k === "@lovable.dev/vite-tanstack-config")?.[1];
t(
  "@lovable.dev/vite-tanstack-config resolves from the public registry (it is published on npmjs)",
  !!wrapper &&
    wrapper[1] === "" &&
    /^@lovable\.dev\/vite-tanstack-config@\d/.test(String(wrapper[0])),
);
t(
  "no .npmrc or bunfig.toml at the root",
  ![".npmrc", "bunfig.toml"].some((f) => existsSync(join(ROOT, f))),
);

// ---------------------------------------------------------------------------
console.log("\nCI runs the guard");

const pkg = JSON.parse(read("package.json"));
t(
  "`bun run test` chains this suite",
  /bun tests\/dependency-registry\.test\.ts/.test(pkg.scripts.test),
);
const deploy = read(".github/workflows/deploy-app.yml");
const guardAt = deploy.indexOf("bun scripts/check-dependency-registry.mjs");
const installAt = deploy.indexOf("bun install --frozen-lockfile");
t("deploy-app.yml runs the guard", guardAt > 0);
t(
  "…before the install, so a foreign registry is refused before anything is fetched",
  guardAt > 0 && installAt > guardAt,
);
t("the install stays frozen", installAt > 0);

// ---------------------------------------------------------------------------
console.log("\nthe checker refuses each foreign source");

const npmLine = (
  key: string,
  spec: string,
  url: string,
  integrity = "sha512-" + "A".repeat(86) + "==",
) => `    "${key}": ["${spec}", "${url}", { "dependencies": {} }, "${integrity}"],`;
const fakeLock = (lines: string[], filler = MIN_LOCK_PACKAGES) => {
  const pad = Array.from({ length: filler }, (_, i) =>
    npmLine(`pad-${i}`, `pad-${i}@1.0.${i}`, ""),
  );
  return `{\n  "lockfileVersion": 1,\n  "workspaces": {\n    "": {\n      "name": "x",\n      "dependencies": {\n        "a": "^1.0.0",\n      },\n    },\n  },\n  "packages": {\n${[...pad, ...lines].join("\n\n")}\n  }\n}\n`;
};

const clean = lockfileProblems(fakeLock([npmLine("marked", "marked@18.0.3", "")]));
t(
  "a default-registry entry is clean",
  clean.fatal === null && clean.problems.length === 0,
  clean.problems.join(" | "),
);
const explicitNpm = lockfileProblems(
  fakeLock([
    npmLine("marked", "marked@18.0.3", "https://registry.npmjs.org/marked/-/marked-18.0.3.tgz"),
  ]),
);
t(
  "an explicit registry.npmjs.org tarball URL is clean",
  explicitNpm.problems.length === 0,
  explicitNpm.problems.join(" | "),
);

const lovable = lockfileProblems(
  fakeLock([
    npmLine(
      "marked",
      "marked@18.0.3",
      "https://europe-west1-npm.pkg.dev/lovable-core-prod/sandbox-npm-cache/marked/-/marked-18.0.3.tgz",
    ),
  ]),
);
t(
  "the old Lovable cache URL is refused",
  lovable.problems.some((p) => /resolves from https:\/\/europe-west1-npm\.pkg\.dev/.test(p)),
);
t(
  "…and named as pkg.dev in the text scan",
  lovable.problems.some((p) => /mentions "pkg\.dev"/.test(p)),
);
const otherHost = lockfileProblems(
  fakeLock([npmLine("h3", "h3@2.0.1-rc.22", "https://npm.example.com/h3/-/h3-2.0.1-rc.22.tgz")]),
);
t(
  "any other registry host is refused",
  otherHost.problems.some((p) => /npm\.example\.com/.test(p)),
);
const git = lockfileProblems(
  fakeLock([
    `    "x": ["x@git+https://github.com/o/x.git#abc", { "dependencies": {} }, "o-x-abc"],`,
  ]),
);
t(
  "a git source is refused",
  git.problems.some((p) => /not a registry package|outside registry/.test(p)),
);
const gh = lockfileProblems(fakeLock([`    "x": ["x@github:o/x#abc", {}, "o-x-abc"],`]));
t(
  "a github: source is refused",
  gh.problems.some((p) => /not a registry package/.test(p)),
);
const tarball = lockfileProblems(
  fakeLock([`    "x": ["x@https://cdn.example.com/x-1.0.0.tgz", {}],`]),
);
t("a direct tarball source is refused", tarball.problems.length > 0);
const noIntegrity = lockfileProblems(fakeLock([npmLine("x", "x@1.0.0", "", "")]));
t(
  "an entry without a sha512 integrity is refused",
  noIntegrity.problems.some((p) => /no sha512 integrity/.test(p)),
);
const wsSpec = lockfileProblems(fakeLock([]).replace('"a": "^1.0.0"', '"a": "github:o/a"'));
t(
  "a workspace spec pointing at GitHub is refused",
  wsSpec.problems.some((p) => /workspace "" dependencies\.a/.test(p)),
);

console.log("\n…and never passes a lockfile it cannot read");
t("unparseable bun.lock → fatal", lockfileProblems("{ not json").fatal !== null);
t("no packages table → fatal", lockfileProblems('{ "lockfileVersion": 1 }').fatal !== null);
t("implausibly few packages → fatal", lockfileProblems(fakeLock([], 3)).fatal !== null);

console.log("\npackage.json specs");
for (const s of [
  "^1.2.3",
  "1.2.3",
  "~1",
  ">=1 <2",
  "3.0.260603-beta",
  "2.0.1-rc.22",
  "*",
  "latest",
  "npm:@scope/name@^1",
  "npm:string-width@4.2.3",
  "1 || 2",
])
  t(`registry spec: ${s}`, isRegistrySpec(s));
for (const s of [
  "https://europe-west4-npm.pkg.dev/lovable-core-prod/sandbox-npm-cache/x/-/x-1.0.0.tgz",
  "git+https://github.com/o/x.git",
  "github:o/x",
  "o/x",
  "file:../x",
  "link:x",
  "workspace:*",
  "npm:x@https://evil.example/x.tgz",
])
  t(`not a registry spec: ${s}`, !isRegistrySpec(s));
t(
  "package.json with a URL dependency is refused",
  packageJsonProblems({ dependencies: { x: "https://cdn.example.com/x.tgz" } }).length === 1,
);
t(
  "package.json publishConfig on another registry is refused",
  packageJsonProblems({ publishConfig: { registry: "https://npm.pkg.github.com" } }).length === 1,
);
t(
  "this package.json is clean",
  packageJsonProblems(pkg).length === 0,
  packageJsonProblems(pkg).join(" | "),
);

console.log("\nregistry config files and workflows");
t(
  ".npmrc pointing at the Lovable cache is refused",
  registryConfigProblems(
    ".npmrc",
    "registry=https://europe-west1-npm.pkg.dev/lovable-core-prod/sandbox-npm-cache/\n",
  ).length > 0,
);
t(
  ".npmrc scoped registry elsewhere is refused",
  registryConfigProblems(".npmrc", "@lovable.dev:registry=https://npm.example.com/\n").length > 0,
);
t(
  ".npmrc on registry.npmjs.org is clean",
  registryConfigProblems(".npmrc", "registry=https://registry.npmjs.org/\n").length === 0,
);
t(
  "bunfig.toml [install] registry elsewhere is refused",
  registryConfigProblems("bunfig.toml", '[install]\nregistry = "https://npm.example.com/"\n')
    .length > 0,
);
t(
  "bunfig.toml scoped registry elsewhere is refused",
  registryConfigProblems(
    "bunfig.toml",
    '[install.scopes]\nlovable = { url = "https://npm.example.com/" }\n',
  ).length > 0,
);
t(
  "workflow registry-url elsewhere is refused",
  workflowProblems("w.yml", "      with:\n        registry-url: https://npm.pkg.github.com\n")
    .length > 0,
);
t(
  "workflow NPM_CONFIG_REGISTRY elsewhere is refused",
  workflowProblems("w.yml", "    env:\n      NPM_CONFIG_REGISTRY: https://npm.example.com/\n")
    .length > 0,
);
t(
  "workflow `bun install` without --frozen-lockfile is refused",
  workflowProblems("w.yml", "        run: bun install\n").length > 0,
);
t(
  "workflow `bun install --frozen-lockfile` is clean",
  workflowProblems("w.yml", "        run: bun install --frozen-lockfile\n").length === 0,
);

// ---------------------------------------------------------------------------
console.log("\nthe CLI's exit codes (0 clean, 1 finding, 2 could not run)");

function cli(dir: string) {
  const r = spawnSync("node", [SCRIPT, dir], { encoding: "utf8" });
  return { code: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}
const tmp = mkdtempSync(join(tmpdir(), "dep-registry-"));
try {
  const mk = (name: string, files: Record<string, string>) => {
    const d = join(tmp, name);
    mkdirSync(d, { recursive: true });
    for (const [f, body] of Object.entries(files)) {
      mkdirSync(join(d, f, ".."), { recursive: true });
      writeFileSync(join(d, f), body);
    }
    return d;
  };
  const okPkg = JSON.stringify({ name: "x", dependencies: { a: "^1.0.0" } });
  const r0 = cli(ROOT);
  t("this checkout → exit 0", r0.code === 0, r0.out.slice(0, 300));
  const r1 = cli(
    mk("lovable", {
      "package.json": okPkg,
      "bun.lock": fakeLock([
        npmLine(
          "marked",
          "marked@18.0.3",
          "https://europe-west4-npm.pkg.dev/lovable-core-prod/sandbox-npm-cache/marked/-/marked-18.0.3.tgz",
        ),
      ]),
    }),
  );
  t("a Lovable-cache lockfile → exit 1", r1.code === 1, r1.out.slice(0, 300));
  const r2 = cli(
    mk("nested-npmrc", {
      "package.json": okPkg,
      "bun.lock": fakeLock([]),
      "apps/web/.npmrc": "registry=https://npm.example.com/\n",
    }),
  );
  t(
    "a nested .npmrc naming another registry → exit 1",
    r2.code === 1 && /apps\/web\/\.npmrc/.test(r2.out),
    r2.out.slice(0, 300),
  );
  const r3 = cli(
    mk("lockb", { "package.json": okPkg, "bun.lock": fakeLock([]), "bun.lockb": "\u0000binary" }),
  );
  t("a binary bun.lockb → exit 1", r3.code === 1, r3.out.slice(0, 300));
  const r4 = cli(mk("nolock", { "package.json": okPkg }));
  t("no bun.lock → exit 2 (could not run), never 0", r4.code === 2, r4.out.slice(0, 300));
  const r5 = cli(mk("garbage", { "package.json": okPkg, "bun.lock": "{ this is not a lockfile" }));
  t("an unparseable bun.lock → exit 2", r5.code === 2, r5.out.slice(0, 300));
  const r6 = cli(mk("tiny", { "package.json": okPkg, "bun.lock": fakeLock([], 2) }));
  t("a lockfile with 2 packages → exit 2", r6.code === 2, r6.out.slice(0, 300));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
console.log(
  "\nthe deployment doc no longer claims the build survives Lovable's registry vanishing",
);
const deployment = read("docs/DEPLOYMENT.md");
t(
  'DEPLOYMENT.md drops "if Lovable vanished tomorrow, the pinned version keeps building"',
  !/if Lovable vanished tomorrow/i.test(deployment),
);
t(
  "DEPLOYMENT.md says every package resolves from registry.npmjs.org",
  /registry\.npmjs\.org/.test(deployment),
);
t(
  "DEPLOYMENT.md names the guard",
  /check-dependency-registry\.mjs/.test(deployment) &&
    /dependency-registry\.test\.ts/.test(deployment),
);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("Failed:\n  " + failed.join("\n  "));
  process.exit(1);
}

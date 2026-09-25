#!/usr/bin/env node
/**
 * DEPENDENCY SOURCE GUARD — every package comes from the public npm registry.
 *
 *   node scripts/check-dependency-registry.mjs [repo root]
 *
 * Until 2026-09-25, bun.lock resolved 181 of its 804 packages (the Supabase
 * client, h3, marked, nitro, the rolldown/oxc native bindings, the Vite config
 * wrapper, …) from Lovable's private npm cache
 * (europe-west{1,4}-npm.pkg.dev/lovable-core-prod/sandbox-npm-cache). The
 * sha512 integrity values protect the content, not the availability: had that
 * registry gone away or started refusing anonymous reads, `bun install
 * --frozen-lockfile` — and with it every CI build, release, hotfix and
 * revert-and-redeploy — would have failed. Those entries were re-pointed at
 * registry.npmjs.org with byte-identical integrity values; this guard keeps it
 * that way.
 *
 * Refused:
 *   - a bun.lock entry resolved from anything but registry.npmjs.org (an
 *     explicit tarball URL on another host, a git/github/tarball/file/link
 *     source), an entry without a sha512 integrity, or any URL in the lockfile
 *     text that is not on registry.npmjs.org;
 *   - a package.json dependency spec that is not a registry version or range
 *     (URL, git, github shorthand, file:, link:, workspace:, …) or a
 *     publishConfig registry elsewhere;
 *   - an .npmrc / bunfig.toml / .yarnrc(.yml) anywhere in the repo, or a
 *     workflow, that names another registry;
 *   - a binary bun.lockb (it cannot be audited, and bun could read it).
 * Anywhere: "pkg.dev", "lovable-core-prod", "sandbox-npm-cache".
 *
 * Exit codes: 0 clean; 1 a finding; 2 the check could not run (no bun.lock, an
 * unparseable one, or one with implausibly few packages). A check that cannot
 * read its input must never report a pass (see tests/preflight-integrity.test.ts
 * for why this repo is strict about that).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const NPM_REGISTRY = "https://registry.npmjs.org/";

/** Names that identify the retired private mirror, wherever they appear. */
const FORBIDDEN = [/pkg\.dev/i, /lovable-core-prod/i, /sandbox-npm-cache/i];

/** Directories never scanned: installed or generated trees, not sources. */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".output",
  ".wrangler",
  "dist",
  ".tanstack",
  ".nitro",
  ".vinxi",
]);

const REGISTRY_CONFIG = new Set([
  ".npmrc",
  "bunfig.toml",
  ".bunfig.toml",
  ".yarnrc",
  ".yarnrc.yml",
]);
const OTHER_LOCKFILES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
]);

/** Fewer packages than this means the parse went wrong, not that the tree shrank. */
export const MIN_LOCK_PACKAGES = 100;

function forbiddenIn(text) {
  return FORBIDDEN.filter((re) => re.test(text)).map((re) => re.source.replace(/\\/g, ""));
}

/** Every http(s) URL in a text that is not on registry.npmjs.org. */
export function foreignUrls(text) {
  const out = [];
  for (const m of text.matchAll(/https?:\/\/[^\s"'`,;)\]}]+/g)) {
    if (!m[0].startsWith(NPM_REGISTRY)) out.push(m[0]);
  }
  return out;
}

/**
 * Is this a spec the npm registry resolves (a version, a range, a dist-tag or
 * an npm: alias)? Anything with a scheme or a slash is a direct source.
 */
export function isRegistrySpec(spec) {
  if (typeof spec !== "string") return false;
  let s = spec.trim();
  if (s.startsWith("npm:")) {
    // npm:<name>@<range> — the name may be scoped (@scope/name).
    const rest = s.slice(4);
    const at = rest.lastIndexOf("@");
    if (at <= 0) return false;
    const name = rest.slice(0, at);
    if (!/^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i.test(name)) return false;
    s = rest.slice(at + 1);
  }
  if (s === "" || s === "*" || s === "latest") return true;
  if (/[:/\\]/.test(s)) return false; // URL, git+…, github:, file:, link:, owner/repo, paths
  return /^[\w.\-+^~<>=| *]+$/.test(s);
}

/** Parse bun.lock (JSON with trailing commas). Throws when it cannot. */
export function parseBunLock(text) {
  return JSON.parse(text.replace(/,(\s*[}\]])/g, "$1"));
}

/**
 * Findings for a bun.lock text. `fatal` means the lockfile could not be
 * checked at all (exit 2), never a pass.
 */
export function lockfileProblems(text) {
  const problems = [];
  for (const f of forbiddenIn(text)) problems.push(`bun.lock mentions "${f}"`);
  for (const u of foreignUrls(text))
    problems.push(`bun.lock resolves from outside registry.npmjs.org: ${u}`);
  let lock;
  try {
    lock = parseBunLock(text);
  } catch (e) {
    return { problems, fatal: `bun.lock could not be parsed: ${e.message}`, packages: 0 };
  }
  const pkgs = lock && typeof lock === "object" ? lock.packages : null;
  if (!pkgs || typeof pkgs !== "object")
    return { problems, fatal: "bun.lock has no packages table", packages: 0 };
  const entries = Object.entries(pkgs);
  if (entries.length < MIN_LOCK_PACKAGES)
    return {
      problems,
      fatal: `bun.lock lists only ${entries.length} packages — refusing to call that clean`,
      packages: entries.length,
    };

  for (const [key, v] of entries) {
    if (!Array.isArray(v) || typeof v[0] !== "string") {
      problems.push(`bun.lock entry "${key}" has an unexpected shape`);
      continue;
    }
    const spec = v[0];
    const at = spec.lastIndexOf("@");
    const version = at > 0 ? spec.slice(at + 1) : "";
    // An npm-registry entry is exactly [name@version, registry-url, meta, integrity].
    const npmShape = v.length === 4 && typeof v[1] === "string" && typeof v[3] === "string";
    if (!npmShape || !/^[\w.\-+]+$/.test(version)) {
      problems.push(`bun.lock entry "${key}" (${spec}) is not a registry package`);
      continue;
    }
    if (v[1] !== "" && !v[1].startsWith(NPM_REGISTRY))
      problems.push(`bun.lock entry "${key}" (${spec}) resolves from ${v[1]}`);
    if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(v[3]))
      problems.push(`bun.lock entry "${key}" (${spec}) has no sha512 integrity`);
  }

  // The workspace section repeats package.json's specs; hold it to the same rule.
  for (const [ws, def] of Object.entries(lock.workspaces ?? {})) {
    for (const field of [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
    ]) {
      for (const [name, spec] of Object.entries(def?.[field] ?? {})) {
        if (!isRegistrySpec(spec))
          problems.push(
            `bun.lock workspace "${ws}" ${field}.${name} = "${spec}" is not a registry spec`,
          );
      }
    }
  }
  for (const [name, spec] of Object.entries(lock.overrides ?? {})) {
    if (!isRegistrySpec(spec))
      problems.push(`bun.lock override ${name} = "${spec}" is not a registry spec`);
  }
  return { problems, fatal: null, packages: entries.length };
}

/** Findings for a parsed package.json. */
export function packageJsonProblems(pkg, label = "package.json") {
  const problems = [];
  for (const f of forbiddenIn(JSON.stringify(pkg))) problems.push(`${label} mentions "${f}"`);
  for (const field of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
    "overrides",
    "resolutions",
  ]) {
    const deps = pkg?.[field];
    if (!deps || typeof deps !== "object") continue;
    for (const [name, spec] of Object.entries(deps)) {
      if (!isRegistrySpec(spec))
        problems.push(`${label} ${field}.${name} = ${JSON.stringify(spec)} is not a registry spec`);
    }
  }
  const pub = pkg?.publishConfig?.registry;
  if (pub && !String(pub).startsWith(NPM_REGISTRY))
    problems.push(`${label} publishConfig.registry = ${pub}`);
  return problems;
}

/** Findings for a registry config file (.npmrc, bunfig.toml, .yarnrc…). */
export function registryConfigProblems(label, text) {
  const problems = [];
  for (const f of forbiddenIn(text)) problems.push(`${label} mentions "${f}"`);
  for (const u of foreignUrls(text))
    problems.push(`${label} names a registry other than registry.npmjs.org: ${u}`);
  return problems;
}

/** Findings for a CI workflow: no registry override, installs frozen. */
export function workflowProblems(label, text) {
  const problems = [];
  for (const f of forbiddenIn(text)) problems.push(`${label} mentions "${f}"`);
  for (const line of text.split("\n")) {
    if (/^\s*#/.test(line)) continue;
    if (/registry/i.test(line)) {
      for (const u of foreignUrls(line))
        problems.push(`${label} points a registry setting at ${u}`);
    }
    if (/\bbun (install|i)\b/.test(line) && !/--frozen-lockfile/.test(line))
      problems.push(`${label} runs "${line.trim()}" without --frozen-lockfile`);
  }
  return problems;
}

function walk(dir, root, out) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(p, root, out);
    else out.push(relative(root, p));
  }
  return out;
}

/** Run every check against a checkout. */
export function checkRepo(root) {
  const problems = [];
  const lockPath = join(root, "bun.lock");
  if (!existsSync(lockPath)) return { problems, fatal: "bun.lock not found", packages: 0 };
  const lock = lockfileProblems(readFileSync(lockPath, "utf8"));
  problems.push(...lock.problems);
  if (lock.fatal) return { problems, fatal: lock.fatal, packages: lock.packages };

  const files = walk(root, root, []);
  for (const rel of files) {
    const base = rel.split(/[\\/]/).pop();
    if (base === "package.json") {
      let pkg;
      try {
        pkg = JSON.parse(readFileSync(join(root, rel), "utf8"));
      } catch (e) {
        problems.push(`${rel} could not be parsed: ${e.message}`);
        continue;
      }
      problems.push(...packageJsonProblems(pkg, rel));
    } else if (REGISTRY_CONFIG.has(base)) {
      problems.push(...registryConfigProblems(rel, readFileSync(join(root, rel), "utf8")));
    } else if (base === "bun.lockb") {
      problems.push(`${rel}: a binary lockfile cannot be audited — keep only the text bun.lock`);
    } else if (OTHER_LOCKFILES.has(base)) {
      problems.push(...registryConfigProblems(rel, readFileSync(join(root, rel), "utf8")));
    } else if (/^\.github[\\/]workflows[\\/].+\.ya?ml$/.test(rel)) {
      problems.push(...workflowProblems(rel, readFileSync(join(root, rel), "utf8")));
    }
  }
  return { problems, fatal: null, packages: lock.packages };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const ci = Boolean(process.env.GITHUB_ACTIONS);
  const root = resolve(process.argv[2] ?? join(fileURLToPath(import.meta.url), "..", ".."));
  const { problems, fatal, packages } = checkRepo(root);
  for (const p of problems) console.error(ci ? `::error::${p}` : `ERROR: ${p}`);
  if (fatal) {
    console.error(ci ? `::error::${fatal}` : `ERROR: ${fatal}`);
    console.error("The dependency source check did not run, so it cannot pass.");
    process.exit(2);
  }
  if (problems.length) {
    console.error(
      `${problems.length} dependency source problem(s). Every package must come from ${NPM_REGISTRY}.`,
    );
    process.exit(1);
  }
  console.log(
    `dependency sources: all ${packages} bun.lock packages resolve from ${NPM_REGISTRY} (sha512-pinned); no other registry configured`,
  );
}

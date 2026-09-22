#!/usr/bin/env node
/**
 * WORKER SECRET PREFLIGHT.
 *
 * Compares the secret names a deploy needs (scripts/required-secrets.txt)
 * against the names actually configured on the Worker (the JSON that
 * `wrangler secret list --format json` writes).
 *
 *   node scripts/check-required-secrets.mjs <manifest> <secrets.json>
 *
 * Exit codes, and the reason they are distinct:
 *   0  every [required] name is present ([recommended] misses only warn)
 *   1  a [required] name is missing — the deploy must not ship
 *   2  THIS CHECK COULD NOT RUN: the manifest is unreadable, parses to zero
 *      required names, or the secrets file is not a list. A check that cannot
 *      read its input must never report a pass.
 *
 * That last case is not hypothetical. This logic used to live inline in the
 * deploy workflow and read $GITHUB_WORKSPACE/scripts/required-secrets.txt,
 * which was correct until the app moved under apps/. Afterwards awk could not
 * open the file, the name loops iterated zero times, and the step printed
 * "all required secrets present" for a Worker that could be missing every one
 * of them — EMAILIT_API_KEY included. It lives here, out of the YAML, so that
 * failure mode is testable.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ci = Boolean(process.env.GITHUB_ACTIONS);
const err = (msg) => console.error(ci ? `::error::${msg}` : `ERROR: ${msg}`);
const warn = (msg) => console.error(ci ? `::warning::${msg}` : `WARNING: ${msg}`);

/**
 * Names in one [section] of the manifest. A name is the first token of a line
 * that starts in column 1 and is neither a comment nor a section header;
 * indented lines are continuations of the description above them.
 */
export function namesIn(text, want) {
  const names = [];
  let section = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("[")) {
      section = line.trim();
      continue;
    }
    if (/^\s*#/.test(line) || /^\s*$/.test(line) || /^\s/.test(line)) continue;
    if (section === `[${want}]`) {
      const name = line.trim().split(/\s+/)[0];
      if (name) names.push(name);
    }
  }
  return names;
}

function main() {
  const [manifestPath, secretsPath] = process.argv.slice(2);
  if (!manifestPath || !secretsPath) {
    err("usage: check-required-secrets.mjs <manifest> <secrets.json>");
    process.exit(2);
  }

  let manifest;
  try {
    manifest = readFileSync(manifestPath, "utf8");
  } catch (e) {
    err(`Secret manifest not readable at ${manifestPath}: ${e.message}`);
    err("This check did not run, so it cannot pass.");
    process.exit(2);
  }

  const required = namesIn(manifest, "required");
  const recommended = namesIn(manifest, "recommended");

  if (required.length === 0) {
    err(`Parsed 0 required secrets from ${manifestPath} — the manifest or its`);
    err("[required] section changed shape. Refusing to report a pass.");
    process.exit(2);
  }

  let configured;
  try {
    const parsed = JSON.parse(readFileSync(secretsPath, "utf8"));
    if (!Array.isArray(parsed)) throw new Error("expected a JSON array of {name}");
    configured = new Set(parsed.map((s) => s?.name).filter(Boolean));
  } catch (e) {
    err(`Could not read the Worker's secret list from ${secretsPath}: ${e.message}`);
    err("This check did not run, so it cannot pass.");
    process.exit(2);
  }

  const missing = required.filter((n) => !configured.has(n));
  const soft = recommended.filter((n) => !configured.has(n));

  console.log(`checking ${required.length} required and ${recommended.length} recommended secrets`);
  if (soft.length) warn(`Not set (code has defaults): ${soft.join(" ")}`);

  if (missing.length) {
    err(`Worker is missing REQUIRED secrets: ${missing.join(" ")}`);
    err("These have no default — the feature is broken without them.");
    err("Set each with: wrangler secret put <NAME>  (see docs/DEPLOYMENT.md)");
    err("Note: a name set as a plaintext Text variable is NOT a secret and will still report missing.");
    process.exit(1);
  }

  console.log("all required secrets present");
}

// Only run as a CLI. Importing this module (the tests do) must not exit.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}

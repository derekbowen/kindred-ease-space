#!/usr/bin/env bun
/**
 * Static canonical-URL audit.
 *
 * Walks the source tree and flags any string literal that points at the apex
 * (`founders.click` without `www`) or any `lovable.app` host outside the
 * allow-list. Also flags hard-coded canonical/og:url values that aren't built
 * with `canonicalUrl(...)`.
 *
 * Usage:
 *   bun run audit:urls
 *
 * Exit code is 0 when clean, 1 on any violation. Wire into CI when ready.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const SCAN_DIRS = ["src", "scripts"];
const SCAN_EXTS = [".ts", ".tsx"];

// Files that are allowed to mention forbidden hosts (the audit itself, etc).
const FILE_ALLOWLIST = new Set([
  "src/lib/canonical.ts",
  "src/lib/admin-canonical-audit.functions.ts",
  "src/lib/admin-canonical-audit.server.ts",
  "src/routes/_authenticated/app.seo.canonical-audit.tsx",
  "src/routes/api/public/hooks/canonical-audit.ts",
  "scripts/audit-canonical-urls.ts",
]);

// Hosts allowed to appear in any source file (asset CDN, Supabase, schema.org).
const HOST_ALLOWLIST = [
  "pub-bb2e103a32db4e198524a2e9ed8f35b4.r2.dev",
  "xbxhzinnfhosoztqaaao.supabase.co",
  "schema.org",
];

type Violation = { file: string; line: number; column: number; rule: string; snippet: string };

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith(".") || entry === "node_modules") continue;
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) yield* walk(full);
    else if (SCAN_EXTS.some((ext) => entry.endsWith(ext))) yield full;
  }
}

const APEX_RE = /https?:\/\/founders\.click(?![\w.-])/g;
const PREVIEW_RE = /https?:\/\/[^\s"'`<>]*lovable\.app/g;
const HARDCODED_CANONICAL_RE = /(rel:\s*["']canonical["'][^}]*href:\s*["'])([^"']+)/g;
const HARDCODED_OGURL_RE = /(property:\s*["']og:url["'][^}]*content:\s*["'])([^"']+)/g;
const ABSOLUTE_LINK_TO_RE = /<Link\b[^>]*\bto=\{?["']https?:\/\/([^"'`}\s]+)/g;

function audit(): Violation[] {
  const violations: Violation[] = [];

  for (const dir of SCAN_DIRS) {
    let entries: string[] = [];
    try {
      entries = [...walk(join(ROOT, dir))];
    } catch {
      continue;
    }
    for (const file of entries) {
      const rel = relative(ROOT, file).replace(/\\/g, "/");
      if (FILE_ALLOWLIST.has(rel)) continue;

      const content = readFileSync(file, "utf8");
      const lines = content.split("\n");

      const findLineCol = (idx: number) => {
        let pos = 0;
        for (let i = 0; i < lines.length; i++) {
          const len = lines[i].length + 1;
          if (idx < pos + len) return { line: i + 1, column: idx - pos + 1 };
          pos += len;
        }
        return { line: lines.length, column: 0 };
      };

      const push = (rule: string, idx: number, snippet: string) => {
        const { line, column } = findLineCol(idx);
        violations.push({ file: rel, line, column, rule, snippet: snippet.slice(0, 120) });
      };

      // Skip pure comment lines for some rules — they're docs.
      const commentMask = lines.map(
        (l) => l.trimStart().startsWith("//") || l.trimStart().startsWith("*"),
      );
      const isInComment = (idx: number) => {
        let pos = 0;
        for (let i = 0; i < lines.length; i++) {
          const len = lines[i].length + 1;
          if (idx < pos + len) return commentMask[i];
          pos += len;
        }
        return false;
      };

      for (const m of content.matchAll(APEX_RE)) {
        if (isInComment(m.index!)) continue;
        push("apex-host", m.index!, m[0]);
      }
      for (const m of content.matchAll(PREVIEW_RE)) {
        if (HOST_ALLOWLIST.some((h) => m[0].includes(h))) continue;
        if (isInComment(m.index!)) continue;
        push("preview-host", m.index!, m[0]);
      }
      for (const m of content.matchAll(HARDCODED_CANONICAL_RE)) {
        if (m[2].includes("canonicalUrl(") || m[2].includes("CANONICAL_ORIGIN")) continue;
        push("hardcoded-canonical", m.index!, m[0]);
      }
      for (const m of content.matchAll(HARDCODED_OGURL_RE)) {
        if (m[2].includes("canonicalUrl(") || m[2].includes("CANONICAL_ORIGIN")) continue;
        push("hardcoded-og-url", m.index!, m[0]);
      }
      for (const m of content.matchAll(ABSOLUTE_LINK_TO_RE)) {
        const host = m[1].split("/")[0];
        if (HOST_ALLOWLIST.includes(host)) continue;
        push("absolute-link-to", m.index!, m[0]);
      }
    }
  }

  return violations;
}

const violations = audit();
if (violations.length === 0) {
  console.log("✅ Canonical URL audit: 0 violations");
  process.exit(0);
}

const byFile = new Map<string, Violation[]>();
for (const v of violations) {
  if (!byFile.has(v.file)) byFile.set(v.file, []);
  byFile.get(v.file)!.push(v);
}

console.error(
  `❌ Canonical URL audit: ${violations.length} violation(s) in ${byFile.size} file(s)\n`,
);
for (const [file, vs] of byFile) {
  console.error(`  ${file}`);
  for (const v of vs) {
    console.error(`    ${v.line}:${v.column}  [${v.rule}]  ${v.snippet}`);
  }
  console.error("");
}
process.exit(1);

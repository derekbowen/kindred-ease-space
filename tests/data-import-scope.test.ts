/**
 * DATA IMPORT STAYS IN ITS OWN WORKSPACE. Run: bun tests/data-import-scope.test.ts
 *
 * importTable writes as the service role (past RLS). It forced workspace_id,
 * but it took the upsert's conflict target from the caller, and it trusted the
 * file's row ids behind a pre-write check. Production's legacy tables carry
 * unique keys that span ALL workspaces — content_pages (url_path),
 * (source_url), (slug) and content_plan (slug) — so either route overwrote
 * another workspace's page and moved it into the caller's workspace:
 *   - conflictColumn "url_path" (any caller-chosen target);
 *   - the id target with the other workspace's page id spelled differently
 *     (upper case, braces, no hyphens): Postgres matches it, the check's
 *     string comparison did not;
 *   - the id target with a malformed id in the same chunk: the check's lookup
 *     failed silently and the per-row retry wrote without it.
 * The same call accepted table "tenant_pages", and updateContentPageBasics
 * wrote tenant_pages.status: both skip publish_tenant_pages() and the page
 * limit.
 *
 * Now: the target is the server's and always includes workspace_id; the
 * file's id and workspace_id columns are dropped (buildImportRows); the input
 * schema is strict; import covers the two legacy tables only; and the bulk
 * editor refuses a tenant page status. Section 3 runs buildImportRows' real
 * output through the upsert's SQL on PGlite with production's unique indexes.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import {
  IMPORT_CONFLICT_TARGET,
  IMPORT_KEY_COLUMN,
  IMPORT_TABLES,
  ImportTableInputSchema,
  buildImportRows,
  parseCsv,
} from "../src/lib/admin-data-io.functions";

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

const WS = "11111111-1111-4111-8111-111111111111";
const accepts = (d: unknown) => ImportTableInputSchema.safeParse(d).success;

// ---------------------------------------------------------------------------
console.log("\n1. The input: the server picks the table set and the conflict target");

t(
  "import is limited to the two legacy tables",
  JSON.stringify(IMPORT_TABLES) === '["content_plan","content_pages"]',
);
for (const table of IMPORT_TABLES) {
  for (const mode of ["upsert", "insert"] as const) {
    t(
      `the page's own payload is accepted (${table}, ${mode})`,
      accepts({ workspaceId: WS, table, csv: "a,b\n1,2", mode, dryRun: true }),
    );
  }
}
t(
  "mode still defaults to upsert",
  ImportTableInputSchema.parse({ workspaceId: WS, table: "content_pages", csv: "a\n1" }).mode ===
    "upsert",
);
t(
  "table tenant_pages is refused (export-only)",
  !accepts({ workspaceId: WS, table: "tenant_pages", csv: "a\n1" }),
);
t(
  "table tenant_listings is refused",
  !accepts({ workspaceId: WS, table: "tenant_listings", csv: "a\n1" }),
);
for (const col of ["url_path", "source_url", "slug", "id", "workspace_id,slug"]) {
  t(
    `a caller-supplied conflictColumn "${col}" is refused`,
    !accepts({ workspaceId: WS, table: "content_pages", csv: "a\n1", conflictColumn: col }),
  );
}
t(
  "any other unknown key is refused too",
  !accepts({ workspaceId: WS, table: "content_plan", csv: "a\n1", onConflict: "slug" }),
);
t(
  "content_pages upserts on (workspace_id, url_path)",
  IMPORT_CONFLICT_TARGET.content_pages === "workspace_id,url_path" &&
    IMPORT_KEY_COLUMN.content_pages === "url_path",
);
t(
  "content_plan upserts on (workspace_id, slug)",
  IMPORT_CONFLICT_TARGET.content_plan === "workspace_id,slug" &&
    IMPORT_KEY_COLUMN.content_plan === "slug",
);
t(
  "every target includes workspace_id, and none is the row id",
  Object.values(IMPORT_CONFLICT_TARGET).every(
    (c) => c.split(",").includes("workspace_id") && !c.split(",").includes("id"),
  ),
);

const io = read("src/lib/admin-data-io.functions.ts");
const handler = io.slice(io.indexOf("export const importTable"));
t(
  "the handler takes the target from IMPORT_CONFLICT_TARGET and the rows from buildImportRows",
  /const conflictColumn = IMPORT_CONFLICT_TARGET\[data\.table\];/.test(handler) &&
    /= buildImportRows\(/.test(handler),
);
t(
  "nothing reads a caller's conflictColumn any more",
  !/data\.conflictColumn/.test(io) && !/conflictColumn: z\./.test(io),
);
t("the schema is strict", /ImportTableInputSchema = z[\s\S]*?\.strict\(\);/.test(io));
t(
  "no id-based pre-check is left to get wrong",
  !/foreignIds/.test(io) && !/Row belongs to another workspace/.test(io),
);
t(
  "every write sends the server's target",
  (handler.match(/onConflict: conflictColumn/g) || []).length === 2 &&
    !/onConflict: (?!conflictColumn)/.test(handler),
);
t(
  "export still covers the live page model and the listings",
  /const TABLES = \["content_plan", "content_pages", "tenant_pages"\] as const;/.test(io) &&
    /EXPORT_TABLES = \[\.\.\.TABLES, "tenant_listings"\]/.test(io),
);

const page = read("src/routes/_authenticated/app.content.data-import.tsx");
t(
  "the Data Import page offers exactly the two legacy tables",
  /type TableName = "content_plan" \| "content_pages";/.test(page) &&
    (page.match(/<TableImporter /g) || []).length === 2,
);
t(
  "the page sends only what the schema accepts",
  /run\(\{ data: \{ workspaceId, table, csv, mode, dryRun \} \}\)/.test(page) &&
    !/conflictColumn/.test(page),
);

// ---------------------------------------------------------------------------
console.log("\n2. buildImportRows: the file's id and workspace_id never reach a write");

const VICTIM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ATTACKER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const VICTIM_PAGE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const rowsFrom = (table: (typeof IMPORT_TABLES)[number], csv: string) => {
  const parsed = parseCsv(csv);
  return buildImportRows(table, parsed[0]!, parsed.slice(1), ATTACKER);
};
{
  const spellings = [
    VICTIM_PAGE,
    VICTIM_PAGE.toUpperCase(),
    `{${VICTIM_PAGE}}`,
    VICTIM_PAGE.replace(/-/g, ""),
    "not-a-uuid",
  ];
  const csv =
    "id,workspace_id,url_path,title\n" +
    spellings.map((s, i) => `${s},${VICTIM},/p${i},T${i}`).join("\n");
  const { validRows, rowErrors } = rowsFrom("content_pages", csv);
  t(
    "no row keeps an id, however it is spelled (canonical, upper, braced, bare, malformed)",
    validRows.length === spellings.length && validRows.every((r) => !("id" in r)),
    JSON.stringify(validRows),
  );
  t(
    "every row carries the session's workspace, never the file's",
    validRows.every((r) => r.workspace_id === ATTACKER),
  );
  t("no row was refused for its id", rowErrors.length === 0, JSON.stringify(rowErrors));
}
{
  const { validRows } = rowsFrom("content_pages", `"id","url_path"\n${VICTIM_PAGE},/q`);
  t("a quoted id header is dropped too", validRows.length === 1 && !("id" in validRows[0]!));
}
{
  const { validRows } = rowsFrom("content_pages", "ID,url_path\nx,/r");
  t(
    "a differently-cased ID header is kept as its own (unknown) column, never mapped to id",
    validRows.length === 1 && validRows[0]!.ID === "x" && !("id" in validRows[0]!),
  );
}
{
  const { validRows, rowErrors } = rowsFrom(
    "content_pages",
    "url_path,title\n/a,One\n,Missing\n/a,Again\n/b,Two",
  );
  t(
    "a row missing the key, or repeating it, is reported and not sent",
    validRows.length === 2 &&
      rowErrors.length === 2 &&
      rowErrors.some((e) => /Missing required "url_path"/.test(e.reason)) &&
      rowErrors.some((e) => /Duplicate "url_path"="\/a"/.test(e.reason)),
    JSON.stringify(rowErrors),
  );
}
{
  const { validRows, rowErrors } = rowsFrom("content_plan", "slug,title\naustin-tx,A\naustin-tx,B");
  t(
    "content_plan rows are keyed by slug",
    validRows.length === 1 && rowErrors[0]?.reason.includes('Duplicate "slug"') === true,
  );
}

// ---------------------------------------------------------------------------
console.log("\n3. LIVE: the upsert's SQL shape on production's unique keys (PGlite)");
{
  const db = await PGlite.create();
  // The unique indexes exactly as production has them (pg_indexes, 2026-09-28).
  await db.exec(`
    CREATE TABLE public.content_pages (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id uuid NOT NULL,
      url_path text, source_url text, slug text, title text, status text
    );
    CREATE UNIQUE INDEX content_pages_slug_key ON public.content_pages (slug) WHERE (slug IS NOT NULL);
    CREATE UNIQUE INDEX content_pages_source_url_key ON public.content_pages (source_url);
    CREATE UNIQUE INDEX content_pages_url_path_key ON public.content_pages (url_path);
    CREATE UNIQUE INDEX uq_content_pages_workspace_url ON public.content_pages (workspace_id, url_path);
    CREATE TABLE public.content_plan (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id uuid NOT NULL, slug text, title text
    );
    CREATE UNIQUE INDEX content_plan_slug_key ON public.content_plan (slug);
  `);
  const reset = async () => {
    await db.exec("TRUNCATE public.content_pages, public.content_plan");
    await db.query(
      "INSERT INTO public.content_pages (id, workspace_id, url_path, source_url, slug, title, status) VALUES ($1, $2, '/pool-rentals', 'https://v.example/pools', 'pool-rentals', 'Victim page', 'published')",
      [VICTIM_PAGE, VICTIM],
    );
    await db.query(
      "INSERT INTO public.content_plan (workspace_id, slug, title) VALUES ($1, 'austin-tx', 'Victim plan')",
      [VICTIM],
    );
  };
  const victimPage = async () =>
    (
      await db.query<{ workspace_id: string; title: string }>(
        "SELECT workspace_id, title FROM public.content_pages WHERE id = $1",
        [VICTIM_PAGE],
      )
    ).rows[0];
  const victimPlan = async () =>
    (
      await db.query<{ workspace_id: string; title: string }>(
        "SELECT workspace_id, title FROM public.content_plan WHERE slug = 'austin-tx'",
      )
    ).rows[0];
  const count = async (table: string) =>
    Number(
      (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.${table}`)).rows[0]!.n,
    );
  // PostgREST's upsert of ONE row (the handler's per-row retry): INSERT with the
  // row's own columns (quoted, so "ID" is not id) ON CONFLICT (<target>) DO
  // UPDATE SET every supplied column = EXCLUDED.column.
  const upsert = async (table: string, target: string, row: Record<string, unknown>) => {
    const cols = Object.keys(row);
    const q = (c: string) => `"${c.replace(/"/g, '""')}"`;
    const sql = `INSERT INTO public.${table} (${cols.map(q).join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})
      ON CONFLICT (${target}) DO UPDATE SET ${cols.map((c) => `${q(c)} = EXCLUDED.${q(c)}`).join(", ")}`;
    try {
      await db.query(sql, Object.values(row));
      return "ok";
    } catch (e) {
      return (e as { code?: string }).code ?? "error";
    }
  };

  // What the old code allowed.
  for (const target of ["url_path", "source_url"]) {
    await reset();
    const r = await upsert("content_pages", target, {
      workspace_id: ATTACKER,
      url_path: "/pool-rentals",
      source_url: "https://v.example/pools",
      title: "Hijacked",
    });
    const v = await victimPage();
    t(
      `(before) conflictColumn "${target}" took over the other workspace's page`,
      r === "ok" && v?.workspace_id === ATTACKER && v?.title === "Hijacked",
      `${r} ${JSON.stringify(v)}`,
    );
  }
  await reset();
  {
    const r = await upsert("content_pages", "id", {
      id: VICTIM_PAGE.toUpperCase(),
      workspace_id: ATTACKER,
      title: "Hijacked",
    });
    const v = await victimPage();
    t(
      "(before) the id target matched the other workspace's page through an upper-case id (the old string check missed it)",
      r === "ok" && v?.workspace_id === ATTACKER,
      `${r} ${JSON.stringify(v)}`,
    );
  }
  await reset();
  {
    let code = "";
    try {
      await db.query("SELECT id FROM public.content_pages WHERE id = ANY($1::uuid[])", [
        [VICTIM_PAGE, "not-a-uuid"],
      ]);
    } catch (e) {
      code = (e as { code?: string }).code ?? "error";
    }
    t(
      "(before) one malformed id failed the old check's whole lookup (22P02), which it ignored",
      code === "22P02",
      code,
    );
  }
  await reset();
  {
    const r = await upsert("content_plan", "slug", {
      workspace_id: ATTACKER,
      slug: "austin-tx",
      title: "Hijacked",
    });
    const v = await victimPlan();
    t(
      `(before) conflictColumn "slug" took over the other workspace's plan row`,
      r === "ok" && v?.workspace_id === ATTACKER,
      `${r} ${JSON.stringify(v)}`,
    );
  }

  // What the server does now: buildImportRows' own output, the server's target.
  const pagesTarget = IMPORT_CONFLICT_TARGET.content_pages;
  const attackCsv = [
    "id,workspace_id,url_path,source_url,title,status",
    `${VICTIM_PAGE.toUpperCase()},${VICTIM},/pool-rentals,,Hijacked,published`,
    `{${VICTIM_PAGE}},${VICTIM},/other,https://v.example/pools,Hijacked,published`,
    `not-a-uuid,${VICTIM},/mine,,Mine,draft`,
    `${VICTIM_PAGE},${VICTIM},/mine-2,,Mine 2,draft`,
  ].join("\n");
  await reset();
  {
    const { validRows, rowErrors } = rowsFrom("content_pages", attackCsv);
    t(
      "(now) every attack row reaches the write (nothing hides behind a refused id)",
      validRows.length === 4 && rowErrors.length === 0,
      JSON.stringify(rowErrors),
    );
    const results = [];
    for (const row of validRows) {
      // Empty cells arrive as null; PostgREST sends them as null too.
      results.push(await upsert("content_pages", pagesTarget, row));
    }
    const v = await victimPage();
    t(
      "(now) the attack file cannot touch the other workspace's page",
      v?.workspace_id === VICTIM && v?.title === "Victim page",
      JSON.stringify(v),
    );
    t(
      "(now) its clashes on cross-workspace keys are refused (23505), never merged",
      results[0] === "23505" && results[1] === "23505",
      JSON.stringify(results),
    );
    const mine = await db.query<{ url_path: string; workspace_id: string }>(
      "SELECT url_path, workspace_id FROM public.content_pages WHERE workspace_id = $1 ORDER BY url_path",
      [ATTACKER],
    );
    t(
      "(now) its other rows become the caller's own new rows, with fresh ids",
      results[2] === "ok" &&
        results[3] === "ok" &&
        mine.rows.map((r) => r.url_path).join(",") === "/mine,/mine-2" &&
        (await count("content_pages")) === 3,
      JSON.stringify(mine.rows),
    );
  }
  await reset();
  {
    const { validRows } = rowsFrom("content_pages", "ID,url_path,title\nx,/elsewhere,T");
    const r = await upsert("content_pages", pagesTarget, validRows[0]!);
    t(
      "(now) an ID header of another case is an unknown column: the write fails (42703)",
      r === "42703" && (await count("content_pages")) === 1,
      r,
    );
  }
  await reset();
  {
    const first = rowsFrom("content_pages", "url_path,title\n/own,Own v1").validRows[0]!;
    const again = rowsFrom("content_pages", "url_path,title\n/own,Own v2").validRows[0]!;
    const r1 = await upsert("content_pages", pagesTarget, first);
    const r2 = await upsert("content_pages", pagesTarget, again);
    const { rows } = await db.query<{ title: string }>(
      "SELECT title FROM public.content_pages WHERE workspace_id = $1 AND url_path = '/own'",
      [ATTACKER],
    );
    t(
      "(now) re-importing the caller's own row by url_path updates it in place",
      r1 === "ok" && r2 === "ok" && rows.length === 1 && rows[0]!.title === "Own v2",
    );
  }
  await reset();
  {
    // Production has no (workspace_id, slug) index on content_plan: the upsert
    // fails closed (42P10) rather than matching anything.
    const row = rowsFrom("content_plan", "slug,title\naustin-tx,Hijacked").validRows[0]!;
    const r = await upsert("content_plan", IMPORT_CONFLICT_TARGET.content_plan, row);
    const v = await victimPlan();
    t(
      "(now) content_plan's target matches no other workspace's row (fails closed today)",
      r === "42P10" && v?.workspace_id === VICTIM,
      `${r} ${JSON.stringify(v)}`,
    );
    // …and if the intended (workspace_id, slug) key is ever added, it still
    // cannot reach across: the global slug key refuses the row instead.
    await db.exec(
      "CREATE UNIQUE INDEX content_plan_ws_slug ON public.content_plan (workspace_id, slug)",
    );
    const r2 = await upsert("content_plan", IMPORT_CONFLICT_TARGET.content_plan, row);
    const v2 = await victimPlan();
    t(
      "(now) with a (workspace_id, slug) key added, another workspace's slug is refused, not merged",
      r2 === "23505" && v2?.workspace_id === VICTIM && v2?.title === "Victim plan",
      `${r2} ${JSON.stringify(v2)}`,
    );
  }
  await db.close();
}

// ---------------------------------------------------------------------------
console.log("\n4. The bulk editor never sets a live page's status");
{
  const cp = read("src/lib/admin-content-pages.functions.ts");
  const fn = cp.slice(cp.indexOf("export const updateContentPageBasics"));
  const tenantBranch = fn.slice(
    fn.indexOf('if (source === "tenant")'),
    fn.indexOf("const clean ="),
  );
  t(
    "a tenant page status is refused before any write",
    /if \(patch\.status !== undefined\) \{\s*throw new Error\(/.test(tenantBranch) &&
      tenantBranch.indexOf("throw new Error(") < tenantBranch.indexOf('.from("tenant_pages")'),
  );
  t("the tenant patch never carries status", !/tenantPatch\.status/.test(tenantBranch));
  const editor = read("src/routes/_authenticated/app.content.bulk-editor.tsx");
  t(
    "the bulk editor itself only sends in_sitemap",
    /data: \{ workspaceId, id: row\.id, source: row\.source, in_sitemap: !row\.in_sitemap \}/.test(
      editor,
    ) &&
      !/status:/.test(editor.slice(editor.indexOf("saveRow({"), editor.indexOf("saveRow({") + 200)),
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("Failed:\n  " + failed.join("\n  "));
  process.exit(1);
}

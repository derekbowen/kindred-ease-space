/**
 * DATA IMPORT STAYS IN ITS OWN WORKSPACE. Run: bun tests/data-import-scope.test.ts
 *
 * importTable writes as the service role (past RLS) and forces workspace_id,
 * but it took the upsert's conflict target from the caller. Production's
 * legacy tables carry unique keys that span ALL workspaces —
 * content_pages (url_path), (source_url), (slug) and content_plan (slug) — so
 * a direct call with conflictColumn "url_path" turned the upsert into an
 * overwrite of another workspace's page, moving it into the caller's
 * workspace. The same call also accepted table "tenant_pages", whose status
 * belongs to publish_tenant_pages() and the page limit.
 *
 * Now: the target is the server's (IMPORT_CONFLICT_TARGET), the input schema
 * is strict (a conflictColumn key is refused), and import is limited to the
 * two legacy tables. Section 2 runs the real SQL shape of the upsert on
 * PGlite with production's unique indexes: the old caller-chosen target
 * overwrites the other workspace's row; every target the server now uses
 * cannot.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import {
  IMPORT_CONFLICT_TARGET,
  IMPORT_TABLES,
  ImportTableInputSchema,
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
t("content_pages upserts on the row id", IMPORT_CONFLICT_TARGET.content_pages === "id");
t(
  "content_plan upserts on (workspace_id, slug)",
  IMPORT_CONFLICT_TARGET.content_plan === "workspace_id,slug",
);
t(
  "every target is the row id or includes workspace_id",
  Object.values(IMPORT_CONFLICT_TARGET).every(
    (c) => c === "id" || c.split(",").includes("workspace_id"),
  ),
);

const io = read("src/lib/admin-data-io.functions.ts");
const handler = io.slice(io.indexOf("export const importTable"));
t(
  "the handler takes the target from IMPORT_CONFLICT_TARGET",
  /const conflictColumn = IMPORT_CONFLICT_TARGET\[data\.table\];/.test(handler),
);
t(
  "nothing reads a caller's conflictColumn any more",
  !/data\.conflictColumn/.test(io) && !/conflictColumn: z\./.test(io),
);
t("the schema is strict", /ImportTableInputSchema = z[\s\S]*?\.strict\(\);/.test(io));
t(
  "the other-workspace id check still guards the id upsert",
  /if \(data\.mode === "upsert" && conflictColumn === "id"\)/.test(handler) &&
    /Row belongs to another workspace/.test(handler),
);
t(
  "workspace_id is still forced from the session's workspace",
  /obj\.workspace_id = workspaceId;/.test(handler) &&
    /if \(col === "workspace_id"\) return;/.test(handler),
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
console.log("\n2. LIVE: the upsert's SQL shape on production's unique keys (PGlite)");
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
  const VICTIM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const ATTACKER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const VICTIM_PAGE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
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
  // PostgREST's upsert: INSERT … ON CONFLICT (<target>) DO UPDATE SET every
  // supplied column = EXCLUDED.column. workspace_id is the caller's (forced).
  const upsertPage = async (target: string, row: Record<string, string>) => {
    const cols = Object.keys(row);
    const sql = `INSERT INTO public.content_pages (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})
      ON CONFLICT (${target}) DO UPDATE SET ${cols.map((c) => `${c} = EXCLUDED.${c}`).join(", ")}`;
    try {
      await db.query(sql, Object.values(row));
      return "ok";
    } catch (e) {
      return (e as { code?: string }).code ?? "error";
    }
  };
  const upsertPlan = async (target: string, row: Record<string, string>) => {
    const cols = Object.keys(row);
    const sql = `INSERT INTO public.content_plan (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})
      ON CONFLICT (${target}) DO UPDATE SET ${cols.map((c) => `${c} = EXCLUDED.${c}`).join(", ")}`;
    try {
      await db.query(sql, Object.values(row));
      return "ok";
    } catch (e) {
      return (e as { code?: string }).code ?? "error";
    }
  };

  // The hole this closes: the old caller-chosen targets.
  for (const target of ["url_path", "source_url"]) {
    await reset();
    const r = await upsertPage(target, {
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
    const r = await upsertPlan("slug", {
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

  // What the server uses now.
  await reset();
  {
    const r = await upsertPage(IMPORT_CONFLICT_TARGET.content_pages, {
      id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      workspace_id: ATTACKER,
      url_path: "/pool-rentals",
      title: "Hijacked",
    });
    const v = await victimPage();
    t(
      "(now) a new row reusing another workspace's url_path is refused, not merged",
      r === "23505" && v?.workspace_id === VICTIM && v?.title === "Victim page",
      `${r} ${JSON.stringify(v)}`,
    );
  }
  await reset();
  {
    const r = await upsertPage(IMPORT_CONFLICT_TARGET.content_pages, {
      id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      workspace_id: ATTACKER,
      source_url: "https://v.example/pools",
      title: "Hijacked",
    });
    const v = await victimPage();
    t(
      "(now) a new row reusing another workspace's source_url is refused, not merged",
      r === "23505" && v?.workspace_id === VICTIM,
      `${r} ${JSON.stringify(v)}`,
    );
  }
  await reset();
  {
    // Another workspace's row id is the one case the id target could reach: the
    // handler's pre-write check drops it ("Row belongs to another workspace").
    const { rows } = await db.query<{ id: string; workspace_id: string }>(
      "SELECT id, workspace_id FROM public.content_pages WHERE id = ANY($1)",
      [[VICTIM_PAGE]],
    );
    const foreign = rows.filter((row) => row.workspace_id !== ATTACKER).map((row) => row.id);
    t(
      "(now) the handler's id check finds the other workspace's row before any write",
      foreign.length === 1 && foreign[0] === VICTIM_PAGE,
    );
  }
  await reset();
  {
    const own = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    const first = await upsertPage("id", {
      id: own,
      workspace_id: ATTACKER,
      url_path: "/own",
      title: "Own v1",
    });
    const again = await upsertPage("id", {
      id: own,
      workspace_id: ATTACKER,
      url_path: "/own",
      title: "Own v2",
    });
    const { rows } = await db.query<{ title: string }>(
      "SELECT title FROM public.content_pages WHERE id = $1",
      [own],
    );
    t(
      "(now) re-importing the workspace's own row by id still updates it",
      first === "ok" && again === "ok" && rows[0]?.title === "Own v2",
    );
  }
  await reset();
  {
    // Production has no (workspace_id, slug) index on content_plan: the upsert
    // fails closed (42P10) rather than matching anything.
    const r = await upsertPlan(IMPORT_CONFLICT_TARGET.content_plan, {
      workspace_id: ATTACKER,
      slug: "austin-tx",
      title: "Hijacked",
    });
    const v = await victimPlan();
    t(
      "(now) content_plan's target matches no other workspace's row (fails closed today)",
      r !== "ok" && v?.workspace_id === VICTIM,
      `${r} ${JSON.stringify(v)}`,
    );
    // …and if the intended (workspace_id, slug) key is ever added, it still
    // cannot reach across: the global slug key refuses the row instead.
    await db.exec(
      "CREATE UNIQUE INDEX content_plan_ws_slug ON public.content_plan (workspace_id, slug)",
    );
    const r2 = await upsertPlan(IMPORT_CONFLICT_TARGET.content_plan, {
      workspace_id: ATTACKER,
      slug: "austin-tx",
      title: "Hijacked",
    });
    const v2 = await victimPlan();
    t(
      "(now) with a (workspace_id, slug) key added, another workspace's slug is refused, not merged",
      r2 === "23505" && v2?.workspace_id === VICTIM && v2?.title === "Victim plan",
      `${r2} ${JSON.stringify(v2)}`,
    );
  }
  await db.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("Failed:\n  " + failed.join("\n  "));
  process.exit(1);
}

/**
 * NO RAW ERROR TEXT IN THE CUSTOMER UI. Run: bun tests/ui-error-display.test.ts
 *
 * Every error a customer reads goes through userMessage(e, fallback)
 * (src/lib/user-message.ts). This guard parses every file under src/routes
 * and src/components and fails when raw error text — an Error's `.message`,
 * a server-fn result's `.error` (or a stored `*_error` column), `String(e)`,
 * `${e}`, or a variable holding one of those — flows into:
 *   - React state (any `setX(…)`), a toast (`toast…(…)`, including its
 *     `description`) or `alert(…)`;
 *   - JSX (`{error.message}`, `{item.error}`, `title={r.error}`).
 * Text inside a `userMessage(…)` call is sanitised and fine; so is raw text
 * that only decides something (`String(e).includes("forbidden")`,
 * `r.error ? … : …`) or is logged (console.* is not a sink).
 *
 * Exceptions are listed in ALLOWLIST with their reason. src/routes/api/** is
 * not scanned: those are server HTTP endpoints (cron hooks, ops probes,
 * machine JSON), not screens.
 */
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

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

// ---------------------------------------------------------------------------
// Justified exceptions. `match` narrows an entry to the flagged expressions
// whose source text contains it; no `match` covers the whole file. An entry
// whose file no longer exists is ignored (files owned by another workstream
// may be deleted).
type Allow = { file: string; match?: string; reason: string };
const ADMIN_ONLY =
  "platform-admin-only: every server call on this page is behind has_role('admin') " +
  "(help-admin / help-tickets / admin-entitlement-grants / admin-canonical-audit functions), " +
  "so only the operator can reach this message, and the operator needs the raw text to fix it";
const ALLOWLIST: Allow[] = [
  // --- Platform-admin-only pages (listed, not converted: see ADMIN_ONLY).
  { file: "src/routes/_authenticated/app.admin.help.articles.tsx", reason: ADMIN_ONLY },
  {
    file: "src/routes/_authenticated/app.admin.help.articles.$id.tsx",
    match: 'toast.error("Save failed"',
    // The load failure on this page IS reachable by customers (anyone can
    // open the URL; they get "forbidden") and goes through userMessage.
    reason: `${ADMIN_ONLY}; Save only exists once an admin-only load succeeded`,
  },
  { file: "src/routes/_authenticated/app.admin.help.categories.tsx", reason: ADMIN_ONLY },
  { file: "src/routes/_authenticated/app.ops.plan-requests.tsx", reason: ADMIN_ONLY },
  {
    file: "src/routes/_authenticated/app.seo.canonical-audit.tsx",
    match: "p.error",
    reason: `${ADMIN_ONLY}; p.error is the crawler's fetch result for a founders.click URL, not an app error`,
  },
  // --- Not error text.
  {
    file: "src/routes/_authenticated/app.admin.help.tickets.tsx",
    match: "ticket.message",
    reason:
      "ticket.message is the support ticket's own body (what the customer wrote), not an error; " +
      "and the page is platform-admin-only",
  },
  {
    file: "src/routes/_authenticated/app.content.generate.tsx",
    match: ": publishResult.message",
    reason:
      'non-error publish outcomes are server-composed status sentences ("Published.", the page-limit ' +
      'and contract notes); the "error" outcome on the same line goes through userMessage',
  },
  {
    file: "src/components/ui/form.tsx",
    reason:
      "shadcn form primitive: FormMessage renders client-side validation text from the form's own " +
      "resolver schema, never server or database text (and no form in src uses it today)",
  },
  // --- Owned by the parallel AI-provider workstream, which deletes it.
  {
    file: "src/components/help/HelpAssistantWidget.tsx",
    reason:
      "the Help chat widget is being deleted by the OpenAI migration branch (which owns " +
      "src/components/help/**); do not edit it here",
  },
];

// ---------------------------------------------------------------------------
// The analyzer.

type Violation = { file: string; line: number; text: string; full: string };

const isRawProp = (name: string) =>
  name === "message" ||
  name === "error" ||
  name === "errorMessage" ||
  /_error$/.test(name) ||
  /^error_/.test(name);

/** String methods whose result is still the (raw) text. */
const TEXT_METHODS = new Set([
  "slice",
  "substring",
  "substr",
  "trim",
  "trimStart",
  "trimEnd",
  "toString",
  "replace",
  "replaceAll",
  "concat",
  "padStart",
  "padEnd",
  "toUpperCase",
  "toLowerCase",
  "normalize",
]);

function calleeName(node: ts.CallExpression): string | null {
  const c = node.expression;
  if (ts.isIdentifier(c)) return c.text;
  if (ts.isPropertyAccessExpression(c)) return c.name.text;
  return null;
}

function isSinkCall(node: ts.CallExpression): boolean {
  const c = node.expression;
  // React state setters (and any other set*): setErr, setMsg, setErrors, setStatus …
  if (ts.isIdentifier(c) && /^set[A-Z]/.test(c.text)) return true;
  if (ts.isPropertyAccessExpression(c) && /^set[A-Z]/.test(c.name.text)) return true;
  // sonner: toast(…), toast.error(…), toast.success(…) …
  if (ts.isIdentifier(c) && c.text === "toast") return true;
  if (
    ts.isPropertyAccessExpression(c) &&
    ts.isIdentifier(c.expression) &&
    c.expression.text === "toast"
  ) {
    return true;
  }
  // alert(…) / window.alert(…)
  if (ts.isIdentifier(c) && c.text === "alert") return true;
  if (ts.isPropertyAccessExpression(c) && c.name.text === "alert") return true;
  return false;
}

/**
 * Symbols whose value is raw error text. Resolved through the type checker,
 * so a caught `e` and an unrelated `e` (a loop variable, an entitlement row)
 * in another scope are told apart.
 */
type Ctx = {
  checker: ts.TypeChecker;
  tainted: Set<ts.Symbol>;
  /** JSX never renders a bare caught error object; only sinks are checked for it. */
  caughtCounts: boolean;
};

/** Is this symbol bound to a caught error: catch (e), .catch((e) => …), onError: (e) => …? */
function isCaughtSymbol(sym: ts.Symbol | undefined): boolean {
  const decl = sym?.declarations?.[0];
  if (!decl) return false;
  if (ts.isVariableDeclaration(decl) && ts.isCatchClause(decl.parent)) return true;
  if (ts.isParameter(decl)) {
    const fn = decl.parent;
    if (!(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) || fn.parameters[0] !== decl)
      return false;
    const holder = fn.parent;
    if (ts.isCallExpression(holder) && holder.arguments[0] === fn && calleeName(holder) === "catch")
      return true;
    if (
      ts.isPropertyAssignment(holder) &&
      ts.isIdentifier(holder.name) &&
      holder.name.text === "onError"
    ) {
      return true;
    }
  }
  return false;
}

/** Can the VALUE of this expression be raw error text? */
function valueRaw(node: ts.Node, ctx: Ctx): boolean {
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isSatisfiesExpression(node)
  ) {
    return valueRaw(node.expression, ctx);
  }
  if (ts.isPropertyAccessExpression(node)) return isRawProp(node.name.text);
  if (ts.isElementAccessExpression(node)) {
    const a = node.argumentExpression;
    return ts.isStringLiteral(a) && isRawProp(a.text);
  }
  if (ts.isIdentifier(node)) {
    const sym = ctx.checker.getSymbolAtLocation(node);
    if (!sym) return false;
    return ctx.tainted.has(sym) || (ctx.caughtCounts && isCaughtSymbol(sym));
  }
  if (ts.isCallExpression(node)) {
    const name = calleeName(node);
    if (name === "userMessage") return false; // sanitised
    // String(e) / JSON.stringify(e) of a caught error is raw wherever it appears.
    const inner: Ctx = { ...ctx, caughtCounts: true };
    if (ts.isIdentifier(node.expression) && name === "String") {
      return node.arguments.some((a) => valueRaw(a, inner));
    }
    if (ts.isPropertyAccessExpression(node.expression)) {
      const obj = node.expression.expression;
      if (ts.isIdentifier(obj) && obj.text === "JSON" && name === "stringify") {
        return node.arguments.some((a) => valueRaw(a, inner));
      }
      if (name && TEXT_METHODS.has(name)) return valueRaw(obj, ctx);
    }
    return false; // includes(), test(), other calls: not the raw text itself
  }
  if (ts.isConditionalExpression(node)) {
    return valueRaw(node.whenTrue, ctx) || valueRaw(node.whenFalse, ctx);
  }
  if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.kind;
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) return valueRaw(node.right, ctx);
    if (
      op === ts.SyntaxKind.BarBarToken ||
      op === ts.SyntaxKind.QuestionQuestionToken ||
      op === ts.SyntaxKind.PlusToken
    ) {
      return valueRaw(node.left, ctx) || valueRaw(node.right, ctx);
    }
    return false; // comparisons, instanceof, assignments …
  }
  if (ts.isTemplateExpression(node)) {
    const inner: Ctx = { ...ctx, caughtCounts: true };
    return node.templateSpans.some((s) => valueRaw(s.expression, inner));
  }
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.some((e) => !ts.isSpreadElement(e) && valueRaw(e, ctx));
  }
  if (ts.isObjectLiteralExpression(node)) {
    return node.properties.some(
      (p) =>
        (ts.isPropertyAssignment(p) && valueRaw(p.initializer, ctx)) ||
        (ts.isShorthandPropertyAssignment(p) && valueRaw(p.name, ctx)),
    );
  }
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    // State updaters: setErrors((e) => ({ ...e, [id]: r.error }))
    if (!ts.isBlock(node.body)) return valueRaw(node.body, ctx);
    let found = false;
    const visitReturns = (n: ts.Node) => {
      if (ts.isFunctionLike(n) && n !== node) return;
      if (ts.isReturnStatement(n) && n.expression && valueRaw(n.expression, ctx)) found = true;
      ts.forEachChild(n, visitReturns);
    };
    visitReturns(node.body);
    return found;
  }
  return false;
}

/**
 * Analyze several files in one program (no module resolution, no lib: only
 * the binder's scopes are needed). Returns the raw displays found.
 */
export function analyzeSources(sources: Map<string, string>): Violation[] {
  const options: ts.CompilerOptions = {
    noResolve: true,
    noLib: true,
    jsx: ts.JsxEmit.Preserve,
    target: ts.ScriptTarget.Latest,
    types: [],
  };
  const files = new Map<string, ts.SourceFile>();
  for (const [name, text] of sources) {
    files.set(
      name,
      ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX),
    );
  }
  const host = ts.createCompilerHost(options, true);
  host.getSourceFile = (name) => files.get(name);
  host.fileExists = (name) => files.has(name);
  host.readFile = (name) => sources.get(name);
  const checker = ts.createProgram([...sources.keys()], options, host).getTypeChecker();

  const out: Violation[] = [];
  for (const [name, sf] of files) {
    const ctx: Ctx = { checker, tainted: new Set(), caughtCounts: true };
    // Variables holding raw text: const msg = e instanceof Error ? e.message : "…"
    // (two passes so a copy of a copy is caught too).
    for (let round = 0; round < 2; round++) {
      const collectTaint = (n: ts.Node) => {
        if (
          ts.isVariableDeclaration(n) &&
          ts.isIdentifier(n.name) &&
          n.initializer &&
          valueRaw(n.initializer, ctx)
        ) {
          const sym = checker.getSymbolAtLocation(n.name);
          if (sym) ctx.tainted.add(sym);
        }
        if (
          ts.isBinaryExpression(n) &&
          n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          ts.isIdentifier(n.left) &&
          valueRaw(n.right, ctx)
        ) {
          const sym = checker.getSymbolAtLocation(n.left);
          if (sym) ctx.tainted.add(sym);
        }
        ts.forEachChild(n, collectTaint);
      };
      collectTaint(sf);
    }
    const jsxCtx: Ctx = { ...ctx, caughtCounts: false };
    const report = (n: ts.Node) => {
      const { line } = sf.getLineAndCharacterOfPosition(n.getStart(sf));
      const full = n.getText(sf).replace(/\s+/g, " ");
      out.push({ file: name, line: line + 1, text: full.slice(0, 160), full });
    };
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n) && isSinkCall(n) && n.arguments.some((a) => valueRaw(a, ctx)))
        report(n);
      if (ts.isJsxExpression(n) && n.expression && valueRaw(n.expression, jsxCtx)) report(n);
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return out;
}

export function analyze(file: string, source: string): Violation[] {
  return analyzeSources(new Map([[file, source]]));
}

// ---------------------------------------------------------------------------
console.log("\nthe guard catches what it claims to (self-test)");
{
  const SAMPLE = `
    function A() {
      const [err, setErr] = useState(null);
      const raw = other.message;
      const safe = userMessage(other, "x");
      try {} catch (e) { setErr(e.message); }                                   // 1
      try {} catch (e) { setErr(userMessage(e, "x")); }
      try {} catch (e) { toast.error("Failed", { description: String(e) }); }  // 2
      try {} catch (e) { setErr(raw); }                                         // 3
      try {} catch (e) { setErr(safe); }
      if (!r.ok) setErr(r.error);                                               // 4
      setMsg(r.ok ? "Saved." : \`Error: \${r.error}\`);                           // 5
      setErrors((x) => ({ ...x, [id]: r.error ?? "failed" }));                  // 6
      if (String(e?.message ?? e).includes("forbidden")) setForbidden(true);
      setMsg(r.ok ? "Saved." : userMessage(r.error, "x"));
      p.then(() => {}).catch((err) => toast.error(err));                        // 7
      console.error("boom", e.message);
      toast.error(e instanceof Error ? e.message : "Failed");                   // 8
      return (
        <div title={r.error ?? ""}>                                             {/* 9 */}
          {error.message}                                                       {/* 10 */}
          {item.last_sync_error}                                                {/* 11 */}
          {err}
          {userMessage(item.error, "x")}
          {r.error ? <b>{userMessage(r.error, "y")}</b> : null}
        </div>
      );
    }`;
  const v = analyze("sample.tsx", SAMPLE);
  t(
    "flags exactly the 11 raw displays in the sample",
    v.length === 11,
    JSON.stringify(
      v.map((x) => x.text),
      null,
      1,
    ),
  );
  const flagged = (needle: string) => v.some((x) => x.text.includes(needle));
  t("setErr(e.message) is flagged", flagged("setErr(e.message)"));
  t("toast description String(e) is flagged", flagged("String(e)"));
  t("a variable copied from .message is flagged", flagged("setErr(raw)"));
  t("a server-fn r.error into state is flagged", flagged("setErr(r.error)"));
  t("a template with ${r.error} is flagged", flagged("Error: ${r.error}"));
  t("a state updater returning r.error is flagged", flagged("setErrors"));
  t("toast.error(caughtError) is flagged", flagged("toast.error(err)"));
  t("JSX {error.message} is flagged", flagged("{error.message}"));
  t("JSX title={r.error} is flagged", flagged('{r.error ?? ""}'));
  t("a stored *_error column in JSX is flagged", flagged("last_sync_error"));
  t(
    "userMessage(…) is never flagged",
    !v.some((x) => x.text.startsWith("setErr(userMessage") || x.text.includes("{userMessage(")),
  );
  t("logic on raw text is not flagged", !flagged("setForbidden"));
}

// ---------------------------------------------------------------------------
console.log("\nsrc/routes and src/components: every raw error display goes through userMessage");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}
const files = [...walk(join(ROOT, "src/routes")), ...walk(join(ROOT, "src/components"))]
  .map((p) => relative(ROOT, p))
  // Server HTTP endpoints, not screens (see the header).
  .filter((p) => !p.startsWith("src/routes/api/"));

t("the scan covers the UI (routes and components)", files.length > 120, String(files.length));

const allowedBy = (v: Violation): Allow | undefined =>
  ALLOWLIST.find((a) => a.file === v.file && (!a.match || v.full.includes(a.match)));

const violations: Violation[] = [];
const allowedHits = new Map<Allow, number>();
const found = analyzeSources(new Map(files.map((f) => [f, readFileSync(join(ROOT, f), "utf8")])));
for (const v of found) {
  const allow = allowedBy(v);
  if (allow) allowedHits.set(allow, (allowedHits.get(allow) ?? 0) + 1);
  else violations.push(v);
}
for (const v of violations) console.log(`    raw error display: ${v.file}:${v.line}  ${v.text}`);
t(
  "no raw .message / .error / String(e) reaches state, a toast or JSX outside the allowlist",
  violations.length === 0,
  `${violations.length} site(s) — wrap each in userMessage(e, "<what failed, in plain words>")`,
);

console.log("\nthe allowlist is explicit and explained");
for (const a of ALLOWLIST) {
  const present = existsSync(join(ROOT, a.file));
  t(`${a.file}${a.match ? ` [${a.match}]` : ""} has a reason`, a.reason.length > 20);
  if (present) {
    // Informational: an entry that matches nothing can be deleted.
    if (!allowedHits.get(a)) console.log(`    note: allowlist entry matched nothing: ${a.file}`);
  } else {
    console.log(`    note: allowlisted file is gone (fine): ${a.file}`);
  }
}
t(
  "no customer-facing route is allowlisted wholesale",
  ALLOWLIST.filter((a) => !a.match).every(
    (a) =>
      /app\.admin\.|app\.ops\.plan-requests/.test(a.file) ||
      a.file === "src/components/ui/form.tsx" ||
      a.file.startsWith("src/components/help/"),
  ),
);

console.log("\nthe known sites from the audit use userMessage");
const read = (rel: string) =>
  existsSync(join(ROOT, rel)) ? readFileSync(join(ROOT, rel), "utf8") : "";
for (const rel of [
  "src/routes/login.tsx",
  "src/routes/signup.tsx",
  "src/routes/reset-password.tsx",
  "src/routes/help.contact.tsx",
  "src/routes/apply.$slug.tsx",
  "src/routes/s.$ws.$slug.tsx",
  "src/routes/_authenticated/app.tsx",
  "src/routes/_authenticated/app.opportunities.tsx",
  "src/routes/_authenticated/app.content.bulk-editor.tsx",
  "src/routes/_authenticated/app.billing.tsx",
  "src/routes/_authenticated/app.affiliates.tsx",
  "src/routes/_authenticated/app.affiliates.directory.tsx",
  "src/routes/_authenticated/app.affiliates.payouts.tsx",
  "src/routes/_authenticated/app.affiliates.settings.tsx",
  "src/routes/_authenticated/app.affiliates.customise.tsx",
  "src/routes/_authenticated/app.affiliates.programs.$id.edit.tsx",
  "src/routes/_authenticated/app.settings.tsx",
  "src/routes/_authenticated/app.settings.domains.tsx",
  "src/routes/_authenticated/app.settings.integrations.sharetribe.tsx",
  "src/routes/_authenticated/app.seo.click-report.tsx",
  "src/routes/_authenticated/app.seo-coach.tsx",
  "src/routes/_authenticated/app.addons.tsx",
  "src/routes/_authenticated/app.admin.email-templates.tsx",
  "src/routes/_authenticated/app.pages.$id.edit.tsx",
  "src/routes/_authenticated/app.pages.bulk.tsx",
  "src/components/WorkspaceBrandingCard.tsx",
  "src/components/coach/DailyBriefing.tsx",
]) {
  const src = read(rel);
  t(
    `${rel} imports userMessage`,
    src.includes('import { userMessage } from "@/lib/user-message";') && /userMessage\(/.test(src),
  );
}
const sharetribe = read("src/routes/_authenticated/app.settings.integrations.sharetribe.tsx");
t(
  "Sharetribe connect errors (the live zod example's page) are routed through userMessage",
  /setErr\(userMessage\(r\.error, CONNECT_FAILED\)\)/.test(sharetribe) &&
    /setErr\(userMessage\(e, CONNECT_FAILED\)\)/.test(sharetribe),
);
t(
  "the stored last sync error is sanitised too",
  /userMessage\(\s*integration\.last_sync_error,/.test(sharetribe),
);
const publicPage = read("src/routes/a.$slug.tsx");
t(
  "the white-labelled public page shows a fixed sentence, not the loader's error",
  !/\{error\.message\}/.test(publicPage) && /This page couldn't load/.test(publicPage),
);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("Failed:\n  " + failed.join("\n  "));
  process.exit(1);
}

import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2 } from "lucide-react";
import { getMe } from "@/lib/auth.functions";
import { auditPage, listRecentAudits, type PageAuditRow } from "@/lib/admin-page-auditor.functions";

export const Route = createFileRoute("/_authenticated/app/seo/page-auditor")({
  head: () => ({ meta: [{ title: "Page Auditor — founders.click" }] }),
  component: PageAuditorPage,
});

function PageAuditorPage() {
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [path, setPath] = useState("");
  const [audit, setAudit] = useState<PageAuditRow | null>(null);
  const [recent, setRecent] = useState<PageAuditRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<
    Array<{ url_path: string; title: string | null; status: string }>
  >([]);
  const run = useServerFn(auditPage);
  const list = useServerFn(listRecentAudits);

  useEffect(() => {
    getMe().then((me) => setWorkspaceId(me.memberships[0]?.workspace_id ?? null));
  }, []);
  useEffect(() => {
    if (workspaceId) reload(workspaceId); /* eslint-disable-next-line */
  }, [workspaceId]);

  async function reload(ws: string) {
    const r = await list({ data: { workspaceId: ws, limit: 20 } });
    setRecent(r.rows);
  }

  async function runAudit() {
    if (!workspaceId || !path.trim()) return;
    setBusy(true);
    setError(null);
    setAudit(null);
    setSuggestions([]);
    try {
      const r = await run({ data: { workspaceId, url_path: path.trim() } });
      if (r.ok) {
        setAudit(r.audit);
        await reload(workspaceId);
      } else {
        setError(r.error);
        if ("suggestions" in r && r.suggestions) setSuggestions(r.suggestions);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Page Auditor</h1>
        <p className="text-sm text-muted-foreground">
          AI scores any of your published pages 0–100 with strengths, weaknesses, and
          recommendations.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Audit a page</CardTitle>
          <CardDescription>
            Paste a path like <code>/p/los-angeles-ca</code>.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1 flex-1 min-w-[280px]">
              <Label>URL path</Label>
              <Input
                value={path}
                onChange={(e) => setPath(e.target.value)}
                placeholder="/p/los-angeles-ca"
                onKeyDown={(e) => {
                  if (e.key === "Enter") runAudit();
                }}
              />
            </div>
            <Button
              onClick={runAudit}
              disabled={busy || !workspaceId || !path.trim()}
              className="gap-2"
            >
              {busy && <Loader2 className="h-4 w-4 animate-spin" />} Audit
            </Button>
          </div>
          {error && (
            <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
              {error}
              {suggestions.length > 0 && (
                <ul className="mt-2 space-y-1 text-xs">
                  {suggestions.map((s) => (
                    <li key={s.url_path}>
                      <button className="underline" onClick={() => setPath(s.url_path)}>
                        {s.url_path}
                      </button>{" "}
                      — {s.title || "(untitled)"} [{s.status}]
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {audit && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-4">
              <div>
                <CardTitle className="font-mono text-base">{audit.url_path}</CardTitle>
                <CardDescription>{audit.summary}</CardDescription>
              </div>
              <div className="text-4xl font-bold">
                {audit.score ?? "—"}
                <span className="text-base text-muted-foreground">/100</span>
              </div>
            </div>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-3">
            <Section title="Strengths" items={audit.strengths} />
            <Section title="Weaknesses" items={audit.weaknesses} />
            <Section title="Recommendations" items={audit.recommendations} />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Recent audits</CardTitle>
          <CardDescription>{recent.length} rows</CardDescription>
        </CardHeader>
        <CardContent>
          {recent.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">No audits yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="py-2 pr-4">When</th>
                  <th className="py-2 pr-4">URL</th>
                  <th className="py-2 pr-4">Score</th>
                  <th className="py-2">Summary</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((r) => (
                  <tr key={r.id} className="border-b last:border-0">
                    <td className="py-2 pr-4 text-xs text-muted-foreground">
                      {new Date(r.audited_at).toLocaleString()}
                    </td>
                    <td className="py-2 pr-4 font-mono text-xs">{r.url_path}</td>
                    <td className="py-2 pr-4 font-bold">{r.score ?? "—"}</td>
                    <td className="py-2 text-xs">{r.summary}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Section({ title, items }: { title: string; items: string[] }) {
  return (
    <div>
      <h3 className="mb-2 text-sm font-semibold">{title}</h3>
      {items.length === 0 ? (
        <p className="text-xs text-muted-foreground">None.</p>
      ) : (
        <ul className="space-y-1 text-sm">
          {items.map((it, i) => (
            <li key={i} className="leading-snug">
              • {it}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

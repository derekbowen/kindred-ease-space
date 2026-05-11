import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2 } from "lucide-react";
import { getMe } from "@/lib/auth.functions";
import {
  list404s, resolve404, redirect404,
  type Content404Row,
} from "@/lib/admin-404-log.functions";

export const Route = createFileRoute("/_authenticated/app/seo/missing-pages")({
  head: () => ({ meta: [{ title: "Missing Pages — founders.click" }] }),
  component: MissingPagesPage,
});

function MissingPagesPage() {
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [rows, setRows] = useState<Content404Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [unresolvedOnly, setUnresolvedOnly] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [redirectTargets, setRedirectTargets] = useState<Record<string, string>>({});

  const fetchRows = useServerFn(list404s);
  const markResolved = useServerFn(resolve404);
  const setRedirect = useServerFn(redirect404);

  useEffect(() => {
    getMe().then((me) => setWorkspaceId(me.memberships[0]?.workspace_id ?? null));
  }, []);

  async function load() {
    if (!workspaceId) return;
    setLoading(true);
    try {
      const r = await fetchRows({ data: { workspaceId, unresolvedOnly, limit: 200 } });
      setRows(r.rows);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { if (workspaceId) load(); /* eslint-disable-next-line */ }, [workspaceId, unresolvedOnly]);

  async function handleResolve(id: string) {
    if (!workspaceId) return;
    setBusyId(id);
    try {
      await markResolved({ data: { workspaceId, id } });
      setRows((rs) => rs.filter((r) => r.id !== id));
    } finally { setBusyId(null); }
  }

  async function handleRedirect(id: string) {
    if (!workspaceId) return;
    const target = redirectTargets[id]?.trim();
    if (!target) return;
    setBusyId(id);
    try {
      const res = await setRedirect({ data: { workspaceId, id, target } });
      if (res.ok) setRows((rs) => rs.filter((r) => r.id !== id));
    } finally { setBusyId(null); }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Missing Pages (404 log)</h1>
        <p className="text-sm text-muted-foreground">
          Real 404s captured from your published site. Resolve by creating a redirect.
        </p>
      </div>

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle>{rows.length} entries</CardTitle>
            <CardDescription>{unresolvedOnly ? "Unresolved only" : "All"}</CardDescription>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setUnresolvedOnly((v) => !v)}>
              {unresolvedOnly ? "Show all" : "Show unresolved"}
            </Button>
            <Button onClick={load} disabled={loading} size="sm" className="gap-2">
              {loading && <Loader2 className="h-4 w-4 animate-spin" />} Refresh
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {loading ? "Loading…" : "No 404s yet."}
            </p>
          ) : (
            <ul className="divide-y">
              {rows.map((r) => (
                <li key={r.id} className="space-y-2 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="font-mono text-sm">{r.url_path}</div>
                      <div className="text-xs text-muted-foreground">
                        {r.hit_count} hits · last {new Date(r.last_seen_at).toLocaleString()}
                        {r.referrer && <> · ref: <span className="font-mono">{r.referrer.slice(0, 60)}</span></>}
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busyId === r.id}
                      onClick={() => handleResolve(r.id)}
                    >
                      Mark resolved
                    </Button>
                  </div>
                  <div className="flex gap-2">
                    <Input
                      placeholder="/p/redirect-target or https://…"
                      value={redirectTargets[r.id] ?? ""}
                      onChange={(e) => setRedirectTargets((m) => ({ ...m, [r.id]: e.target.value }))}
                      className="text-xs"
                    />
                    <Button
                      size="sm"
                      disabled={busyId === r.id || !redirectTargets[r.id]?.trim()}
                      onClick={() => handleRedirect(r.id)}
                    >
                      {busyId === r.id ? <Loader2 className="h-4 w-4 animate-spin" /> : "Redirect"}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

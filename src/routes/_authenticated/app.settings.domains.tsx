import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Loader2, CheckCircle2, Trash2, Globe } from "lucide-react";
import { getMe } from "@/lib/auth.functions";
import {
  listWorkspaceDomains,
  addWorkspaceDomain,
  verifyWorkspaceDomain,
  deleteWorkspaceDomain,
  type WorkspaceDomainRow,
} from "@/lib/admin-domains.functions";

export const Route = createFileRoute("/_authenticated/app/settings/domains")({
  head: () => ({ meta: [{ title: "Custom Domains — founders.click" }] }),
  component: DomainsPage,
});

function DomainsPage() {
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [rows, setRows] = useState<WorkspaceDomainRow[]>([]);
  const [hostname, setHostname] = useState("");
  const [busy, setBusy] = useState(false);
  const [verifyingId, setVerifyingId] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const list = useServerFn(listWorkspaceDomains);
  const add = useServerFn(addWorkspaceDomain);
  const verify = useServerFn(verifyWorkspaceDomain);
  const del = useServerFn(deleteWorkspaceDomain);

  useEffect(() => {
    getMe().then((me) => setWorkspaceId(me.memberships[0]?.workspace_id ?? null));
  }, []);
  useEffect(() => {
    if (workspaceId) reload(workspaceId);
    /* eslint-disable-next-line */
  }, [workspaceId]);

  async function reload(ws: string) {
    try {
      const r = await list({ data: { workspaceId: ws } });
      setRows(r.rows);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Failed to load");
    }
  }

  async function onAdd() {
    if (!workspaceId || !hostname.trim()) return;
    setBusy(true); setMsg(null);
    try {
      const r = await add({ data: { workspaceId, hostname: hostname.trim() } });
      if (r.ok) {
        setHostname("");
        await reload(workspaceId);
      } else {
        setMsg(r.error);
      }
    } finally { setBusy(false); }
  }

  async function onVerify(id: string) {
    if (!workspaceId) return;
    setVerifyingId(id);
    setErrors((e) => ({ ...e, [id]: "" }));
    try {
      const r = await verify({ data: { workspaceId, id } });
      if (r.ok) {
        await reload(workspaceId);
      } else {
        setErrors((e) => ({ ...e, [id]: r.error }));
      }
    } finally { setVerifyingId(null); }
  }

  async function onDelete(id: string) {
    if (!workspaceId) return;
    if (!confirm("Remove this domain? Pages will stop serving from it.")) return;
    await del({ data: { workspaceId, id } });
    await reload(workspaceId);
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Custom domains</h1>
        <p className="text-sm text-muted-foreground">
          Connect your marketplace's domain so SEO pages serve from your site.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Add a domain</CardTitle>
          <CardDescription>Enter the bare hostname like <code>example.com</code>. Owner only.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex-1 min-w-[280px] space-y-1">
              <Label>Hostname</Label>
              <Input
                value={hostname}
                onChange={(e) => setHostname(e.target.value)}
                placeholder="example.com"
                onKeyDown={(e) => { if (e.key === "Enter") onAdd(); }}
              />
            </div>
            <Button onClick={onAdd} disabled={busy || !workspaceId || !hostname.trim()} className="gap-2">
              {busy && <Loader2 className="h-4 w-4 animate-spin" />} Add domain
            </Button>
          </div>
          {msg && <p className="mt-2 text-sm text-destructive">{msg}</p>}
        </CardContent>
      </Card>

      <div className="space-y-4">
        {rows.length === 0 && (
          <Card><CardContent className="py-8 text-center text-sm text-muted-foreground">No domains yet.</CardContent></Card>
        )}

        {rows.map((d) => (
          <Card key={d.id}>
            <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
              <div className="flex items-center gap-2">
                <Globe className="h-4 w-4 text-muted-foreground" />
                <CardTitle className="text-lg">{d.hostname}</CardTitle>
                {d.verified && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-600">
                    <CheckCircle2 className="h-3 w-3" /> verified
                  </span>
                )}
              </div>
              <Button variant="ghost" size="sm" onClick={() => onDelete(d.id)} className="text-destructive">
                <Trash2 className="h-4 w-4" />
              </Button>
            </CardHeader>
            <CardContent className="space-y-3">
              {!d.verified ? (
                <VerifySection
                  hostname={d.hostname}
                  token={d.verification_token || ""}
                  busy={verifyingId === d.id}
                  error={errors[d.id]}
                  onVerify={() => onVerify(d.id)}
                />
              ) : (
                <details className="rounded-md border bg-muted/30 p-3 text-sm">
                  <summary className="cursor-pointer font-medium">DNS setup</summary>
                  <div className="mt-2 space-y-1 text-muted-foreground">
                    <p>Point a CNAME from <code>{d.hostname}</code> to <code>proxy.founders.click</code>.</p>
                    <p>SSL provisions automatically within ~10 minutes.</p>
                    {d.ssl_status && <p>SSL status: <code>{d.ssl_status}</code></p>}
                  </div>
                </details>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

function VerifySection({
  hostname, token, busy, error, onVerify,
}: { hostname: string; token: string; busy: boolean; error?: string; onVerify: () => void }) {
  return (
    <div className="space-y-3">
      <h3 className="font-semibold">Verify {hostname}</h3>
      <Tabs defaultValue="file">
        <TabsList>
          <TabsTrigger value="file">File upload</TabsTrigger>
          <TabsTrigger value="dns">DNS TXT record</TabsTrigger>
        </TabsList>
        <TabsContent value="file" className="space-y-2 pt-3">
          <p className="text-sm text-muted-foreground">
            Create a file at this path on your site that returns the token as plain text.
          </p>
          <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs">
{`Path:    https://${hostname}/.well-known/founders-click-verify
Content: ${token}`}
          </pre>
        </TabsContent>
        <TabsContent value="dns" className="space-y-2 pt-3">
          <p className="text-sm text-muted-foreground">
            Add this TXT record at your DNS provider. DNS propagation can take 5–60 minutes.
          </p>
          <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs">
{`Name:  _founders-click.${hostname}
Type:  TXT
Value: ${token}`}
          </pre>
        </TabsContent>
      </Tabs>
      <div className="flex items-center gap-3">
        <Button onClick={onVerify} disabled={busy} className="gap-2">
          {busy && <Loader2 className="h-4 w-4 animate-spin" />} Verify
        </Button>
        {error && <span className="text-sm text-destructive">{error}</span>}
      </div>
    </div>
  );
}

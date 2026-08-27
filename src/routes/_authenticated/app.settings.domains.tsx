import { useCallback, useEffect, useRef, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Loader2, CheckCircle2, Trash2, Globe, RefreshCw, ExternalLink } from "lucide-react";
import { getMe } from "@/lib/auth.functions";
import {
  listWorkspaceDomains,
  addWorkspaceDomain,
  verifyWorkspaceDomain,
  deleteWorkspaceDomain,
  updateDomainConnection,
  activateWorkspaceDomain,
  type WorkspaceDomainRow,
  type DomainConnectionType,
} from "@/lib/admin-domains.functions";
import { getSettingsContext } from "@/lib/settings.functions";
import { SettingsNav } from "@/components/settings/SettingsNav";
import { OwnerOnlyBanner } from "@/components/settings/OwnerOnlyBanner";

export const Route = createFileRoute("/_authenticated/app/settings/domains")({
  head: () => ({ meta: [{ title: "Custom Domains — founders.click" }] }),
  component: DomainsPage,
});

const MODE_LABEL: Record<DomainConnectionType, string> = {
  full_proxy: "Root domain (yourdomain.com/a/*)",
  subdomain: "Subdomain (seo.yourdomain.com)",
  customer_proxy: "My own proxy/CDN",
};

const STATUS_LABEL: Record<string, { label: string; tone: "ok" | "warn" | "muted" }> = {
  verification_required: { label: "Verify ownership", tone: "warn" },
  pending: { label: "Verify ownership", tone: "warn" },
  verified: { label: "Verified", tone: "ok" },
  dns_configuration_required: { label: "Point your DNS", tone: "warn" },
  provisioning: { label: "Provisioning", tone: "warn" },
  ssl_pending: { label: "Issuing SSL", tone: "warn" },
  active: { label: "Connected", tone: "ok" },
  error: { label: "Needs attention", tone: "warn" },
  disconnected: { label: "Disconnected", tone: "muted" },
};

function StatusChip({ status }: { status: string }) {
  const s = STATUS_LABEL[status] ?? { label: status, tone: "muted" as const };
  const cls =
    s.tone === "ok"
      ? "bg-emerald-500/10 text-emerald-600"
      : s.tone === "warn"
        ? "bg-amber-500/10 text-amber-600"
        : "bg-muted text-muted-foreground";
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ${cls}`}>
      {s.tone === "ok" && <CheckCircle2 className="h-3 w-3" />} {s.label}
    </span>
  );
}

function DomainsPage() {
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [isOwner, setIsOwner] = useState(true);
  const [rows, setRows] = useState<WorkspaceDomainRow[]>([]);
  const [domainLimit, setDomainLimit] = useState<number>(1);
  const [edgeHostname, setEdgeHostname] = useState("proxy.founders.click");
  const [hostname, setHostname] = useState("");
  const [mode, setMode] = useState<DomainConnectionType>("full_proxy");
  const [busy, setBusy] = useState(false);
  const [workingId, setWorkingId] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [checks, setChecks] = useState<
    Record<string, Array<{ name: string; ok: boolean; detail: string }>>
  >({});

  const list = useServerFn(listWorkspaceDomains);
  const add = useServerFn(addWorkspaceDomain);
  const verify = useServerFn(verifyWorkspaceDomain);
  const del = useServerFn(deleteWorkspaceDomain);
  const updateConn = useServerFn(updateDomainConnection);
  const activate = useServerFn(activateWorkspaceDomain);
  const loadCtx = useServerFn(getSettingsContext);

  useEffect(() => {
    getMe().then((me) => {
      const wsId = me.memberships[0]?.workspace_id ?? null;
      setWorkspaceId(wsId);
      if (wsId) {
        loadCtx({ data: { workspaceId: wsId } })
          .then((c) => setIsOwner(c.isOwner))
          .catch(() => setIsOwner(me.memberships[0]?.role === "owner"));
      }
    });
  }, [loadCtx]);

  const reload = useCallback(
    async (ws: string) => {
      try {
        const r = await list({ data: { workspaceId: ws } });
        setRows(r.rows);
        setDomainLimit(r.domainLimit);
        setEdgeHostname(r.edgeHostname);
      } catch (e) {
        setMsg(e instanceof Error ? e.message : "Failed to load");
      }
    },
    [list],
  );

  useEffect(() => {
    if (workspaceId) reload(workspaceId);
  }, [workspaceId, reload]);

  // Automated progress: while a domain is waiting on the customer's DNS, poll
  // verification / activation in the background — the spec's "Checking
  // domain… → Domain verified ✓" flow with no button-mashing required.
  const pollBusy = useRef(false);
  useEffect(() => {
    if (!workspaceId || !isOwner) return;
    const pending = rows.filter((r) =>
      ["verification_required", "pending", "dns_configuration_required", "provisioning", "ssl_pending"].includes(
        r.status,
      ),
    );
    if (pending.length === 0) return;
    const t = setInterval(async () => {
      if (pollBusy.current) return;
      pollBusy.current = true;
      try {
        for (const d of pending) {
          if (d.status === "verification_required" || d.status === "pending") {
            const r = await verify({ data: { workspaceId, id: d.id } });
            if (r.ok) await reload(workspaceId);
          } else {
            const r = await activate({ data: { workspaceId, id: d.id } });
            if (r.ok) await reload(workspaceId);
          }
        }
      } catch {
        /* next tick */
      } finally {
        pollBusy.current = false;
      }
    }, 25_000);
    return () => clearInterval(t);
  }, [rows, workspaceId, isOwner, verify, activate, reload]);

  async function onAdd() {
    if (!workspaceId || !hostname.trim()) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await add({
        data: { workspaceId, hostname: hostname.trim(), connectionType: mode },
      });
      if (r.ok) {
        setHostname("");
        await reload(workspaceId);
      } else {
        setMsg(r.error);
      }
    } finally {
      setBusy(false);
    }
  }

  async function onVerify(id: string) {
    if (!workspaceId) return;
    setWorkingId(id);
    setErrors((e) => ({ ...e, [id]: "" }));
    try {
      const r = await verify({ data: { workspaceId, id } });
      if (r.ok) await reload(workspaceId);
      else setErrors((e) => ({ ...e, [id]: r.error }));
    } finally {
      setWorkingId(null);
    }
  }

  async function onActivate(id: string) {
    if (!workspaceId) return;
    setWorkingId(id);
    setErrors((e) => ({ ...e, [id]: "" }));
    try {
      const r = await activate({ data: { workspaceId, id } });
      setChecks((c) => ({ ...c, [id]: r.checks ?? [] }));
      if (r.ok) await reload(workspaceId);
    } catch (e) {
      setErrors((er) => ({ ...er, [id]: e instanceof Error ? e.message : "activation failed" }));
    } finally {
      setWorkingId(null);
    }
  }

  async function onDelete(id: string) {
    if (!workspaceId) return;
    if (!confirm("Disconnect this domain? Pages will stop serving from it.")) return;
    await del({ data: { workspaceId, id } });
    await reload(workspaceId);
  }

  async function onSaveOrigin(id: string, origin: string) {
    if (!workspaceId) return;
    const r = await updateConn({ data: { workspaceId, id, customerOrigin: origin || null } });
    if (!r.ok) setErrors((e) => ({ ...e, [id]: r.error ?? "failed" }));
    else await reload(workspaceId);
  }

  const activeCount = rows.filter((r) => r.status !== "disconnected").length;

  return (
    <div className="space-y-6 max-w-3xl pb-10">
      <div>
        <h1 className="text-2xl font-bold">Connected domain</h1>
        <p className="text-sm text-muted-foreground">
          Your SEO pages publish at <code>yourdomain.com/a/…</code> — Founders handles routing,
          hosting, SSL and sitemaps automatically.
        </p>
      </div>

      <SettingsNav />
      <OwnerOnlyBanner isOwner={isOwner} />

      <Card>
        <CardHeader>
          <CardTitle>Connect a domain</CardTitle>
          <CardDescription>
            {activeCount >= domainLimit
              ? `Your plan includes ${domainLimit} connected domain${domainLimit === 1 ? "" : "s"} (${activeCount} in use). Upgrade to connect more.`
              : `Enter the bare hostname, like example.com. Your plan includes ${domainLimit} connected domain${domainLimit === 1 ? "" : "s"}.`}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            {(Object.keys(MODE_LABEL) as DomainConnectionType[]).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={`rounded-lg border p-3 text-left text-sm transition ${
                  mode === m ? "border-primary bg-primary/5" : "border-border/60 hover:bg-muted/30"
                }`}
              >
                <p className="font-medium">{MODE_LABEL[m]}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {m === "full_proxy" &&
                    "Best for SEO. Point your domain at our edge; your existing site keeps working, we serve only /a/*."}
                  {m === "subdomain" &&
                    "One CNAME on a subdomain — works everywhere, no changes to your main site."}
                  {m === "customer_proxy" &&
                    "You already run a CDN/proxy — route /a/* to us yourself."}
                </p>
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex-1 min-w-[280px] space-y-1">
              <Label>Hostname</Label>
              <Input
                value={hostname}
                onChange={(e) => setHostname(e.target.value)}
                placeholder={mode === "subdomain" ? "seo.example.com" : "example.com"}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onAdd();
                }}
                disabled={!isOwner}
              />
            </div>
            <Button
              onClick={onAdd}
              disabled={busy || !workspaceId || !isOwner || !hostname.trim()}
              className="gap-2"
            >
              {busy && <Loader2 className="h-4 w-4 animate-spin" />} Connect domain
            </Button>
          </div>
          {msg && <p className="mt-2 text-sm text-destructive">{msg}</p>}
        </CardContent>
      </Card>

      <div className="space-y-4">
        {rows.length === 0 && (
          <Card>
            <CardContent className="py-8 text-center text-sm text-muted-foreground">
              No domains connected yet.
            </CardContent>
          </Card>
        )}

        {rows.map((d) => (
          <Card key={d.id}>
            <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
              <div className="flex flex-wrap items-center gap-2">
                <Globe className="h-4 w-4 text-muted-foreground" />
                <CardTitle className="text-lg">{d.hostname}</CardTitle>
                <StatusChip status={d.status} />
                <span className="text-xs text-muted-foreground">
                  {MODE_LABEL[d.connection_type]}
                </span>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onDelete(d.id)}
                className="text-destructive"
                disabled={!isOwner}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </CardHeader>
            <CardContent className="space-y-3">
              {(d.status === "verification_required" || d.status === "pending") && (
                <VerifySection
                  hostname={d.hostname}
                  token={d.verification_token || ""}
                  busy={workingId === d.id}
                  error={errors[d.id]}
                  onVerify={() => onVerify(d.id)}
                  canVerify={isOwner}
                />
              )}

              {d.status === "dns_configuration_required" && (
                <div className="space-y-3 rounded-md border bg-muted/30 p-3 text-sm">
                  <p className="font-medium">
                    Ownership verified ✓ — now point your DNS at the Founders edge.
                  </p>
                  {d.connection_type === "full_proxy" && (
                    <>
                      <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs">
                        {`Type:  CNAME (or ALIAS/ANAME at the apex)
Name:  ${d.hostname}
Value: ${edgeHostname}`}
                      </pre>
                      <p className="text-muted-foreground">
                        Your existing website keeps working — we route everything except{" "}
                        <code>/a/*</code> back to your current host
                        {d.customer_origin ? (
                          <>
                            {" "}
                            (detected: <code>{d.customer_origin}</code>)
                          </>
                        ) : (
                          <> — we couldn't auto-detect it, set it below</>
                        )}
                        .
                      </p>
                      <OriginEditor
                        current={d.customer_origin}
                        disabled={!isOwner}
                        onSave={(v) => onSaveOrigin(d.id, v)}
                      />
                    </>
                  )}
                  {d.connection_type === "subdomain" && (
                    <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs">
                      {`Type:  CNAME
Name:  ${d.hostname.split(".")[0]}
Value: ${edgeHostname}`}
                    </pre>
                  )}
                  {d.connection_type === "customer_proxy" && (
                    <div className="space-y-2 text-muted-foreground">
                      <p>
                        In your CDN/server, forward <code>{d.hostname}/a/*</code> to{" "}
                        <code>https://www.founders.click/a/*</code> and send the header{" "}
                        <code>x-forwarded-host: {d.hostname}</code>.
                      </p>
                      <p>
                        Works with Cloudflare Workers/rules, nginx <code>proxy_pass</code>, Vercel
                        rewrites, Netlify proxy redirects, and most edge platforms.
                      </p>
                    </div>
                  )}
                  <div className="flex items-center gap-3">
                    <Button
                      size="sm"
                      onClick={() => onActivate(d.id)}
                      disabled={workingId === d.id || !isOwner}
                      className="gap-2"
                    >
                      {workingId === d.id ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <RefreshCw className="h-4 w-4" />
                      )}
                      Test connection
                    </Button>
                    <span className="text-xs text-muted-foreground">
                      We also re-check automatically every ~30 seconds.
                    </span>
                  </div>
                  {(checks[d.id] ?? []).map((c) => (
                    <p
                      key={c.name}
                      className={`text-xs ${c.ok ? "text-emerald-600" : "text-amber-600"}`}
                    >
                      {c.ok ? "✓" : "✗"} {c.detail}
                    </p>
                  ))}
                  {d.last_error && !(checks[d.id] ?? []).length && (
                    <p className="text-xs text-amber-600">{d.last_error}</p>
                  )}
                </div>
              )}

              {d.status === "active" && (
                <div className="space-y-2 rounded-md border bg-muted/30 p-3 text-sm">
                  <p>
                    SEO pages:{" "}
                    <a
                      className="inline-flex items-center gap-1 underline underline-offset-4"
                      href={`https://${d.hostname}/a/sitemap.xml`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      https://{d.hostname}/a/* <ExternalLink className="h-3 w-3" />
                    </a>
                  </p>
                  <p className="text-muted-foreground">
                    Submit <code>https://{d.hostname}/a/sitemap.xml</code> in Google Search Console
                    so your pages get discovered on your own domain.
                  </p>
                  {d.customer_origin && d.connection_type === "full_proxy" && (
                    <p className="text-xs text-muted-foreground">
                      Everything except <code>/a/*</code> routes to <code>{d.customer_origin}</code>
                      .
                    </p>
                  )}
                </div>
              )}

              {errors[d.id] &&
                d.status !== "dns_configuration_required" &&
                d.status !== "verification_required" && (
                  <p className="text-sm text-destructive">{errors[d.id]}</p>
                )}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

function OriginEditor({
  current,
  disabled,
  onSave,
}: {
  current: string | null;
  disabled: boolean;
  onSave: (v: string) => void;
}) {
  const [v, setV] = useState(current ?? "");
  useEffect(() => setV(current ?? ""), [current]);
  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="flex-1 min-w-[220px] space-y-1">
        <Label className="text-xs">Your current website host (origin)</Label>
        <Input
          value={v}
          onChange={(e) => setV(e.target.value)}
          placeholder="e.g. proxy-ssl.webflow.com"
          disabled={disabled}
        />
      </div>
      <Button size="sm" variant="outline" onClick={() => onSave(v.trim())} disabled={disabled}>
        Save origin
      </Button>
    </div>
  );
}

function VerifySection({
  hostname,
  token,
  busy,
  error,
  onVerify,
  canVerify,
}: {
  hostname: string;
  token: string;
  busy: boolean;
  error?: string;
  onVerify: () => void;
  canVerify: boolean;
}) {
  return (
    <div className="space-y-3">
      <h3 className="font-semibold">Verify you own {hostname}</h3>
      <Tabs defaultValue="dns">
        <TabsList>
          <TabsTrigger value="dns">DNS TXT record</TabsTrigger>
          <TabsTrigger value="file">File upload</TabsTrigger>
        </TabsList>
        <TabsContent value="dns" className="space-y-2 pt-3">
          <p className="text-sm text-muted-foreground">
            Add this TXT record at your DNS provider. We check automatically — this page updates
            itself when the record is found (propagation can take 5–60 minutes).
          </p>
          <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs">
            {`Name:  _founders-click.${hostname}
Type:  TXT
Value: ${token}`}
          </pre>
        </TabsContent>
        <TabsContent value="file" className="space-y-2 pt-3">
          <p className="text-sm text-muted-foreground">
            Create a file at this path on your site that returns the token as plain text.
          </p>
          <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs">
            {`Path:    https://${hostname}/.well-known/founders-click-verify
Content: ${token}`}
          </pre>
        </TabsContent>
      </Tabs>
      <div className="flex items-center gap-3">
        <Button onClick={onVerify} disabled={busy || !canVerify} className="gap-2">
          {busy && <Loader2 className="h-4 w-4 animate-spin" />} Check now
        </Button>
        <span className="text-xs text-muted-foreground">Auto-checking every ~25s…</span>
        {error && <span className="text-sm text-destructive">{error}</span>}
      </div>
    </div>
  );
}

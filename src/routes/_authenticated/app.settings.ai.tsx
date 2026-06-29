import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Loader2, CheckCircle2, AlertCircle, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { getMe } from "@/lib/auth.functions";
import {
  AI_PROVIDERS,
  type AiProvider,
  type CredentialRow,
  type UsageSummary,
  listAiCredentials,
  upsertAiCredential,
  deleteAiCredential,
  testAiCredential,
  getAiUsageSummary,
} from "@/lib/ai-byok.functions";
import { getSettingsContext } from "@/lib/settings.functions";
import { SettingsNav } from "@/components/settings/SettingsNav";
import { OwnerOnlyBanner } from "@/components/settings/OwnerOnlyBanner";

export const Route = createFileRoute("/_authenticated/app/settings/ai")({
  head: () => ({ meta: [{ title: "AI Providers — founders.click" }] }),
  component: AiSettingsPage,
});

const PROVIDER_META: Record<AiProvider, { label: string; placeholder: string; help: string; defaultModel: string }> = {
  openai: { label: "OpenAI", placeholder: "sk-...", help: "Get a key at platform.openai.com/api-keys", defaultModel: "gpt-5-mini" },
  anthropic: { label: "Anthropic (Claude)", placeholder: "sk-ant-...", help: "Get a key at console.anthropic.com/settings/keys", defaultModel: "claude-haiku-4-5" },
  google: { label: "Google AI (Gemini)", placeholder: "AIza...", help: "Get a key at aistudio.google.com/apikey", defaultModel: "gemini-2.5-flash" },
  openrouter: { label: "OpenRouter", placeholder: "sk-or-...", help: "Get a key at openrouter.ai/keys", defaultModel: "google/gemini-2.5-flash" },
};

function AiSettingsPage() {
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [isOwner, setIsOwner] = useState(true);
  const [rows, setRows] = useState<CredentialRow[]>([]);
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [provider, setProvider] = useState<AiProvider>("openai");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const list = useServerFn(listAiCredentials);
  const upsert = useServerFn(upsertAiCredential);
  const del = useServerFn(deleteAiCredential);
  const test = useServerFn(testAiCredential);
  const usageFn = useServerFn(getAiUsageSummary);
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
  useEffect(() => {
    if (!workspaceId) return;
    refresh(workspaceId);
    // eslint-disable-next-line
  }, [workspaceId]);

  async function refresh(ws: string) {
    try {
      const [r, u] = await Promise.all([
        list({ data: { workspaceId: ws } }),
        usageFn({ data: { workspaceId: ws } }),
      ]);
      setRows(r.rows);
      setUsage(u);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load");
    }
  }

  async function save() {
    if (!workspaceId || !apiKey.trim()) return;
    setBusy("save");
    try {
      const meta = PROVIDER_META[provider];
      const r = await upsert({
        data: {
          workspaceId,
          provider,
          apiKey: apiKey.trim(),
          defaultModels: { default: model.trim() || meta.defaultModel },
        },
      });
      if (r.ok) {
        toast.success(`${meta.label} key saved. Test it to start using it.`);
        setApiKey(""); setModel("");
        await refresh(workspaceId);
      } else {
        toast.error(r.error);
      }
    } finally { setBusy(null); }
  }

  async function runTest(p: AiProvider) {
    if (!workspaceId) return;
    setBusy(`test-${p}`);
    try {
      const r = await test({ data: { workspaceId, provider: p } });
      if (r.ok) toast.success(`${PROVIDER_META[p].label} key is valid.`);
      else toast.error(`${PROVIDER_META[p].label}: ${r.error}`);
      await refresh(workspaceId);
    } finally { setBusy(null); }
  }

  async function remove(p: AiProvider) {
    if (!workspaceId) return;
    if (!confirm(`Delete the ${PROVIDER_META[p].label} key?`)) return;
    setBusy(`del-${p}`);
    try {
      const r = await del({ data: { workspaceId, provider: p } });
      if (r.ok) { toast.success("Deleted."); await refresh(workspaceId); }
      else toast.error(r.error);
    } finally { setBusy(null); }
  }

  return (
    <div className="space-y-6 max-w-4xl pb-10">
      <div>
        <h1 className="text-2xl font-bold">AI Providers</h1>
        <p className="text-sm text-muted-foreground">
          Bring your own API keys. Stored encrypted in Supabase Vault and only decrypted server-side at call time.
          Keys are never logged — only the last four characters are shown.
        </p>
      </div>

      <SettingsNav />
      <OwnerOnlyBanner isOwner={isOwner} />

      {/* Usage dashboard */}
      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader className="pb-2"><CardDescription>This month</CardDescription></CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">${(usage?.monthCostUsd ?? 0).toFixed(2)}</div>
            <div className="text-xs text-muted-foreground">{usage?.monthCalls ?? 0} calls · {usage?.monthTokens.toLocaleString() ?? 0} tokens</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardDescription>Your keys (BYOK)</CardDescription></CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">${(usage?.byok.costUsd ?? 0).toFixed(2)}</div>
            <div className="text-xs text-muted-foreground">{usage?.byok.calls ?? 0} calls · billed to your provider</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardDescription>Free tier remaining</CardDescription></CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{usage?.quotaRemaining ?? 20} <span className="text-sm font-normal text-muted-foreground">/ generations</span></div>
            <div className="text-xs text-muted-foreground">{usage?.quotaLifetimeUsed ?? 0} used lifetime · add a key for unlimited</div>
          </CardContent>
        </Card>
      </div>

      {/* Configured keys */}
      <Card>
        <CardHeader>
          <CardTitle>Configured providers</CardTitle>
          <CardDescription>{rows.length} of {AI_PROVIDERS.length} configured. The first valid key is used by default.</CardDescription>
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">No providers yet. Add one below to skip the platform quota.</p>
          ) : (
            <div className="divide-y">
              {rows.map((r) => (
                <div key={r.provider} className="flex flex-wrap items-center gap-3 py-3">
                  <div className="min-w-[160px]">
                    <div className="font-medium">{PROVIDER_META[r.provider].label}</div>
                    <div className="text-xs text-muted-foreground">••••{r.last_four}</div>
                  </div>
                  <div className="min-w-[120px]">
                    {r.status === "valid" && <Badge className="gap-1 bg-emerald-500/15 text-emerald-600 border-emerald-500/30"><CheckCircle2 className="h-3 w-3" />Valid</Badge>}
                    {r.status === "invalid" && <Badge variant="destructive" className="gap-1"><AlertCircle className="h-3 w-3" />Invalid</Badge>}
                    {r.status === "untested" && <Badge variant="outline">Untested</Badge>}
                  </div>
                  <div className="flex-1 text-xs text-muted-foreground">
                    {r.last_error ? <span className="text-destructive">{r.last_error}</span> :
                      r.last_tested_at ? `Tested ${new Date(r.last_tested_at).toLocaleString()}` : "Never tested"}
                  </div>
                  <Button size="sm" variant="outline" disabled={!isOwner || busy === `test-${r.provider}`} onClick={() => runTest(r.provider)} className="gap-2">
                    {busy === `test-${r.provider}` && <Loader2 className="h-3 w-3 animate-spin" />}Test
                  </Button>
                  <Button size="sm" variant="ghost" disabled={!isOwner || busy === `del-${r.provider}`} onClick={() => remove(r.provider)} className="gap-1 text-destructive hover:text-destructive">
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Add / update */}
      <Card>
        <CardHeader>
          <CardTitle>Add or update a key</CardTitle>
          <CardDescription>Owner-only. The full key is never shown again after saving.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label>Provider</Label>
              <select
                className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                value={provider}
                onChange={(e) => setProvider(e.target.value as AiProvider)}
                disabled={!isOwner}
              >
                {AI_PROVIDERS.map((p) => <option key={p} value={p}>{PROVIDER_META[p].label}</option>)}
              </select>
              <p className="text-xs text-muted-foreground">{PROVIDER_META[provider].help}</p>
            </div>
            <div className="space-y-1">
              <Label>API key</Label>
              <Input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={PROVIDER_META[provider].placeholder}
                autoComplete="off"
                disabled={!isOwner}
              />
            </div>
          </div>
          <div className="space-y-1 max-w-md">
            <Label>Default model (optional)</Label>
            <Input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder={PROVIDER_META[provider].defaultModel}
              disabled={!isOwner}
            />
            <p className="text-xs text-muted-foreground">Used by AI features when they don't specify a model.</p>
          </div>
          <Button onClick={save} disabled={busy === "save" || !workspaceId || !isOwner || !apiKey.trim()} className="gap-2">
            {busy === "save" && <Loader2 className="h-4 w-4 animate-spin" />}Save key
          </Button>
        </CardContent>
      </Card>

      {/* Recent calls */}
      <Card>
        <CardHeader>
          <CardTitle>Recent AI calls</CardTitle>
          <CardDescription>Last 25 calls this month. Errors are surfaced verbatim.</CardDescription>
        </CardHeader>
        <CardContent>
          {!usage || usage.recent.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">No calls yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b text-left text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="py-2 pr-4">When</th>
                    <th className="py-2 pr-4">Feature</th>
                    <th className="py-2 pr-4">Provider</th>
                    <th className="py-2 pr-4">Model</th>
                    <th className="py-2 pr-4">Tokens</th>
                    <th className="py-2 pr-4">Cost</th>
                    <th className="py-2">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {usage.recent.map((r, i) => (
                    <tr key={i} className="border-b last:border-0">
                      <td className="py-2 pr-4 text-xs text-muted-foreground">{new Date(r.created_at).toLocaleString()}</td>
                      <td className="py-2 pr-4 text-xs">{r.feature ?? "—"}</td>
                      <td className="py-2 pr-4 text-xs">{r.provider}{r.used_byok ? " (BYOK)" : ""}</td>
                      <td className="py-2 pr-4 font-mono text-xs">{r.model}</td>
                      <td className="py-2 pr-4 text-xs">{r.total_tokens.toLocaleString()}</td>
                      <td className="py-2 pr-4 text-xs">${(r.cost_usd_micros / 1_000_000).toFixed(4)}</td>
                      <td className="py-2 text-xs">
                        {r.status === "ok" ? <span className="text-emerald-600">ok</span> :
                          <span className="text-destructive" title={r.error ?? ""}>{r.status}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

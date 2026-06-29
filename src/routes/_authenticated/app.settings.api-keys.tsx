import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2 } from "lucide-react";
import { getMe } from "@/lib/auth.functions";
import {
  listWorkspaceSecrets,
  upsertWorkspaceSecret,
  deleteWorkspaceSecret,
  type WorkspaceSecretRow,
} from "@/lib/admin-workspace-secrets.functions";
import { getSettingsContext } from "@/lib/settings.functions";
import { SettingsNav } from "@/components/settings/SettingsNav";
import { OwnerOnlyBanner } from "@/components/settings/OwnerOnlyBanner";

export const Route = createFileRoute("/_authenticated/app/settings/api-keys")({
  head: () => ({ meta: [{ title: "API Keys — founders.click" }] }),
  component: ApiKeysPage,
});

const KNOWN_KEYS: Array<{ name: string; help: string }> = [
  {
    name: "OPENROUTER_API_KEY",
    help: "Powers Quick Page Builder and AI content. Get one at openrouter.ai/keys.",
  },
  {
    name: "LOVABLE_API_KEY",
    help: "Powers Coach actions (expand pages, meta, city drafts). Your Lovable project API key.",
  },
  {
    name: "FIRECRAWL_API_KEY",
    help: "Used by competitor scraper, content migration. Get one at firecrawl.dev.",
  },
  { name: "SERPAPI_KEY", help: "Used by rank tracker. Get one at serpapi.com." },
  { name: "GOOGLE_GSC_REFRESH_TOKEN", help: "Used by Search Console import." },
];

function ApiKeysPage() {
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [isOwner, setIsOwner] = useState(true);
  const [rows, setRows] = useState<WorkspaceSecretRow[]>([]);
  const [keyName, setKeyName] = useState(KNOWN_KEYS[0].name);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const list = useServerFn(listWorkspaceSecrets);
  const upsert = useServerFn(upsertWorkspaceSecret);
  const del = useServerFn(deleteWorkspaceSecret);
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
    if (workspaceId && isOwner) reload(workspaceId); /* eslint-disable-next-line */
  }, [workspaceId, isOwner]);

  async function reload(ws: string) {
    try {
      const r = await list({ data: { workspaceId: ws } });
      setRows(r.rows);
    } catch (e) {
      setRows([]);
      if (isOwner) setMsg(e instanceof Error ? e.message : "Failed to load");
    }
  }

  async function save() {
    if (!workspaceId || !value.trim()) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await upsert({
        data: { workspaceId, keyName: keyName.trim().toUpperCase(), value: value.trim() },
      });
      setMsg(r.ok ? "Saved." : `Error: ${r.error}`);
      if (r.ok) {
        setValue("");
        await reload(workspaceId);
      }
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    if (!workspaceId) return;
    if (!confirm("Delete this API key?")) return;
    await del({ data: { workspaceId, id } });
    await reload(workspaceId);
  }

  return (
    <div className="space-y-6 max-w-4xl pb-10">
      <div>
        <h1 className="text-2xl font-bold">API Keys</h1>
        <p className="text-sm text-muted-foreground">
          Bring-your-own keys for AI and SEO tools. Stored encrypted in Vault — only owners can view
          or change them.
        </p>
      </div>

      <SettingsNav />
      <OwnerOnlyBanner isOwner={isOwner} />

      <Card>
        <CardHeader>
          <CardTitle>Add or update a key</CardTitle>
          <CardDescription>
            Owner-only. Values are server-side; the UI never displays the full secret again.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label>Key name</Label>
              <select
                className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                value={keyName}
                onChange={(e) => setKeyName(e.target.value)}
                disabled={!isOwner}
              >
                {KNOWN_KEYS.map((k) => (
                  <option key={k.name} value={k.name}>
                    {k.name}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">
                {KNOWN_KEYS.find((k) => k.name === keyName)?.help}
              </p>
            </div>
            <div className="space-y-1">
              <Label>Value</Label>
              <Input
                type="password"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder="paste secret"
                disabled={!isOwner}
              />
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Button
              onClick={save}
              disabled={busy || !workspaceId || !isOwner || !value.trim()}
              className="gap-2"
            >
              {busy && <Loader2 className="h-4 w-4 animate-spin" />} Save key
            </Button>
            {msg && <span className="text-sm text-muted-foreground">{msg}</span>}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Configured keys</CardTitle>
          <CardDescription>
            {rows.length} key{rows.length === 1 ? "" : "s"}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">No keys yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="py-2 pr-4">Key</th>
                  <th className="py-2 pr-4">Preview</th>
                  <th className="py-2 pr-4">Updated</th>
                  <th className="py-2"></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b last:border-0">
                    <td className="py-2 pr-4 font-mono text-xs">{r.key_name}</td>
                    <td className="py-2 pr-4 font-mono text-xs">{r.preview}</td>
                    <td className="py-2 pr-4 text-xs text-muted-foreground">
                      {new Date(r.updated_at).toLocaleString()}
                    </td>
                    <td className="py-2">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => remove(r.id)}
                        disabled={!isOwner}
                      >
                        Delete
                      </Button>
                    </td>
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

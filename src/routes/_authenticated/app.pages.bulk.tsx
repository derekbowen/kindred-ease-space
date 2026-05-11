import { useEffect, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Loader2, Upload } from "lucide-react";
import { getMe } from "@/lib/auth.functions";
import { bulkCreatePages, listPageTemplates } from "@/lib/tenant-pages.functions";

export const Route = createFileRoute("/_authenticated/app/pages/bulk")({
  head: () => ({ meta: [{ title: "Bulk pages — founders.click" }] }),
  component: BulkPage,
});

const SAMPLE = `slug,title,city,state,category_plural
austin-pools,Pool Rentals in Austin TX,Austin,TX,pools
dallas-pools,Pool Rentals in Dallas TX,Dallas,TX,pools`;

function parseCSV(text: string): Record<string, string>[] {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map((s) => s.trim());
  return lines.slice(1).map((line) => {
    const cells = line.split(",").map((s) => s.trim());
    const row: Record<string, string> = {};
    headers.forEach((h, i) => (row[h] = cells[i] ?? ""));
    return row;
  });
}

function BulkPage() {
  const navigate = useNavigate();
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [templateId, setTemplateId] = useState<string>("");
  const [csv, setCsv] = useState(SAMPLE);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const tplFn = useServerFn(listPageTemplates);
  const bulkFn = useServerFn(bulkCreatePages);

  useEffect(() => {
    Promise.all([getMe(), tplFn()]).then(([me, t]) => {
      setWorkspaceId(me.memberships[0]?.workspace_id ?? null);
      const cityHub = (t.templates as any[]).find((x) => x.slug === "city_hub" && x.is_active);
      if (cityHub) setTemplateId(cityHub.id);
    });
  }, [tplFn]);

  async function onRun() {
    if (!workspaceId || !templateId) return;
    setBusy(true);
    setErr(null);
    setMsg(null);
    const rows = parseCSV(csv).map((r) => ({
      slug: r.slug,
      title: r.title,
      variables: { city: r.city, state: r.state, category_plural: r.category_plural || "listings" },
      listingFilter: { city: r.city, state: r.state, limit: 24, sort: "newest" },
    }));
    if (rows.length === 0) {
      setErr("No rows found");
      setBusy(false);
      return;
    }
    try {
      const r = await bulkFn({
        data: { workspaceId, templateId, rows, status: "draft" },
      });
      if (r.ok) {
        setMsg(`Created/updated ${r.count} pages.`);
        setTimeout(() => navigate({ to: "/app/pages" }), 800);
      } else {
        setErr(r.error);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="p-6 max-w-3xl space-y-6">
      <header>
        <h1 className="text-2xl font-bold">Bulk import pages</h1>
        <p className="text-muted-foreground text-sm">
          Paste CSV with columns: slug, title, city, state, category_plural.
        </p>
      </header>
      {msg && (
        <div className="rounded border border-green-500/30 bg-green-500/10 px-3 py-2 text-sm text-green-300">
          {msg}
        </div>
      )}
      {err && (
        <div className="rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
          {err}
        </div>
      )}
      <Card>
        <CardHeader>
          <CardTitle>CSV input</CardTitle>
          <CardDescription>Up to 500 rows. All created as City Hub drafts.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Label>CSV</Label>
          <Textarea value={csv} onChange={(e) => setCsv(e.target.value)} rows={12} className="font-mono text-xs" />
          <Button onClick={onRun} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Upload className="h-4 w-4 mr-2" />}
            Create pages
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

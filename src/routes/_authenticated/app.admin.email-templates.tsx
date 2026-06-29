import { useEffect, useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { ArrowLeft, Mail, RotateCcw, Save, Send, Eye } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { toast } from "sonner";
import {
  listEmailTemplates,
  saveEmailTemplate,
  resetEmailTemplate,
  sendTestEmailTemplate,
} from "@/lib/email-templates.functions";

export const Route = createFileRoute("/_authenticated/app/admin/email-templates")({
  head: () => ({ meta: [{ title: "Email Templates — Admin" }] }),
  component: EmailTemplatesPage,
});

type ListResult = Awaited<ReturnType<typeof listEmailTemplates>>;
type Template = ListResult["templates"][number];

function applyVars(tpl: string, vars: Record<string, string>) {
  return tpl.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, k) => vars[k] ?? "");
}

function EmailTemplatesPage() {
  const list = useServerFn(listEmailTemplates);
  const save = useServerFn(saveEmailTemplate);
  const reset = useServerFn(resetEmailTemplate);
  const sendTest = useServerFn(sendTestEmailTemplate);

  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [draft, setDraft] = useState<{
    subject: string;
    html: string;
    text: string;
    isEnabled: boolean;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [testEmail, setTestEmail] = useState("");

  async function refresh() {
    setLoading(true);
    try {
      const res = await list({});
      setTemplates(res.templates);
      if (!activeKey && res.templates.length) setActiveKey(res.templates[0].key);
    } catch (e) {
      toast.error("Failed to load templates");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const active = useMemo(
    () => templates.find((t) => t.key === activeKey) ?? null,
    [templates, activeKey],
  );

  useEffect(() => {
    if (!active) {
      setDraft(null);
      return;
    }
    setDraft({
      subject: active.subject ?? active.defaultSubject,
      html: active.html ?? active.defaultHtml,
      text: active.text ?? active.defaultText,
      isEnabled: active.isEnabled,
    });
  }, [active]);

  const sampleVars = useMemo(() => {
    if (!active) return {};
    return Object.fromEntries(active.placeholders.map((p) => [p.name, p.sample]));
  }, [active]);

  async function onSave() {
    if (!active || !draft) return;
    setBusy(true);
    try {
      await save({ data: { key: active.key, ...draft } });
      toast.success("Template saved");
      await refresh();
    } catch (e: any) {
      toast.error(e?.message ?? "Save failed");
    } finally {
      setBusy(false);
    }
  }

  async function onReset() {
    if (!active) return;
    if (!confirm("Reset this template to its default copy?")) return;
    setBusy(true);
    try {
      await reset({ data: { key: active.key } });
      toast.success("Reverted to default");
      await refresh();
    } catch (e: any) {
      toast.error(e?.message ?? "Reset failed");
    } finally {
      setBusy(false);
    }
  }

  async function onSendTest() {
    if (!active || !draft || !testEmail) return;
    setBusy(true);
    try {
      await sendTest({
        data: {
          key: active.key,
          to: testEmail,
          subject: draft.subject,
          html: draft.html,
          text: draft.text,
        },
      });
      toast.success(`Test sent to ${testEmail}`);
    } catch (e: any) {
      toast.error(e?.message ?? "Send failed");
    } finally {
      setBusy(false);
    }
  }

  const grouped = useMemo(() => {
    const g: Record<string, Template[]> = {};
    for (const t of templates) (g[t.category] ??= []).push(t);
    return g;
  }, [templates]);

  const previewSubject = draft
    ? applyVars(draft.subject, sampleVars as Record<string, string>)
    : "";
  const previewHtml = draft ? applyVars(draft.html, sampleVars as Record<string, string>) : "";

  return (
    <div className="container mx-auto max-w-7xl px-4 py-8">
      <div className="mb-6 flex items-center gap-3">
        <Button variant="ghost" size="sm" asChild>
          <Link to="/app">
            <ArrowLeft className="mr-1 h-4 w-4" /> Back
          </Link>
        </Button>
        <div className="flex items-center gap-2">
          <Mail className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-2xl font-bold">Email Templates</h1>
        </div>
      </div>
      <p className="mb-6 max-w-2xl text-sm text-muted-foreground">
        Customize the subject line and body of every transactional email. Use{" "}
        <code className="rounded bg-muted px-1">{"{{placeholder}}"}</code> tokens — they're filled
        in at send time. Disable a template to skip sending it entirely.
      </p>

      {loading ? (
        <Card className="p-8 text-center text-sm text-muted-foreground">Loading…</Card>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[280px_1fr]">
          <aside className="space-y-4">
            {Object.entries(grouped).map(([cat, items]) => (
              <div key={cat}>
                <p className="mb-2 px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {cat}
                </p>
                <div className="space-y-1">
                  {items.map((t) => (
                    <button
                      key={t.key}
                      onClick={() => setActiveKey(t.key)}
                      className={`w-full rounded-md border px-3 py-2 text-left text-sm transition ${
                        activeKey === t.key
                          ? "border-primary bg-primary/5"
                          : "border-border hover:bg-muted/50"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate font-medium">{t.name}</span>
                        {t.isCustomized && (
                          <Badge variant="secondary" className="shrink-0 text-[10px]">
                            Edited
                          </Badge>
                        )}
                      </div>
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">
                        {t.description}
                      </p>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </aside>

          {active && draft ? (
            <Card className="p-6">
              <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold">{active.name}</h2>
                  <p className="text-sm text-muted-foreground">{active.description}</p>
                </div>
                <div className="flex items-center gap-3">
                  <div className="flex items-center gap-2">
                    <Switch
                      id="enabled"
                      checked={draft.isEnabled}
                      onCheckedChange={(v) => setDraft({ ...draft, isEnabled: v })}
                    />
                    <Label htmlFor="enabled" className="text-sm">
                      {draft.isEnabled ? "Enabled" : "Disabled"}
                    </Label>
                  </div>
                </div>
              </div>

              <Tabs defaultValue="edit">
                <TabsList>
                  <TabsTrigger value="edit">Edit</TabsTrigger>
                  <TabsTrigger value="preview">
                    <Eye className="mr-1 h-3.5 w-3.5" /> Preview
                  </TabsTrigger>
                  <TabsTrigger value="placeholders">Placeholders</TabsTrigger>
                </TabsList>

                <TabsContent value="edit" className="space-y-4 pt-4">
                  <div>
                    <Label htmlFor="subject">Subject</Label>
                    <Input
                      id="subject"
                      value={draft.subject}
                      onChange={(e) => setDraft({ ...draft, subject: e.target.value })}
                      className="mt-1 font-mono text-sm"
                    />
                  </div>
                  <div>
                    <Label htmlFor="html">HTML body</Label>
                    <Textarea
                      id="html"
                      value={draft.html}
                      onChange={(e) => setDraft({ ...draft, html: e.target.value })}
                      className="mt-1 min-h-[280px] font-mono text-xs"
                    />
                  </div>
                  <div>
                    <Label htmlFor="text">Plain-text fallback</Label>
                    <Textarea
                      id="text"
                      value={draft.text}
                      onChange={(e) => setDraft({ ...draft, text: e.target.value })}
                      className="mt-1 min-h-[140px] font-mono text-xs"
                    />
                  </div>
                </TabsContent>

                <TabsContent value="preview" className="pt-4">
                  <div className="rounded-md border bg-muted/30 p-4">
                    <p className="mb-1 text-xs font-semibold uppercase text-muted-foreground">
                      Subject
                    </p>
                    <p className="mb-4 text-sm font-medium">{previewSubject}</p>
                    <Separator className="mb-4" />
                    <div
                      className="rounded bg-background p-4 text-sm"
                      dangerouslySetInnerHTML={{ __html: previewHtml }}
                    />
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    Preview uses sample placeholder values shown in the Placeholders tab.
                  </p>
                </TabsContent>

                <TabsContent value="placeholders" className="pt-4">
                  <div className="overflow-hidden rounded-md border">
                    <table className="w-full text-sm">
                      <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
                        <tr>
                          <th className="px-3 py-2">Token</th>
                          <th className="px-3 py-2">Description</th>
                          <th className="px-3 py-2">Sample</th>
                        </tr>
                      </thead>
                      <tbody>
                        {active.placeholders.map((p) => (
                          <tr key={p.name} className="border-t">
                            <td className="px-3 py-2 font-mono text-xs">{`{{${p.name}}}`}</td>
                            <td className="px-3 py-2 text-muted-foreground">{p.description}</td>
                            <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                              {p.sample}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </TabsContent>
              </Tabs>

              <Separator className="my-6" />

              <div className="flex flex-wrap items-end gap-3">
                <Button onClick={onSave} disabled={busy}>
                  <Save className="mr-1 h-4 w-4" /> Save
                </Button>
                {active.isCustomized && (
                  <Button variant="outline" onClick={onReset} disabled={busy}>
                    <RotateCcw className="mr-1 h-4 w-4" /> Reset to default
                  </Button>
                )}
                <div className="ml-auto flex items-end gap-2">
                  <div>
                    <Label htmlFor="test" className="text-xs">
                      Send test to
                    </Label>
                    <Input
                      id="test"
                      type="email"
                      placeholder="you@example.com"
                      value={testEmail}
                      onChange={(e) => setTestEmail(e.target.value)}
                      className="mt-1 w-56"
                    />
                  </div>
                  <Button variant="secondary" onClick={onSendTest} disabled={busy || !testEmail}>
                    <Send className="mr-1 h-4 w-4" /> Send test
                  </Button>
                </div>
              </div>
            </Card>
          ) : (
            <Card className="p-8 text-sm text-muted-foreground">Select a template to edit.</Card>
          )}
        </div>
      )}
    </div>
  );
}

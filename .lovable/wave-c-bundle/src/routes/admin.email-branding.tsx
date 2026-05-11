import * as React from "react";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { checkAdminRole } from "@/server/admin-auth.functions";
import { getEmailBranding, updateEmailBranding, previewAuthEmail } from "@/server/email-branding.functions";
import { AdminLayout } from "@/components/admin-layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";

export const Route = createFileRoute("/admin/email-branding")({
  beforeLoad: async () => {
    if (typeof window === "undefined") return;
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) {
      throw redirect({ to: "/auth", search: { redirect: "/admin/email-branding", mode: "signin" } });
    }
    const { isAdmin } = await checkAdminRole();
    if (!isAdmin) throw redirect({ to: "/admin/no-access" });
  },
  head: () => ({
    meta: [
      { title: "Email Branding — Admin" },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: EmailBrandingPage,
});

type Form = {
  site_name: string;
  sender_name: string;
  logo_url: string;
  primary_color: string;
  primary_text_color: string;
  footer_text: string;
};

const EMPTY: Form = {
  site_name: "",
  sender_name: "",
  logo_url: "",
  primary_color: "#000000",
  primary_text_color: "#ffffff",
  footer_text: "",
};

const TYPES = [
  { id: "signup", label: "Signup confirmation" },
  { id: "magiclink", label: "Magic link" },
  { id: "recovery", label: "Password recovery" },
  { id: "invite", label: "Invite" },
  { id: "email_change", label: "Email change" },
  { id: "reauthentication", label: "Reauthentication" },
];

function EmailBrandingPage() {
  const [form, setForm] = React.useState<Form>(EMPTY);
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [previewType, setPreviewType] = React.useState("signup");
  const [previewHtml, setPreviewHtml] = React.useState<string>("");
  const [previewLoading, setPreviewLoading] = React.useState(false);

  React.useEffect(() => {
    (async () => {
      try {
        const data = await getEmailBranding();
        setForm({
          site_name: data.site_name,
          sender_name: data.sender_name,
          logo_url: data.logo_url ?? "",
          primary_color: data.primary_color,
          primary_text_color: data.primary_text_color,
          footer_text: data.footer_text ?? "",
        });
      } catch (e: any) {
        toast.error(e?.message || "Failed to load branding");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const set = <K extends keyof Form>(k: K, v: Form[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  async function loadPreview(type: string) {
    setPreviewLoading(true);
    setPreviewHtml("");
    try {
      const { html } = await previewAuthEmail({ data: { type } } as any);
      setPreviewHtml(html);
    } catch (e: any) {
      setPreviewHtml(`<p style="padding:24px;font-family:sans-serif;color:#888">Preview unavailable: ${e?.message || "error"}</p>`);
    } finally {
      setPreviewLoading(false);
    }
  }

  React.useEffect(() => { void loadPreview(previewType); }, [previewType]);

  async function handleSave() {
    setSaving(true);
    try {
      await updateEmailBranding({
        data: {
          site_name: form.site_name,
          sender_name: form.sender_name,
          logo_url: form.logo_url || null,
          primary_color: form.primary_color,
          primary_text_color: form.primary_text_color,
          footer_text: form.footer_text || null,
        },
      } as any);
      toast.success("Branding saved");
      void loadPreview(previewType);
    } catch (e: any) {
      toast.error(e?.message || "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <AdminLayout title="Email branding">
        <div className="text-sm text-muted-foreground">Loading…</div>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout title="Email branding">
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-4 rounded-xl border border-border bg-card p-5">
          <div>
            <h2 className="text-lg font-semibold">Branding</h2>
            <p className="text-xs text-muted-foreground">
              Applied to all auth emails (signup, magic link, password reset, invite, email change, reauthentication).
            </p>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="site_name">Site name</Label>
            <Input id="site_name" value={form.site_name} onChange={(e) => set("site_name", e.target.value)} />
            <p className="text-[11px] text-muted-foreground">Shown in subjects, body copy, and previews.</p>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="sender_name">Sender name</Label>
            <Input id="sender_name" value={form.sender_name} onChange={(e) => set("sender_name", e.target.value)} />
            <p className="text-[11px] text-muted-foreground">"From" name on the email envelope.</p>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="logo_url">Logo URL</Label>
            <Input id="logo_url" placeholder="https://…/logo.png" value={form.logo_url} onChange={(e) => set("logo_url", e.target.value)} />
            <p className="text-[11px] text-muted-foreground">Optional. Renders at the top of every email (~40px tall).</p>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="primary_color">Button background</Label>
              <div className="flex gap-2">
                <input
                  type="color"
                  value={form.primary_color}
                  onChange={(e) => set("primary_color", e.target.value)}
                  className="h-10 w-12 cursor-pointer rounded border border-border bg-background"
                />
                <Input id="primary_color" value={form.primary_color} onChange={(e) => set("primary_color", e.target.value)} />
              </div>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="primary_text_color">Button text</Label>
              <div className="flex gap-2">
                <input
                  type="color"
                  value={form.primary_text_color}
                  onChange={(e) => set("primary_text_color", e.target.value)}
                  className="h-10 w-12 cursor-pointer rounded border border-border bg-background"
                />
                <Input id="primary_text_color" value={form.primary_text_color} onChange={(e) => set("primary_text_color", e.target.value)} />
              </div>
            </div>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="footer_text">Footer text</Label>
            <Textarea
              id="footer_text"
              rows={3}
              placeholder="© Pool Rental Near Me · 123 Main St · Reply to this email if you need help."
              value={form.footer_text}
              onChange={(e) => set("footer_text", e.target.value)}
            />
            <p className="text-[11px] text-muted-foreground">Optional. Appears below the body of every auth email.</p>
          </div>

          <div className="flex justify-end pt-2">
            <Button onClick={handleSave} disabled={saving}>
              {saving ? "Saving…" : "Save branding"}
            </Button>
          </div>
        </div>

        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            {TYPES.map((t) => (
              <button
                key={t.id}
                onClick={() => setPreviewType(t.id)}
                className={`rounded-md border px-2.5 py-1 text-xs ${
                  previewType === t.id
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-card hover:bg-muted"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="overflow-hidden rounded-xl border border-border bg-white">
            {previewLoading ? (
              <div className="p-6 text-sm text-muted-foreground">Loading preview…</div>
            ) : (
              <iframe
                title="Email preview"
                srcDoc={previewHtml}
                className="h-[640px] w-full border-0"
              />
            )}
          </div>
          <p className="text-[11px] text-muted-foreground">
            Preview reflects the saved branding. Save changes, then re-render to update.
          </p>
        </div>
      </div>
    </AdminLayout>
  );
}

import { useState } from "react";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { getPublicAffiliateForm, submitAffiliateApplication } from "@/lib/affiliate-public.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export const Route = createFileRoute("/apply/$slug")({
  loader: async ({ params }) => {
    const r = await getPublicAffiliateForm({ data: { slug: params.slug } });
    if (!r.form) throw notFound();
    return { form: r.form, slug: params.slug };
  },
  head: ({ loaderData }) => ({
    meta: [{ title: loaderData ? `Become an affiliate — ${loaderData.form.workspaceName}` : "Affiliate sign-up" }],
  }),
  component: ApplyPage,
  notFoundComponent: () => (
    <div className="min-h-screen flex items-center justify-center bg-background text-foreground">
      <p className="text-muted-foreground">This affiliate program isn't available.</p>
    </div>
  ),
});

function ApplyPage() {
  const { form, slug } = Route.useLoaderData();
  const submit = useServerFn(submitAffiliateApplication);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [programId, setProgramId] = useState(form.programs[0]?.id ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const primary = form.branding.primary || "#f97316";

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true); setError(null);
    try {
      const r = await submit({ data: { slug, programId, name, email } });
      if (r.ok) setDone(true);
      else setError(r.error);
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-background text-foreground flex items-center justify-center px-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center">
          {form.branding.logo && <img src={form.branding.logo} alt="" className="mx-auto mb-3 h-12 w-auto" />}
          <h1 className="text-xl font-bold">{form.workspaceName}</h1>
          <p className="mt-1 text-sm text-muted-foreground">Apply to become an affiliate</p>
        </div>

        {done ? (
          <div className="rounded-lg border border-border p-6 text-center">
            <p className="text-sm">Thanks! Your application has been received. We'll email you once it's reviewed.</p>
          </div>
        ) : form.programs.length === 0 ? (
          <p className="text-center text-sm text-muted-foreground">No programs are accepting applications right now.</p>
        ) : (
          <form onSubmit={onSubmit} className="space-y-4">
            {form.programs.length > 1 && (
              <div className="space-y-1">
                <Label htmlFor="program">Program</Label>
                <select id="program" value={programId} onChange={(e) => setProgramId(e.target.value)} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm">
                  {form.programs.map((p: { id: string; name: string }) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
            )}
            <div className="space-y-1"><Label htmlFor="name">Your name</Label><Input id="name" required minLength={2} value={name} onChange={(e) => setName(e.target.value)} /></div>
            <div className="space-y-1"><Label htmlFor="email">Email</Label><Input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></div>
            {error && <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
            <Button type="submit" className="w-full" disabled={submitting} style={{ backgroundColor: primary }}>
              {submitting ? "Submitting…" : "Apply now"}
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}

import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { submitSupportTicket } from "@/lib/help.functions";
import { Breadcrumb } from "@/components/help/Breadcrumb";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { canonicalUrl } from "@/lib/canonical";
import { CheckCircle2 } from "lucide-react";

export const Route = createFileRoute("/help/contact")({
  head: () => ({
    meta: [
      { title: "Contact Support — founders.click Help" },
      { name: "description", content: "Get in touch with the founders.click support team. We typically reply within 1 business day." },
      { property: "og:url", content: canonicalUrl("/help/contact") },
    ],
    links: [{ rel: "canonical", href: canonicalUrl("/help/contact") }],
  }),
  component: ContactPage,
});

function ContactPage() {
  const [submitting, setSubmitting] = useState(false);
  const [ticketId, setTicketId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const submit = useServerFn(submitSupportTicket);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    const fd = new FormData(e.currentTarget);
    try {
      const res = await submit({
        data: {
          email: String(fd.get("email") ?? ""),
          name: String(fd.get("name") ?? "") || null,
          subject: String(fd.get("subject") ?? ""),
          message: String(fd.get("message") ?? ""),
          category: (String(fd.get("category") ?? "other") as "billing" | "technical" | "sales" | "other"),
        },
      });
      if (res.ok) setTicketId(res.ticketId);
      else setError(res.error ?? "Something went wrong.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="max-w-2xl mx-auto px-6 py-10">
      <Breadcrumb items={[{ label: "Contact" }]} />
      <h1 className="text-3xl font-bold tracking-tight">Contact support</h1>
      <p className="mt-2 text-muted-foreground">We typically reply within 1 business day.</p>

      {ticketId ? (
        <div className="mt-8 rounded-lg border border-green-500/30 bg-green-500/5 p-6">
          <CheckCircle2 className="h-6 w-6 text-green-500" />
          <h2 className="mt-3 text-lg font-semibold">Ticket received</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Your ticket ID is <code className="text-foreground font-mono text-xs">{ticketId}</code>. We'll email you shortly.
          </p>
        </div>
      ) : (
        <form onSubmit={onSubmit} className="mt-8 space-y-5">
          <div className="grid sm:grid-cols-2 gap-4">
            <div>
              <Label htmlFor="name">Your name</Label>
              <Input id="name" name="name" maxLength={120} className="mt-1.5" />
            </div>
            <div>
              <Label htmlFor="email">Email <span className="text-destructive">*</span></Label>
              <Input id="email" name="email" type="email" required maxLength={255} className="mt-1.5" />
            </div>
          </div>
          <div>
            <Label htmlFor="category">Category</Label>
            <Select name="category" defaultValue="other">
              <SelectTrigger className="mt-1.5"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="technical">Technical issue</SelectItem>
                <SelectItem value="billing">Billing</SelectItem>
                <SelectItem value="sales">Sales / pre-purchase</SelectItem>
                <SelectItem value="other">Other</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="subject">Subject <span className="text-destructive">*</span></Label>
            <Input id="subject" name="subject" required minLength={3} maxLength={200} className="mt-1.5" />
          </div>
          <div>
            <Label htmlFor="message">Message <span className="text-destructive">*</span></Label>
            <Textarea id="message" name="message" required minLength={10} maxLength={5000} rows={6} className="mt-1.5" />
            <p className="mt-1 text-xs text-muted-foreground">10–5,000 characters.</p>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button type="submit" disabled={submitting} className="bg-orange-500 hover:bg-orange-600">
            {submitting ? "Sending…" : "Send message"}
          </Button>
        </form>
      )}
    </div>
  );
}

import { useEffect, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";

export const Route = createFileRoute("/reset-password")({
  head: () => ({ meta: [{ title: "Reset password — founders.click" }] }),
  component: ResetPasswordPage,
});

function ResetPasswordPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [mode, setMode] = useState<"request" | "update">("request");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    // Implicit flow returns "#...type=recovery"; PKCE returns "?code=...". In both
    // cases supabase-js fires a PASSWORD_RECOVERY auth event once the recovery
    // session is established, which is the only reliable signal (the URL hash is
    // cleared by detectSessionInUrl before this effect may run).
    if (window.location.hash.includes("type=recovery")) {
      setMode("update");
    }
    const { data } = supabase.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY") setMode("update");
    });
    return () => data.subscription.unsubscribe();
  }, []);

  const onRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/reset-password`,
    });
    setSubmitting(false);
    if (error) return toast.error(error.message);
    toast.success("Check your email for a reset link.");
  };

  const onUpdate = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    setSubmitting(false);
    if (error) return toast.error(error.message);
    toast.success("Password updated.");
    navigate({ to: "/app" });
  };

  return (
    <div className="dark min-h-screen bg-background text-foreground flex items-center justify-center px-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center">
          <Link to="/" className="text-xl font-bold tracking-tight">
            founders<span className="text-orange-500">.click</span>
          </Link>
          <p className="mt-2 text-sm text-muted-foreground">
            {mode === "update" ? "Set a new password" : "We'll email you a reset link"}
          </p>
        </div>
        {mode === "request" ? (
          <form onSubmit={onRequest} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <Button type="submit" className="w-full" disabled={submitting}>
              {submitting ? "Sending…" : "Send reset link"}
            </Button>
          </form>
        ) : (
          <form onSubmit={onUpdate} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="newPassword">New password</Label>
              <Input id="newPassword" type="password" required minLength={8} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
            </div>
            <Button type="submit" className="w-full" disabled={submitting}>
              {submitting ? "Updating…" : "Update password"}
            </Button>
          </form>
        )}
        <div className="text-center text-sm text-muted-foreground">
          <Link to="/login" className="hover:text-foreground">Back to sign in</Link>
        </div>
      </div>
    </div>
  );
}

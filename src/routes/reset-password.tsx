import { useEffect, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { hasRecoveryMarker, passwordFormMode } from "@/lib/auth-landing";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { userMessage } from "@/lib/user-message";

export const Route = createFileRoute("/reset-password")({
  head: () => ({
    meta: [
      { title: "Reset password — founders.click" },
      { name: "robots", content: "noindex, nofollow" },
      {
        name: "description",
        content:
          "Reset the password on your founders.click account. Request a secure recovery link by email, then set a new password to regain access.",
      },
    ],
  }),
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
    let live = true;
    // Implicit flow returns "#...type=recovery"; PKCE returns "?code=...". In both
    // cases supabase-js fires a PASSWORD_RECOVERY auth event once the recovery
    // session is established, which is the only reliable signal (the URL hash is
    // cleared by detectSessionInUrl before this effect may run).
    const hash = window.location.hash;
    const search = window.location.search;
    if (passwordFormMode({ search, hash, hasSession: false }) === "update") {
      setMode("update");
    }
    // A recovery link that landed elsewhere (the Auth Site URL is the
    // homepage) is sent here by the root auth bridge as ?recovery=1, AFTER
    // PASSWORD_RECOVERY has fired — this page's listener below never hears
    // it. With the live recovery session that marker means "set a new
    // password"; without a session it is just a URL.
    if (hasRecoveryMarker(search)) {
      void supabase.auth.getSession().then(({ data: current }) => {
        if (
          live &&
          passwordFormMode({ search, hash, hasSession: !!current.session }) === "update"
        ) {
          setMode("update");
        }
      });
    }
    // An expired or already-used link arrives as
    // "#error=access_denied&error_code=otp_expired" — surface it instead of
    // silently showing the request form again with no explanation.
    if (window.location.hash.includes("error_code=otp_expired")) {
      toast.error("That reset link has expired or was already used. Request a new one below.");
    } else if (window.location.hash.includes("error=access_denied")) {
      toast.error("That reset link is no longer valid. Request a new one below.");
    }
    const { data } = supabase.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY") setMode("update");
    });
    return () => {
      live = false;
      data.subscription.unsubscribe();
    };
  }, []);

  const onRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/reset-password`,
    });
    setSubmitting(false);
    if (error) {
      return toast.error(
        userMessage(error, "Couldn't send the reset link. Check the email address and try again."),
      );
    }
    toast.success("Check your email for a reset link.");
  };

  const onUpdate = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    setSubmitting(false);
    if (error) {
      return toast.error(
        userMessage(
          error,
          "Couldn't update your password. Request a new reset link and try again.",
        ),
      );
    }
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
          <h1 className="mt-4 text-2xl font-bold tracking-tight">
            {mode === "update" ? "Set a new password" : "Reset your password"}
          </h1>
          {mode === "request" && (
            <p className="mt-2 text-sm text-muted-foreground">We'll email you a reset link.</p>
          )}
        </div>
        {mode === "request" ? (
          <form onSubmit={onRequest} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <Button type="submit" className="w-full" disabled={submitting}>
              {submitting ? "Sending…" : "Send reset link"}
            </Button>
          </form>
        ) : (
          <form onSubmit={onUpdate} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="newPassword">New password</Label>
              <Input
                id="newPassword"
                type="password"
                required
                minLength={8}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
              />
            </div>
            <Button type="submit" className="w-full" disabled={submitting}>
              {submitting ? "Updating…" : "Update password"}
            </Button>
          </form>
        )}
        <div className="text-center text-sm text-muted-foreground">
          <Link to="/login" className="hover:text-foreground">
            Back to sign in
          </Link>
        </div>
      </div>
    </div>
  );
}

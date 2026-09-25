import { useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { userMessage } from "@/lib/user-message";

export const Route = createFileRoute("/signup")({
  head: () => ({
    meta: [
      { title: "Start your free trial — founders.click" },
      { name: "robots", content: "noindex, nofollow" },
      {
        name: "description",
        content: "Create a founders.click workspace and start your 14-day free trial.",
      },
    ],
  }),
  component: SignupPage,
});

function SignupPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [confirmEmail, setConfirmEmail] = useState(false);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: `${window.location.origin}/app`,
        data: { display_name: name, full_name: name },
      },
    });
    setSubmitting(false);
    if (error) {
      toast.error(
        userMessage(
          error,
          "Couldn't create your account. Try again, or contact support if it keeps happening.",
        ),
      );
      return;
    }
    // When email confirmation is required, signUp returns no session — keep the
    // user here with a "check your email" message instead of bouncing them into
    // the app only to be kicked to /login by the auth guard.
    if (data.session) {
      navigate({ to: "/app" });
    } else {
      setConfirmEmail(true);
      toast.success("Check your email to confirm your account.");
    }
  };

  const onGoogle = async () => {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${window.location.origin}/app` },
    });

    if (error) {
      if (error.message.toLowerCase().includes("provider is not enabled")) {
        toast.error("Google sign-up isn't available yet. Sign up with your email and a password.");
        return;
      }

      toast.error(
        userMessage(
          error,
          "Couldn't start Google sign-up. Try again, or sign up with your email and a password.",
        ),
      );
    }
  };

  return (
    <div className="dark min-h-screen bg-background text-foreground flex items-center justify-center px-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center">
          <Link to="/" className="text-xl font-bold tracking-tight">
            founders<span className="text-orange-500">.click</span>
          </Link>
          {/* The page's one heading. The page stays noindex (see head). */}
          <h1 className="mt-4 text-2xl font-semibold tracking-tight">
            {confirmEmail ? "Check your email" : "Start your free trial"}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">14-day free trial. No card required.</p>
        </div>
        {confirmEmail ? (
          <div className="space-y-4 text-center">
            <p className="text-sm text-muted-foreground">
              We sent a confirmation link to{" "}
              <span className="font-medium text-foreground">{email}</span>. Click it to activate
              your workspace, then sign in.
            </p>
            <Button asChild className="w-full">
              <Link to="/login">Go to sign in</Link>
            </Button>
          </div>
        ) : (
          <>
            <form onSubmit={onSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="name">Your name</Label>
                <Input id="name" required value={name} onChange={(e) => setName(e.target.value)} />
              </div>
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
              <div className="space-y-2">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  type="password"
                  required
                  minLength={8}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
              <Button type="submit" className="w-full" disabled={submitting}>
                {submitting ? "Creating account…" : "Start free trial"}
              </Button>
              <p className="text-center text-xs text-muted-foreground">
                By creating an account you agree to the{" "}
                <Link to="/terms" className="underline hover:text-foreground">
                  Terms of Service
                </Link>{" "}
                and{" "}
                <Link to="/privacy" className="underline hover:text-foreground">
                  Privacy Policy
                </Link>
                .
              </p>
            </form>
            <Button variant="outline" className="w-full" onClick={onGoogle}>
              Continue with Google
            </Button>
            <div className="text-center text-sm text-muted-foreground">
              Already have an account?{" "}
              <Link to="/login" className="text-orange-500 hover:underline">
                Sign in
              </Link>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

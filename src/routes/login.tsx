import { useState } from "react";
import { createFileRoute, Link, useNavigate, useSearch } from "@tanstack/react-router";
import { z } from "zod";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";

const searchSchema = z.object({ next: z.string().optional() });

export const Route = createFileRoute("/login")({
  head: () => ({
    meta: [
      { title: "Sign in — founders.click" },
      { name: "description", content: "Sign in to your founders.click workspace." },
    ],
  }),
  validateSearch: searchSchema,
  component: LoginPage,
});

function LoginPage() {
  const navigate = useNavigate();
  const search = useSearch({ from: "/login" });
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setSubmitting(false);
    if (error) {
      setError(error.message);
      toast.error(error.message);
      return;
    }
    navigate({ to: (search.next as string | undefined) ?? "/app" });
  };

  const onGoogle = async () => {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${window.location.origin}/app` },
    });

    if (error) {
      if (error.message.toLowerCase().includes("provider is not enabled")) {
        toast.error("Google sign-in is not enabled in Supabase yet.");
        return;
      }

      toast.error(error.message);
    }
  };

  return (
    <div className="dark min-h-screen bg-background text-foreground flex items-center justify-center px-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center">
          <Link to="/" className="text-xl font-bold tracking-tight">
            founders<span className="text-orange-500">.click</span>
          </Link>
          <p className="mt-2 text-sm text-muted-foreground">Welcome back.</p>
        </div>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <Input id="password" type="password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          {error && (
            <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          )}
          <Button type="submit" className="w-full" disabled={submitting}>
            {submitting ? "Signing in…" : "Sign in"}
          </Button>
        </form>
        <Button variant="outline" className="w-full" onClick={onGoogle}>
          Continue with Google
        </Button>
        <div className="text-center text-sm text-muted-foreground space-y-1">
          <div>
            <Link to="/reset-password" className="hover:text-foreground">Forgot password?</Link>
          </div>
          <div>
            New here?{" "}
            <Link to="/signup" className="text-orange-500 hover:underline">Create an account</Link>
          </div>
        </div>
      </div>
    </div>
  );
}

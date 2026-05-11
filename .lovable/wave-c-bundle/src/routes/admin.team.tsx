import * as React from "react";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { checkAdminRole } from "@/server/admin-auth.functions";
import {
  listAdmins,
  grantAdmin,
  revokeAdmin,
  createAdminUser,
  setAdminPassword,
  sendAdminPasswordReset,
  type AdminTeamMember,
} from "@/server/admin-team.functions";
import { AdminLayout } from "@/components/admin-layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";

export const Route = createFileRoute("/admin/team")({
  beforeLoad: async () => {
    if (typeof window === "undefined") return;
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) {
      throw redirect({ to: "/auth", search: { redirect: "/admin/team", mode: "signin" } });
    }
    const { isAdmin } = await checkAdminRole();
    if (!isAdmin) throw redirect({ to: "/admin/no-access" });
  },
  head: () => ({
    meta: [
      { title: "Admin team — PRNM" },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: TeamPage,
});

function genPassword(len = 14) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%";
  const arr = new Uint32Array(len);
  crypto.getRandomValues(arr);
  return Array.from(arr, (n) => chars[n % chars.length]).join("");
}

function TeamPage() {
  const [admins, setAdmins] = React.useState<AdminTeamMember[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);

  // Create form
  const [newEmail, setNewEmail] = React.useState("");
  const [newName, setNewName] = React.useState("");
  const [newPassword, setNewPassword] = React.useState("");

  // Grant existing
  const [identifier, setIdentifier] = React.useState("");

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const r = await listAdmins();
      setAdmins(r.admins);
    } catch (e: any) {
      toast.error(e?.message || "Failed to load admins");
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => { void load(); }, [load]);

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!newEmail.trim() || !newPassword || busy) return;
    setBusy(true);
    try {
      await createAdminUser({ data: { email: newEmail.trim(), password: newPassword, full_name: newName.trim() || undefined } });
      toast.success(`Admin created. Password: ${newPassword}`);
      setNewEmail(""); setNewName(""); setNewPassword("");
      await load();
    } catch (e: any) {
      toast.error(e?.message || "Failed to create admin");
    } finally {
      setBusy(false);
    }
  }

  async function onGrant(e: React.FormEvent) {
    e.preventDefault();
    if (!identifier.trim() || busy) return;
    setBusy(true);
    try {
      await grantAdmin({ data: { identifier: identifier.trim() } });
      toast.success("Admin granted.");
      setIdentifier("");
      await load();
    } catch (e: any) {
      toast.error(e?.message || "Failed to grant admin");
    } finally {
      setBusy(false);
    }
  }

  async function onRevoke(user_id: string, label: string) {
    if (!confirm(`Remove admin access from ${label}?`)) return;
    try {
      await revokeAdmin({ data: { user_id } });
      toast.success("Admin removed.");
      await load();
    } catch (e: any) {
      toast.error(e?.message || "Failed to remove admin");
    }
  }

  async function onResetPassword(user_id: string, label: string) {
    const pwd = prompt(`Set new password for ${label} (min 8 chars). Leave empty to auto-generate:`);
    if (pwd === null) return;
    const password = pwd.trim() || genPassword();
    if (password.length < 8) { toast.error("Password too short"); return; }
    try {
      await setAdminPassword({ data: { user_id, password } });
      // Show in a way the admin can copy
      window.prompt(`New password for ${label} (copy this):`, password);
      toast.success("Password updated.");
    } catch (e: any) {
      toast.error(e?.message || "Failed to update password");
    }
  }

  async function onSendReset(email: string) {
    try {
      await sendAdminPasswordReset({ data: { email } });
      toast.success(`Password reset email sent to ${email}`);
    } catch (e: any) {
      toast.error(e?.message || "Failed to send reset email");
    }
  }

  return (
    <AdminLayout title="Team">
      <h1 className="text-3xl font-bold">Admin team</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Create new admin accounts with email + password, or grant admin access to an existing user.
      </p>

      {/* Create new admin */}
      <form onSubmit={onCreate} className="mt-6 grid gap-3 rounded-xl border border-border bg-card p-4 sm:grid-cols-[1fr_1fr_1fr_auto_auto] sm:items-end">
        <div>
          <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Email</label>
          <Input value={newEmail} onChange={(e) => setNewEmail(e.target.value)} placeholder="user@example.com" type="email" className="mt-1" />
        </div>
        <div>
          <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Full name (optional)</label>
          <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Jane Doe" className="mt-1" />
        </div>
        <div>
          <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Password</label>
          <Input value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="min 8 chars" className="mt-1" />
        </div>
        <Button type="button" variant="outline" onClick={() => setNewPassword(genPassword())}>Generate</Button>
        <Button type="submit" disabled={busy || !newEmail.trim() || newPassword.length < 8}>
          {busy ? "Creating…" : "Create admin"}
        </Button>
      </form>

      {/* Grant existing */}
      <form onSubmit={onGrant} className="mt-4 flex flex-wrap items-end gap-3 rounded-xl border border-border bg-card p-4">
        <div className="min-w-[260px] flex-1">
          <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Grant admin to existing user (email or user ID)</label>
          <Input value={identifier} onChange={(e) => setIdentifier(e.target.value)} placeholder="helper@example.com" className="mt-1" />
        </div>
        <Button type="submit" variant="secondary" disabled={busy || !identifier.trim()}>
          {busy ? "Granting…" : "Grant admin"}
        </Button>
      </form>

      <section className="mt-8 rounded-xl border border-border">
        <div className="flex items-center justify-between border-b border-border px-4 py-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Current admins ({admins.length})
          </h2>
          <button onClick={load} className="text-xs font-medium text-primary hover:underline">
            Refresh
          </button>
        </div>
        <ul className="divide-y divide-border">
          {loading && <li className="px-4 py-6 text-center text-sm text-muted-foreground">Loading…</li>}
          {!loading && admins.length === 0 && (
            <li className="px-4 py-6 text-center text-sm text-muted-foreground">No admins yet.</li>
          )}
          {admins.map((a) => {
            const name = a.full_name || a.display_name || "(no name)";
            const label = a.email || name;
            return (
              <li key={a.user_id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{name}</div>
                  <div className="truncate text-xs text-muted-foreground">{a.email || "(no email)"}</div>
                  <div className="truncate font-mono text-[10px] text-muted-foreground/70">{a.user_id}</div>
                  {a.last_sign_in_at && (
                    <div className="text-[10px] text-muted-foreground">Last sign-in: {new Date(a.last_sign_in_at).toLocaleString()}</div>
                  )}
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  <button
                    onClick={() => onResetPassword(a.user_id, label)}
                    className="rounded-md border border-border bg-background px-3 py-1 text-xs font-semibold hover:bg-accent"
                  >
                    Set password
                  </button>
                  {a.email && (
                    <button
                      onClick={() => onSendReset(a.email!)}
                      className="rounded-md border border-border bg-background px-3 py-1 text-xs font-semibold hover:bg-accent"
                    >
                      Send reset email
                    </button>
                  )}
                  <button
                    onClick={() => onRevoke(a.user_id, label)}
                    className="rounded-md border border-red-500/40 bg-red-500/5 px-3 py-1 text-xs font-semibold text-red-700 hover:bg-red-500/10 dark:text-red-300"
                  >
                    Remove
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      </section>
    </AdminLayout>
  );
}

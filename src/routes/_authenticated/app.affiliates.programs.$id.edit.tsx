import { useEffect, useState } from "react";
import { createFileRoute, useNavigate, useParams } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { getMe } from "@/lib/auth.functions";
import { getProgram, upsertProgram } from "@/lib/affiliates.functions";

export const Route = createFileRoute("/_authenticated/app/affiliates/programs/$id/edit")({
  head: () => ({ meta: [{ title: "Edit Program — founders.click" }] }),
  component: ProgramEdit,
});

function ProgramEdit() {
  const { id } = useParams({ from: "/_authenticated/app/affiliates/programs/$id/edit" });
  const isNew = id === "new";
  const navigate = useNavigate();
  const save = useServerFn(upsertProgram);
  const load = useServerFn(getProgram);

  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [trigger, setTrigger] = useState<"signup" | "transaction">("transaction");
  const [payoutType, setPayoutType] = useState<"percentage" | "fixed">("percentage");
  const [payoutValue, setPayoutValue] = useState("5");
  const [active, setActive] = useState(false);
  const [autoEnroll, setAutoEnroll] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getMe().then(async (me) => {
      const ws = me?.memberships?.[0]?.workspace_id ?? null;
      setWorkspaceId(ws);
      if (ws && !isNew) {
        const r = await load({ data: { workspaceId: ws, id } });
        if (r.program) {
          const p = r.program;
          setName(p.name); setTrigger(p.trigger); setPayoutType(p.payout_type);
          setPayoutValue(String(p.payout_value)); setActive(p.active); setAutoEnroll(p.auto_enroll);
        }
      }
    }).catch(() => {});
  }, [id, isNew, load]);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!workspaceId) return;
    setSaving(true); setError(null);
    try {
      await save({
        data: {
          workspaceId, id: isNew ? undefined : id, name, trigger, payoutType,
          payoutValue: Number(payoutValue) || 0, active, autoEnroll,
        },
      });
      toast.success("Program saved.");
      navigate({ to: "/app/affiliates/programs" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not save program";
      setError(msg); toast.error(msg);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-xl">
      <h1 className="text-2xl font-bold mb-4">{isNew ? "Create program" : "Edit program"}</h1>
      <Card>
        <CardHeader><CardTitle className="text-base">Program details</CardTitle></CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="name">Program name</Label>
              <Input id="name" required minLength={2} value={name} onChange={(e) => setName(e.target.value)} placeholder="Founding Affiliates" />
            </div>
            <div className="space-y-2">
              <Label>Qualification trigger</Label>
              <Select value={trigger} onValueChange={(v) => setTrigger(v as "signup" | "transaction")}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="transaction">Transaction (earn on referred sales)</SelectItem>
                  <SelectItem value="signup">Sign Up (earn on referred sign-ups)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>Payout type</Label>
                <Select value={payoutType} onValueChange={(v) => setPayoutType(v as "percentage" | "fixed")}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="percentage">Percentage of GMV</SelectItem>
                    <SelectItem value="fixed">Fixed amount</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="pv">Payout value</Label>
                <Input id="pv" type="number" min={0} step="0.01" value={payoutValue} onChange={(e) => setPayoutValue(e.target.value)} />
              </div>
            </div>
            <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
              <div><div className="text-sm font-medium">Active</div><div className="text-xs text-muted-foreground">Program is live and accruing payouts</div></div>
              <Switch checked={active} onCheckedChange={setActive} />
            </div>
            <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
              <div><div className="text-sm font-medium">Auto-enroll</div><div className="text-xs text-muted-foreground">Enroll members as affiliates on first transaction</div></div>
              <Switch checked={autoEnroll} onCheckedChange={setAutoEnroll} />
            </div>
            {error && <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
            <div className="flex gap-2">
              <Button type="submit" disabled={saving}>{saving ? "Saving…" : "Save program"}</Button>
              <Button type="button" variant="outline" onClick={() => navigate({ to: "/app/affiliates/programs" })}>Cancel</Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

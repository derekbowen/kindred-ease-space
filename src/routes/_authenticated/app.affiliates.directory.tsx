import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { getMe } from "@/lib/auth.functions";
import { listAffiliates, createAffiliate, setAffiliateStatus, listPrograms } from "@/lib/affiliates.functions";

export const Route = createFileRoute("/_authenticated/app/affiliates/directory")({
  head: () => ({ meta: [{ title: "Affiliates — founders.click" }] }),
  component: AffiliatesPage,
});

function AffiliatesPage() {
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [newName, setNewName] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [newProgram, setNewProgram] = useState("");
  const qc = useQueryClient();
  const create = useServerFn(createAffiliate);
  const setStatus = useServerFn(setAffiliateStatus);

  useEffect(() => {
    getMe().then((me) => setWorkspaceId(me?.memberships?.[0]?.workspace_id ?? null)).catch(() => {});
  }, []);

  const programs = useQuery({
    queryKey: ["affiliate-programs", workspaceId],
    queryFn: () => listPrograms({ data: { workspaceId: workspaceId! } }),
    enabled: !!workspaceId,
  });
  const { data, isLoading } = useQuery({
    queryKey: ["affiliates", workspaceId, search],
    queryFn: () => listAffiliates({ data: { workspaceId: workspaceId!, search: search || undefined } }),
    enabled: !!workspaceId,
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ["affiliates", workspaceId] });

  const onCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!workspaceId || !newProgram) { toast.error("Pick a program first."); return; }
    try {
      await create({ data: { workspaceId, programId: newProgram, name: newName, email: newEmail } });
      setNewName(""); setNewEmail("");
      await refresh();
      toast.success("Affiliate created.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not create affiliate");
    }
  };

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Affiliates</h1>

      <Card>
        <CardHeader><CardTitle className="text-base">Add an affiliate</CardTitle></CardHeader>
        <CardContent>
          <form onSubmit={onCreate} className="grid gap-3 md:grid-cols-4 items-end">
            <div className="space-y-1"><Label>Name</Label><Input value={newName} onChange={(e) => setNewName(e.target.value)} required minLength={2} /></div>
            <div className="space-y-1"><Label>Email</Label><Input type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} required /></div>
            <div className="space-y-1">
              <Label>Program</Label>
              <Select value={newProgram} onValueChange={setNewProgram}>
                <SelectTrigger><SelectValue placeholder="Select program" /></SelectTrigger>
                <SelectContent>
                  {(programs.data?.programs ?? []).map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <Button type="submit">Create</Button>
          </form>
        </CardContent>
      </Card>

      <div className="max-w-xs"><Input placeholder="Search name or email…" value={search} onChange={(e) => setSearch(e.target.value)} /></div>

      {isLoading ? <Skeleton className="h-40" /> : (data?.affiliates ?? []).length === 0 ? (
        <Card><CardContent className="py-10 text-center text-sm text-muted-foreground">No affiliates yet.</CardContent></Card>
      ) : (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-left text-xs uppercase text-muted-foreground">
              <tr><th className="p-2">Name</th><th className="p-2">Program</th><th className="p-2">Link</th><th className="p-2">GMV</th><th className="p-2">Payouts</th><th className="p-2">Status</th><th className="p-2"></th></tr>
            </thead>
            <tbody>
              {data!.affiliates.map((a) => (
                <tr key={a.id} className="border-t border-border">
                  <td className="p-2"><div className="font-medium">{a.name}</div><div className="text-xs text-muted-foreground">{a.email}</div></td>
                  <td className="p-2">{a.program_name}</td>
                  <td className="p-2">
                    <button className="text-xs font-mono text-orange-500 hover:underline" onClick={() => { navigator.clipboard?.writeText(a.link); toast.success("Link copied"); }}>Copy link</button>
                  </td>
                  <td className="p-2 tabular-nums">{a.gmv.toFixed(2)}</td>
                  <td className="p-2 tabular-nums">{a.payouts_paid.toFixed(2)}</td>
                  <td className="p-2">{a.status === "active" ? <Badge className="bg-emerald-600">Active</Badge> : <Badge variant="secondary">Off</Badge>}</td>
                  <td className="p-2 text-right">
                    <Button variant="ghost" size="sm" onClick={async () => {
                      try { await setStatus({ data: { workspaceId: workspaceId!, id: a.id, status: a.status === "active" ? "deactivated" : "active" } }); await refresh(); }
                      catch (err) { toast.error(err instanceof Error ? err.message : "Failed"); }
                    }}>{a.status === "active" ? "Deactivate" : "Activate"}</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

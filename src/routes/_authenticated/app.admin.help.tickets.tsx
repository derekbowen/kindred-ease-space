import { useCallback, useEffect, useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import {
  ArrowLeft,
  Inbox,
  Mail,
  MessageSquare,
  Lock,
  Send,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  adminListTickets,
  adminGetTicket,
  adminUpdateTicket,
  adminPostTicketMessage,
} from "@/lib/help-tickets.functions";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/app/admin/help/tickets")({
  head: () => ({ meta: [{ title: "Help Tickets — Admin" }] }),
  component: AdminTicketsPage,
});

const STATUS_OPTIONS = ["open", "in_progress", "waiting", "resolved", "closed"] as const;
const PRIORITY_OPTIONS = ["low", "normal", "high", "urgent"] as const;

type Ticket = {
  id: string;
  email: string;
  name: string | null;
  subject: string;
  message: string;
  category: string | null;
  priority: string;
  status: string;
  assigned_to: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
};

type TicketMessage = {
  id: string;
  author_id: string | null;
  author_name: string | null;
  body: string;
  is_internal: boolean;
  status_change: string | null;
  created_at: string;
};

function statusVariant(s: string): "default" | "secondary" | "outline" | "destructive" {
  switch (s) {
    case "open":
      return "destructive";
    case "in_progress":
      return "default";
    case "waiting":
      return "secondary";
    case "resolved":
    case "closed":
      return "outline";
    default:
      return "secondary";
  }
}

function priorityTone(p: string): string {
  switch (p) {
    case "urgent":
      return "text-destructive";
    case "high":
      return "text-amber-600";
    case "low":
      return "text-muted-foreground";
    default:
      return "text-foreground";
  }
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  const now = Date.now();
  const diff = now - d.getTime();
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return d.toLocaleDateString();
}

function AdminTicketsPage() {
  const listFn = useServerFn(adminListTickets);
  const getFn = useServerFn(adminGetTicket);
  const updateFn = useServerFn(adminUpdateTicket);
  const postFn = useServerFn(adminPostTicketMessage);

  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [statusCounts, setStatusCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string>("open");
  const [priorityFilter, setPriorityFilter] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const refresh = useCallback(() => {
    setLoading(true);
    listFn({
      data: { status: statusFilter, priority: priorityFilter, q: query || null, limit: 100 },
    })
      .then((d) => {
        setTickets(d.tickets as Ticket[]);
        setStatusCounts(d.statusCounts);
        setForbidden(false);
        if (!selectedId && d.tickets.length > 0) {
          setSelectedId((d.tickets[0] as any).id);
        }
      })
      .catch((e) => {
        if (String(e?.message ?? e).includes("forbidden")) setForbidden(true);
        else toast.error("Failed to load tickets");
      })
      .finally(() => setLoading(false));
  }, [listFn, statusFilter, priorityFilter, query, selectedId]);

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter, priorityFilter]);

  if (forbidden) {
    return (
      <div className="mx-auto max-w-2xl p-8">
        <h1 className="text-xl font-semibold">Admins only</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          You need an admin role to view the ticket inbox.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1400px] space-y-4 p-4 md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link
            to="/app/admin/help/articles"
            className="mb-1 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-3 w-3" /> Back to help admin
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight">Help Desk Tickets</h1>
          <p className="text-sm text-muted-foreground">
            Triage, respond to, and resolve user-submitted support tickets.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={refresh} disabled={loading}>
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      <Card className="p-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex flex-wrap gap-1">
            <FilterPill
              label={`All (${Object.values(statusCounts).reduce((a, b) => a + b, 0)})`}
              active={statusFilter === "all"}
              onClick={() => setStatusFilter("all")}
            />
            {STATUS_OPTIONS.map((s) => (
              <FilterPill
                key={s}
                label={`${s.replace("_", " ")} (${statusCounts[s] ?? 0})`}
                active={statusFilter === s}
                onClick={() => setStatusFilter(s)}
              />
            ))}
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Select value={priorityFilter} onValueChange={setPriorityFilter}>
              <SelectTrigger className="w-[140px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All priorities</SelectItem>
                {PRIORITY_OPTIONS.map((p) => (
                  <SelectItem key={p} value={p} className="capitalize">
                    {p}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                refresh();
              }}
            >
              <Input
                placeholder="Search subject, email, message…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="w-[260px]"
              />
            </form>
          </div>
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[380px_1fr]">
        <Card className="overflow-hidden p-0">
          <div className="border-b px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {tickets.length} ticket{tickets.length === 1 ? "" : "s"}
          </div>
          <div className="max-h-[calc(100vh-260px)] overflow-y-auto">
            {loading && tickets.length === 0 ? (
              <div className="flex items-center justify-center p-8 text-sm text-muted-foreground">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…
              </div>
            ) : tickets.length === 0 ? (
              <div className="flex flex-col items-center gap-2 p-12 text-center text-sm text-muted-foreground">
                <Inbox className="h-8 w-8 opacity-50" />
                No tickets match the current filter.
              </div>
            ) : (
              <ul className="divide-y">
                {tickets.map((t) => (
                  <li key={t.id}>
                    <button
                      onClick={() => setSelectedId(t.id)}
                      className={`w-full px-3 py-3 text-left transition hover:bg-muted/50 ${
                        selectedId === t.id ? "bg-muted" : ""
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <span className="line-clamp-1 font-medium">{t.subject}</span>
                        <span className="shrink-0 text-[10px] text-muted-foreground">
                          {fmtDate(t.updated_at)}
                        </span>
                      </div>
                      <div className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">
                        {t.name ? `${t.name} · ` : ""}
                        {t.email}
                      </div>
                      <div className="mt-1.5 flex flex-wrap items-center gap-1">
                        <Badge variant={statusVariant(t.status)} className="text-[10px] capitalize">
                          {t.status.replace("_", " ")}
                        </Badge>
                        <span className={`text-[10px] capitalize ${priorityTone(t.priority)}`}>
                          {t.priority}
                        </span>
                        {t.category && (
                          <Badge variant="outline" className="text-[10px]">
                            {t.category}
                          </Badge>
                        )}
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>

        <div>
          {selectedId ? (
            <TicketDetail
              key={selectedId}
              id={selectedId}
              getFn={getFn}
              updateFn={updateFn}
              postFn={postFn}
              onChange={refresh}
            />
          ) : (
            <Card className="flex h-full min-h-[400px] flex-col items-center justify-center gap-2 p-12 text-center text-sm text-muted-foreground">
              <Mail className="h-8 w-8 opacity-50" />
              Select a ticket to view conversation.
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

function FilterPill({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-md px-2.5 py-1 text-xs font-medium capitalize transition ${
        active
          ? "bg-primary text-primary-foreground"
          : "bg-muted text-muted-foreground hover:bg-muted/70"
      }`}
    >
      {label}
    </button>
  );
}

function TicketDetail({
  id,
  getFn,
  updateFn,
  postFn,
  onChange,
}: {
  id: string;
  getFn: ReturnType<typeof useServerFn<typeof adminGetTicket>>;
  updateFn: ReturnType<typeof useServerFn<typeof adminUpdateTicket>>;
  postFn: ReturnType<typeof useServerFn<typeof adminPostTicketMessage>>;
  onChange: () => void;
}) {
  const [data, setData] = useState<{ ticket: Ticket | null; messages: TicketMessage[] } | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [reply, setReply] = useState("");
  const [internal, setInternal] = useState(false);
  const [posting, setPosting] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    getFn({ data: { id } })
      .then((d) => setData(d as any))
      .catch(() => toast.error("Failed to load ticket"))
      .finally(() => setLoading(false));
  }, [getFn, id]);

  useEffect(() => {
    load();
  }, [load]);

  const ticket = data?.ticket ?? null;
  const messages = data?.messages ?? [];

  const mailto = useMemo(() => {
    if (!ticket) return "";
    const subj = encodeURIComponent(`Re: ${ticket.subject}`);
    return `mailto:${ticket.email}?subject=${subj}`;
  }, [ticket]);

  async function changeStatus(status: string) {
    if (!ticket) return;
    try {
      await updateFn({ data: { id: ticket.id, status: status as any } });
      toast.success(`Status updated`);
      load();
      onChange();
    } catch {
      toast.error("Failed to update status");
    }
  }

  async function changePriority(priority: string) {
    if (!ticket) return;
    try {
      await updateFn({ data: { id: ticket.id, priority: priority as any } });
      toast.success(`Priority updated`);
      load();
      onChange();
    } catch {
      toast.error("Failed to update priority");
    }
  }

  async function submitReply(e: React.FormEvent) {
    e.preventDefault();
    if (!ticket || !reply.trim()) return;
    setPosting(true);
    try {
      await postFn({
        data: { ticket_id: ticket.id, body: reply.trim(), is_internal: internal },
      });
      setReply("");
      setInternal(false);
      toast.success(internal ? "Note added" : "Message logged");
      load();
      onChange();
    } catch {
      toast.error("Failed to post message");
    } finally {
      setPosting(false);
    }
  }

  if (loading && !data) {
    return (
      <Card className="flex h-full min-h-[400px] items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </Card>
    );
  }
  if (!ticket) {
    return <Card className="p-8 text-center text-sm text-muted-foreground">Ticket not found.</Card>;
  }

  return (
    <Card className="flex flex-col">
      <div className="border-b p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-semibold">{ticket.subject}</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              From{" "}
              <span className="font-medium text-foreground">{ticket.name ?? ticket.email}</span>{" "}
              &lt;{ticket.email}&gt; · {fmtDate(ticket.created_at)}
              {ticket.category && ` · ${ticket.category}`}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Select value={ticket.status} onValueChange={changeStatus}>
              <SelectTrigger className="w-[150px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STATUS_OPTIONS.map((s) => (
                  <SelectItem key={s} value={s} className="capitalize">
                    {s.replace("_", " ")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={ticket.priority} onValueChange={changePriority}>
              <SelectTrigger className="w-[120px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PRIORITY_OPTIONS.map((p) => (
                  <SelectItem key={p} value={p} className="capitalize">
                    {p}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button asChild variant="outline" size="sm">
              <a href={mailto}>
                <Mail className="h-4 w-4" /> Email reply
              </a>
            </Button>
          </div>
        </div>
      </div>

      <div className="max-h-[calc(100vh-440px)] space-y-3 overflow-y-auto p-4">
        <MessageBubble
          author={ticket.name ?? ticket.email}
          body={ticket.message}
          createdAt={ticket.created_at}
          fromUser
        />
        {messages.map((m) => (
          <MessageBubble
            key={m.id}
            author={m.author_name ?? "Staff"}
            body={m.body}
            createdAt={m.created_at}
            internal={m.is_internal}
            statusChange={!!m.status_change}
          />
        ))}
      </div>

      <form onSubmit={submitReply} className="border-t p-4">
        <Textarea
          placeholder={
            internal
              ? "Add an internal note (only staff can see this)…"
              : "Log your reply or a status update…"
          }
          value={reply}
          onChange={(e) => setReply(e.target.value)}
          rows={4}
          className="resize-none"
        />
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <label className="inline-flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={internal}
              onChange={(e) => setInternal(e.target.checked)}
              className="h-3.5 w-3.5"
            />
            <Lock className="h-3 w-3" /> Internal note
          </label>
          <Button type="submit" disabled={!reply.trim() || posting}>
            {posting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            {internal ? "Add note" : "Log message"}
          </Button>
        </div>
      </form>
    </Card>
  );
}

function MessageBubble({
  author,
  body,
  createdAt,
  fromUser = false,
  internal = false,
  statusChange = false,
}: {
  author: string;
  body: string;
  createdAt: string;
  fromUser?: boolean;
  internal?: boolean;
  statusChange?: boolean;
}) {
  if (statusChange) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <div className="h-px flex-1 bg-border" />
        <span>
          {author} · {body} · {fmtDate(createdAt)}
        </span>
        <div className="h-px flex-1 bg-border" />
      </div>
    );
  }
  return (
    <div
      className={`rounded-lg border p-3 ${
        internal
          ? "border-amber-300/60 bg-amber-50 dark:bg-amber-950/20"
          : fromUser
            ? "bg-muted/40"
            : "bg-background"
      }`}
    >
      <div className="mb-1 flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
          {fromUser ? <MessageSquare className="h-3 w-3" /> : null}
          {internal ? <Lock className="h-3 w-3 text-amber-600" /> : null}
          {author}
          {internal && <span className="text-amber-700 dark:text-amber-400">· internal</span>}
        </span>
        <span>{fmtDate(createdAt)}</span>
      </div>
      <p className="whitespace-pre-wrap text-sm leading-relaxed">{body}</p>
    </div>
  );
}

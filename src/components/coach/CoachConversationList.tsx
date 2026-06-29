import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Plus, MessageSquare, Pencil, Trash2, Search, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { createConversation, renameConversation, deleteConversation } from "@/lib/coach.functions";

export type ConversationListItem = {
  id: string;
  title: string | null;
  context_type: string | null;
  updated_at: string;
};

export function CoachConversationList({
  workspaceId,
  conversations,
  activeId,
  onSelect,
  loading,
}: {
  workspaceId: string;
  conversations: ConversationListItem[];
  activeId: string | null;
  onSelect: (id: string | null) => void;
  loading?: boolean;
}) {
  const qc = useQueryClient();
  const [filter, setFilter] = useState("");
  const [renaming, setRenaming] = useState<ConversationListItem | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleting, setDeleting] = useState<ConversationListItem | null>(null);

  const create = useMutation({
    mutationFn: () => createConversation({ data: { workspaceId } }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["coach-conversations", workspaceId] });
      onSelect(r.conversation!.id as string);
    },
    onError: (e) =>
      toast.error("Failed to create conversation", {
        description: e instanceof Error ? e.message : String(e),
      }),
  });

  const rename = useMutation({
    mutationFn: (vars: { conversationId: string; title: string }) =>
      renameConversation({ data: vars }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["coach-conversations", workspaceId] });
      setRenaming(null);
      toast.success("Renamed");
    },
    onError: (e) =>
      toast.error("Rename failed", { description: e instanceof Error ? e.message : String(e) }),
  });

  const remove = useMutation({
    mutationFn: (conversationId: string) => deleteConversation({ data: { conversationId } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["coach-conversations", workspaceId] });
      if (deleting && deleting.id === activeId) onSelect(null);
      setDeleting(null);
      toast.success("Conversation deleted");
    },
    onError: (e) =>
      toast.error("Delete failed", { description: e instanceof Error ? e.message : String(e) }),
  });

  const filtered = filter.trim()
    ? conversations.filter((c) =>
        (c.title ?? "Untitled").toLowerCase().includes(filter.toLowerCase()),
      )
    : conversations;

  return (
    <div className="flex flex-col h-full">
      <div className="p-3 border-b border-border space-y-2">
        <Button
          size="sm"
          className="w-full justify-start"
          onClick={() => create.mutate()}
          disabled={create.isPending}
        >
          {create.isPending ? (
            <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" />
          ) : (
            <Plus className="h-3.5 w-3.5 mr-2" />
          )}
          New conversation
        </Button>
        <div className="relative">
          <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter"
            className="h-8 pl-8 text-xs"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
        {loading && conversations.length === 0 ? (
          <p className="text-xs text-muted-foreground p-2">Loading…</p>
        ) : filtered.length === 0 ? (
          <p className="text-xs text-muted-foreground p-2">
            {conversations.length === 0 ? "No conversations yet." : "No matches."}
          </p>
        ) : (
          filtered.map((c) => (
            <ConversationRow
              key={c.id}
              conv={c}
              active={c.id === activeId}
              onSelect={() => onSelect(c.id)}
              onRename={() => {
                setRenameValue(c.title ?? "");
                setRenaming(c);
              }}
              onDelete={() => setDeleting(c)}
            />
          ))
        )}
      </div>

      {/* Rename dialog */}
      <AlertDialog
        open={!!renaming}
        onOpenChange={(o) => {
          if (!o) setRenaming(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Rename conversation</AlertDialogTitle>
            <AlertDialogDescription>
              Choose a name that helps you find this conversation later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Input
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            placeholder="Conversation title"
            autoFocus
          />
          <AlertDialogFooter>
            <AlertDialogCancel disabled={rename.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                if (renaming && renameValue.trim()) {
                  rename.mutate({ conversationId: renaming.id, title: renameValue.trim() });
                }
              }}
              disabled={rename.isPending || !renameValue.trim()}
            >
              {rename.isPending ? <Loader2 className="h-3 w-3 animate-spin mr-1.5" /> : null}
              Save
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete dialog */}
      <AlertDialog
        open={!!deleting}
        onOpenChange={(o) => {
          if (!o) setDeleting(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this conversation?</AlertDialogTitle>
            <AlertDialogDescription>
              "{deleting?.title ?? "Untitled"}" and all its messages will be permanently deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={remove.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                if (deleting) remove.mutate(deleting.id);
              }}
              disabled={remove.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {remove.isPending ? <Loader2 className="h-3 w-3 animate-spin mr-1.5" /> : null}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function ConversationRow({
  conv,
  active,
  onSelect,
  onRename,
  onDelete,
}: {
  conv: ConversationListItem;
  active: boolean;
  onSelect: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const updated = new Date(conv.updated_at);
  const ago = formatAgo(updated);
  return (
    <div
      className={cn(
        "group flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer text-sm",
        active
          ? "bg-primary/10 text-foreground"
          : "hover:bg-muted text-muted-foreground hover:text-foreground",
      )}
      onClick={onSelect}
    >
      <MessageSquare className="h-3.5 w-3.5 shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="truncate text-xs font-medium">{conv.title ?? "Untitled"}</div>
        <div className="text-[10px] text-muted-foreground">{ago}</div>
      </div>
      <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition">
        <button
          onClick={(e) => {
            e.stopPropagation();
            onRename();
          }}
          className="p-1 rounded hover:bg-background"
          aria-label="Rename"
        >
          <Pencil className="h-3 w-3" />
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          className="p-1 rounded hover:bg-background text-destructive"
          aria-label="Delete"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}

function formatAgo(d: Date): string {
  const s = Math.round((Date.now() - d.getTime()) / 1000);
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.round(h / 24);
  if (days < 30) return `${days}d ago`;
  return d.toLocaleDateString();
}

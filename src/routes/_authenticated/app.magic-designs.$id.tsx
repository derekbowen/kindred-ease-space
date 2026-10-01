/**
 * MAGIC DESIGNS — one design: live preview, generation status, Sharetribe-aware
 * change requests, history, and the developer-ready download.
 *
 * While a design is generating the page asks the server to refresh about once a
 * minute (the server itself never polls the engine more often than that).
 */
import { useCallback, useEffect, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { ArrowLeft, Download, Loader2, RefreshCw, Send } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { userMessage } from "@/lib/user-message";
import {
  CHANGE_PRESETS,
  DESIGN_TOKEN_COSTS,
  MAGIC_DESIGN_BASES,
  TRANSACTION_TYPES,
  type ChangePresetKey,
} from "@/lib/magic-designs";
import {
  downloadMagicDesign,
  getMagicDesign,
  refreshMagicDesign,
  requestMagicDesignChange,
} from "@/lib/magic-designs.functions";

export const Route = createFileRoute("/_authenticated/app/magic-designs/$id")({
  head: () => ({ meta: [{ title: "Magic Design — founders.click" }] }),
  component: MagicDesignPage,
});

type Loaded = Awaited<ReturnType<typeof getMagicDesign>>;

const POLL_MS = 60_000;

function MagicDesignPage() {
  const { id } = Route.useParams();
  const load = useServerFn(getMagicDesign);
  const poll = useServerFn(refreshMagicDesign);
  const change = useServerFn(requestMagicDesignChange);
  const download = useServerFn(downloadMagicDesign);
  const [state, setState] = useState<Loaded | null>(null);
  const [preset, setPreset] = useState<ChangePresetKey | null>(null);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [previewKey, setPreviewKey] = useState(0);

  const reload = useCallback(async () => {
    try {
      setState(await load({ data: { id } }));
    } catch (e) {
      toast.error(userMessage(e, "Couldn't load this design."));
    }
  }, [id, load]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const status = state?.design.status;
  useEffect(() => {
    if (status !== "generating") return;
    const timer = setInterval(async () => {
      try {
        const r = await poll({ data: { id } });
        if (r.status !== "generating") {
          await reload();
          setPreviewKey((k) => k + 1);
          if (r.status === "ready") toast.success("Your design is ready.");
        }
      } catch {
        // keep polling; a transient failure is not worth a toast
      }
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [status, id, poll, reload]);

  async function sendChange() {
    setSending(true);
    try {
      await change({ data: { id, change: text, preset } });
      toast.success("Change requested. The design will update in a few minutes.");
      setText("");
      setPreset(null);
      await reload();
    } catch (e) {
      toast.error(userMessage(e, "Couldn't request that change. Your tokens were not used."));
    } finally {
      setSending(false);
    }
  }

  async function saveZip() {
    setDownloading(true);
    try {
      const { fileName, base64 } = await download({ data: { id } });
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: "application/zip" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) {
      toast.error(userMessage(e, "Couldn't prepare the download. Try again in a moment."));
    } finally {
      setDownloading(false);
    }
  }

  if (!state) {
    return (
      <div className="flex items-center gap-2 p-6 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading design…
      </div>
    );
  }

  const { design, requests, balance } = state;
  const base = MAGIC_DESIGN_BASES.find((b) => b.slug === design.base_template);
  const tx = TRANSACTION_TYPES[design.brief.transactionType];
  const generating = design.status === "generating";
  const canChange =
    !generating && design.status !== "failed" && balance >= DESIGN_TOKEN_COSTS.change;

  return (
    <div className="mx-auto max-w-7xl space-y-6 p-6">
      <Link
        to="/app/magic-designs"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" /> All designs
      </Link>

      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{design.name}</h1>
          <p className="text-sm text-muted-foreground">
            Started from {base?.name ?? design.base_template} · {tx.label}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {generating ? (
            <Badge variant="secondary" className="gap-1">
              <Loader2 className="h-3 w-3 animate-spin" /> Generating — usually 2–10 minutes
            </Badge>
          ) : design.status === "failed" ? (
            <Badge variant="destructive">Generation failed</Badge>
          ) : (
            <Badge>Ready</Badge>
          )}
          <Button
            onClick={() => void saveZip()}
            disabled={generating || design.status !== "ready" || downloading}
          >
            {downloading ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Download className="mr-2 h-4 w-4" />
            )}
            Download for your developer
          </Button>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <Card className="overflow-hidden">
          <div className="flex items-center justify-between border-b border-border bg-muted/50 px-4 py-2 text-xs text-muted-foreground">
            <span>Live preview — click around, every page works</span>
            <button
              type="button"
              className="inline-flex items-center gap-1 hover:text-foreground"
              onClick={() => setPreviewKey((k) => k + 1)}
            >
              <RefreshCw className="h-3 w-3" /> Reload
            </button>
          </div>
          {design.preview_url && !generating ? (
            <iframe
              key={previewKey}
              src={design.preview_url}
              title={`${design.name} preview`}
              className="h-[75vh] min-h-[520px] w-full border-0 bg-white"
            />
          ) : (
            <div className="flex h-[75vh] min-h-[520px] flex-col items-center justify-center gap-3 text-center text-muted-foreground">
              {design.status === "failed" ? (
                <p>This design couldn't be generated. Contact support and we'll make it right.</p>
              ) : (
                <>
                  <Loader2 className="h-8 w-8 animate-spin" />
                  <p>Building {design.name}… this page updates by itself.</p>
                </>
              )}
            </div>
          )}
        </Card>

        <div className="space-y-6">
          <Card className="space-y-4 p-5">
            <div>
              <h2 className="font-semibold">Request a change</h2>
              <p className="text-xs text-muted-foreground">
                {DESIGN_TOKEN_COSTS.change} tokens each · you have {balance}. Changes stay within
                what the Sharetribe Web Template supports.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {CHANGE_PRESETS.map((p) => (
                <button
                  type="button"
                  key={p.key}
                  onClick={() => setPreset(preset === p.key ? null : p.key)}
                  className={`rounded-full border px-3 py-1 text-xs transition ${
                    preset === p.key
                      ? "border-brand bg-brand/10 text-foreground"
                      : "border-border text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <Textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={4}
              maxLength={1500}
              placeholder="Describe a change, e.g. 'Make the hero darker and add a testimonials section to the landing page'"
            />
            <Button
              className="w-full"
              onClick={() => void sendChange()}
              disabled={!canChange || sending || (!preset && text.trim().length < 3)}
            >
              {sending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Send className="mr-2 h-4 w-4" />
              )}
              Apply change · {DESIGN_TOKEN_COSTS.change} tokens
            </Button>
            {balance < DESIGN_TOKEN_COSTS.change ? (
              <p className="text-xs text-muted-foreground">
                Out of tokens?{" "}
                <Link to="/app/magic-designs" className="underline">
                  Buy a pack
                </Link>
                .
              </p>
            ) : null}
          </Card>

          <Card className="p-5">
            <h2 className="font-semibold">History</h2>
            <ol className="mt-3 space-y-3 text-sm">
              {requests.map(
                (r: {
                  id: string;
                  kind: string;
                  summary: string;
                  tokens: number;
                  created_at: string;
                }) => (
                  <li key={r.id} className="border-l-2 border-border pl-3">
                    <div className="font-medium">{r.kind === "create" ? "Created" : "Change"}</div>
                    <div className="text-muted-foreground">{r.summary}</div>
                    <div className="text-xs text-muted-foreground">
                      {new Date(r.created_at).toLocaleString()} · {r.tokens} tokens
                    </div>
                  </li>
                ),
              )}
            </ol>
          </Card>

          <Card className="p-5 text-sm">
            <h2 className="font-semibold">What your developer gets</h2>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-muted-foreground">
              <li>A standalone React + Tailwind project (npm install, npm run dev)</li>
              <li>Every page mapped to its Sharetribe Web Template page</li>
              <li>SHARETRIBE_SETUP.md with the Console settings this design needs</li>
              <li>All images included, brand in one theme file</li>
            </ul>
          </Card>
        </div>
      </div>
    </div>
  );
}

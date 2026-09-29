import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { AlertTriangle, PauseCircle } from "lucide-react";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { getAvailableAiModels } from "@/lib/ai-models.functions";
import { userMessage } from "@/lib/user-message";
import { modelOptions, pickModelTier } from "./model-choice";

export const AI_MODELS_LOAD_FAILED =
  "Couldn't load the AI models for this workspace. Refresh the page to try again.";
/** Shown if the server's own sentence is ever missing or not customer-safe. */
export const AI_NOT_CONFIGURED_FALLBACK =
  "AI isn't available for this workspace right now. Contact support.";
export const AI_PAUSED_FALLBACK = "AI features are paused right now. Try again later.";


/**
 * The AI model picker shared by the Quick Page Builder and Generate Content.
 * Everything it lists comes from getAvailableAiModels: options grouped under
 * their provider, the default (or the only option) selected automatically, a
 * plain "what to set up, and where" notice when no AI is configured, and the
 * platform notice while AI is paused. `value` is the chosen option's tier; it
 * reads "" whenever nothing usable is offered, so callers keep Generate
 * disabled on `!value`.
 */
export function AiModelSelect({
  workspaceId,
  value,
  onChange,
  disabled,
  id = "ai-model",
}: {
  workspaceId: string | null;
  value: string;
  onChange: (tier: string) => void;
  disabled?: boolean;
  id?: string;
}) {
  const fetchModels = useServerFn(getAvailableAiModels);
  const { data, error, isLoading } = useQuery({
    queryKey: ["ai-models", workspaceId],
    queryFn: () => fetchModels({ data: { workspaceId: workspaceId! } }),
    enabled: !!workspaceId,
    staleTime: 60_000,
  });

  const next = pickModelTier(data, value);
  useEffect(() => {
    if (next !== value) onChange(next);
  }, [next, value, onChange]);

  const options = modelOptions(data);
  const chosen = options.find((o) => o.tier === value);

  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>AI model</Label>
      {error ? (
        <p className="rounded-md border border-destructive/30 bg-destructive/10 p-2 text-xs text-destructive">
          {userMessage(error, AI_MODELS_LOAD_FAILED)}
        </p>
      ) : data?.state === "none_configured" ? (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
          <p className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
            {userMessage(data.message, AI_NOT_CONFIGURED_FALLBACK)}
          </p>
        </div>
      ) : data?.state === "platform_paused" ? (
        <p className="flex items-start gap-2 rounded-md border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
          <PauseCircle className="mt-0.5 h-4 w-4 shrink-0" />
          {userMessage(data.message, AI_PAUSED_FALLBACK)}
        </p>
      ) : (
        <>
          <Select
            value={value}
            onValueChange={onChange}
            disabled={disabled || !workspaceId || isLoading || options.length === 0}
          >
            <SelectTrigger id={id}>
              <SelectValue placeholder={isLoading || !data ? "Loading…" : "Choose a model"} />
            </SelectTrigger>
            <SelectContent>
              {(data?.providers ?? []).map((p) => (
                <SelectGroup key={`${p.provider}-${p.source}`}>
                  <SelectLabel>
                    {p.source === "byok" ? `${p.label} · this workspace's own key` : p.label}
                  </SelectLabel>
                  {p.models.map((m) => (
                    <SelectItem key={m.tier} value={m.tier}>
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              ))}
            </SelectContent>
          </Select>
          {chosen && <p className="text-xs text-muted-foreground">{chosen.hint}</p>}
        </>
      )}
    </div>
  );
}

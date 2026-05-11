import { useState } from "react";
import { ThumbsUp, ThumbsDown, Check } from "lucide-react";
import { useServerFn } from "@tanstack/react-start";
import { submitArticleFeedback } from "@/lib/help.functions";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

export function HelpfulFeedback({ articleId }: { articleId: string }) {
  const [state, setState] = useState<"idle" | "yes" | "no" | "done">("idle");
  const [comment, setComment] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const submit = useServerFn(submitArticleFeedback);

  async function send(isHelpful: boolean, withComment = false) {
    setSubmitting(true);
    try {
      await submit({ data: { articleId, isHelpful, comment: withComment ? comment : null } });
      setState("done");
    } finally {
      setSubmitting(false);
    }
  }

  if (state === "done") {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-6 border-t border-border mt-12">
        <Check className="h-4 w-4 text-green-500" /> Thanks for the feedback!
      </div>
    );
  }

  return (
    <div className="border-t border-border mt-12 pt-6">
      <div className="flex items-center gap-3">
        <span className="text-sm font-medium">Was this helpful?</span>
        <button
          onClick={() => { setState("yes"); send(true); }}
          disabled={submitting}
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm hover:border-orange-500 hover:text-orange-500 transition-colors"
        >
          <ThumbsUp className="h-3.5 w-3.5" /> Yes
        </button>
        <button
          onClick={() => setState("no")}
          disabled={submitting}
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm hover:border-orange-500 hover:text-orange-500 transition-colors"
        >
          <ThumbsDown className="h-3.5 w-3.5" /> No
        </button>
      </div>
      {state === "no" && (
        <div className="mt-4 space-y-2 max-w-md">
          <Textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="What was missing or unclear? (optional)"
            rows={3}
            maxLength={1000}
          />
          <Button onClick={() => send(false, true)} disabled={submitting} size="sm">
            Submit feedback
          </Button>
        </div>
      )}
    </div>
  );
}

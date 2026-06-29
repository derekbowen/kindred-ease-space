import { AlertCircle } from "lucide-react";

export function OwnerOnlyBanner({ isOwner }: { isOwner: boolean }) {
  if (isOwner) return null;
  return (
    <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-400">
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
      <p>
        View-only — only the workspace <strong>owner</strong> can change these settings. Ask your
        owner to update them or transfer ownership.
      </p>
    </div>
  );
}
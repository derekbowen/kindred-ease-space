import { useCallback, useEffect, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Package, Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/integrations/supabase/client";
import { userMessage } from "@/lib/user-message";
import { STORE_TEMPLATES, formatTemplatePrice } from "@/lib/template-store";

/**
 * Upload the paid zip for each Sharetribe template.
 *
 * Files go straight from the browser to the PRIVATE `template-downloads`
 * bucket under the admin's own session; storage RLS admits platform admins
 * only (migration 20261001000100). template-checkout refuses to sell a
 * template until its `<slug>.zip` exists here.
 */
export const Route = createFileRoute("/_authenticated/app/admin/template-store")({
  head: () => ({ meta: [{ title: "Template Store — Admin" }] }),
  component: TemplateStoreAdmin,
});

const BUCKET = "template-downloads";

type FileInfo = { size: number; updatedAt: string | null };

function TemplateStoreAdmin() {
  const [files, setFiles] = useState<Record<string, FileInfo> | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [uploading, setUploading] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const { data, error } = await supabase.storage.from(BUCKET).list("", { limit: 1000 });
    if (error) {
      setListError(userMessage(error, "Couldn't list the uploaded zips. Try again in a moment."));
      return;
    }
    setListError(null);
    const map: Record<string, FileInfo> = {};
    for (const f of data ?? []) {
      map[f.name] = {
        size: Number((f.metadata as { size?: number } | null)?.size ?? 0),
        updatedAt: f.updated_at ?? null,
      };
    }
    setFiles(map);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function upload(slug: string, file: File) {
    if (!file.name.toLowerCase().endsWith(".zip")) {
      toast.error("Choose a .zip file.");
      return;
    }
    setUploading(slug);
    const { error } = await supabase.storage.from(BUCKET).upload(`${slug}.zip`, file, {
      upsert: true,
      contentType: "application/zip",
    });
    setUploading(null);
    if (error) {
      toast.error(userMessage(error, "Upload failed. Try again in a moment."));
      return;
    }
    toast.success(`Uploaded ${slug}.zip`);
    void refresh();
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <Package className="h-6 w-6" /> Template store
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Upload each template's download zip. A template can be bought on{" "}
          <Link to="/sharetribe-templates" className="underline">
            /sharetribe-templates
          </Link>{" "}
          only once its zip is here. Prices live in{" "}
          <code>supabase/functions/_shared/template-catalog.ts</code>.
        </p>
      </div>

      {listError ? (
        <Card className="border-destructive p-4 text-sm text-destructive">{listError}</Card>
      ) : null}

      <div className="space-y-3">
        {STORE_TEMPLATES.map((t) => {
          const info = files?.[`${t.slug}.zip`];
          return (
            <Card key={t.slug} className="flex flex-wrap items-center gap-4 p-4">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-semibold">{t.name}</span>
                  <span className="text-sm text-muted-foreground">
                    {formatTemplatePrice(t.priceCents)}
                  </span>
                  {files === null ? null : info ? (
                    <Badge variant="secondary">On sale</Badge>
                  ) : (
                    <Badge variant="outline">No zip — not for sale</Badge>
                  )}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {info
                    ? `${t.slug}.zip · ${(info.size / 1024 / 1024).toFixed(1)} MB${
                        info.updatedAt
                          ? ` · updated ${new Date(info.updatedAt).toLocaleString()}`
                          : ""
                      }`
                    : `Expects ${t.slug}.zip`}
                </p>
              </div>
              <label>
                <input
                  type="file"
                  accept=".zip,application/zip"
                  className="sr-only"
                  disabled={uploading !== null}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    e.target.value = "";
                    if (f) void upload(t.slug, f);
                  }}
                />
                <Button asChild variant="outline" size="sm" disabled={uploading !== null}>
                  <span className="cursor-pointer">
                    <Upload className="mr-1.5 h-4 w-4" />
                    {uploading === t.slug ? "Uploading…" : info ? "Replace zip" : "Upload zip"}
                  </span>
                </Button>
              </label>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

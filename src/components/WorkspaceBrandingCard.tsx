import { useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";
import { updateWorkspaceBranding } from "@/lib/workspace.functions";

interface Props {
  workspaceId: string;
  initial: {
    brand_name: string | null;
    brand_color: string | null;
    logo_url: string | null;
  };
  onSaved?: () => void;
}

export function WorkspaceBrandingCard({ workspaceId, initial, onSaved }: Props) {
  const update = useServerFn(updateWorkspaceBranding);
  const fileRef = useRef<HTMLInputElement>(null);
  const [brandName, setBrandName] = useState(initial.brand_name ?? "");
  const [brandColor, setBrandColor] = useState(initial.brand_color ?? "#f97316");
  const [logoUrl, setLogoUrl] = useState(initial.logo_url ?? "");
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);

  const onPickFile = () => fileRef.current?.click();

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!/^image\/(png|jpeg|webp|svg\+xml)$/.test(file.type)) {
      toast.error("Use PNG, JPG, WEBP or SVG");
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      toast.error("Logo must be under 2 MB");
      return;
    }
    setUploading(true);
    try {
      const ext = file.name.split(".").pop() || "png";
      const path = `${workspaceId}/logo-${Date.now()}.${ext}`;
      const { error } = await supabase.storage
        .from("workspace-logos")
        .upload(path, file, { upsert: true, contentType: file.type });
      if (error) throw error;
      const { data: pub } = supabase.storage.from("workspace-logos").getPublicUrl(path);
      setLogoUrl(pub.publicUrl);
      toast.success("Logo uploaded — click Save to apply.");
    } catch (err) {
      console.error(err);
      toast.error("Upload failed. Make sure you're the workspace owner.");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const onSave = async () => {
    setSaving(true);
    try {
      await update({
        data: {
          workspaceId,
          brandName: brandName.trim() || null,
          brandColor: brandColor || null,
          logoUrl: logoUrl || null,
        },
      });
      toast.success("Branding updated");
      onSaved?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Branding</CardTitle>
        <CardDescription>Your logo, name and accent color appear in the admin sidebar and outbound emails — so the product feels like yours.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="flex items-center gap-4">
          <div
            className="h-16 w-16 rounded-lg border border-border flex items-center justify-center overflow-hidden bg-muted"
            style={{ background: logoUrl ? undefined : brandColor }}
          >
            {logoUrl ? (
              <img src={logoUrl} alt="Workspace logo" className="h-full w-full object-contain" />
            ) : (
              <span className="text-white font-bold text-xl">
                {(brandName || "W").slice(0, 1).toUpperCase()}
              </span>
            )}
          </div>
          <div className="flex flex-col gap-2">
            <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" hidden onChange={onFile} />
            <Button type="button" variant="outline" size="sm" onClick={onPickFile} disabled={uploading}>
              {uploading ? "Uploading…" : "Upload logo"}
            </Button>
            {logoUrl && (
              <Button type="button" variant="ghost" size="sm" onClick={() => setLogoUrl("")}>
                Remove logo
              </Button>
            )}
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="brand-name">Brand name</Label>
          <Input id="brand-name" value={brandName} onChange={(e) => setBrandName(e.target.value)} placeholder="e.g. Pool Rental Near Me" maxLength={60} />
        </div>

        <div className="space-y-2">
          <Label htmlFor="brand-color">Accent color</Label>
          <div className="flex items-center gap-3">
            <input
              id="brand-color"
              type="color"
              value={brandColor}
              onChange={(e) => setBrandColor(e.target.value)}
              className="h-10 w-14 rounded border border-border bg-transparent cursor-pointer"
            />
            <Input value={brandColor} onChange={(e) => setBrandColor(e.target.value)} className="max-w-[140px] font-mono" />
          </div>
        </div>

        <Button onClick={onSave} disabled={saving}>
          {saving ? "Saving…" : "Save branding"}
        </Button>
      </CardContent>
    </Card>
  );
}

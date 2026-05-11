import * as React from "react";
import { createServerFn } from "@tanstack/react-start";
import { render } from "@react-email/components";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { SignupEmail } from "@/lib/email-templates/signup";
import { InviteEmail } from "@/lib/email-templates/invite";
import { MagicLinkEmail } from "@/lib/email-templates/magic-link";
import { RecoveryEmail } from "@/lib/email-templates/recovery";
import { EmailChangeEmail } from "@/lib/email-templates/email-change";
import { ReauthenticationEmail } from "@/lib/email-templates/reauthentication";

export type EmailBranding = {
  site_name: string;
  sender_name: string;
  logo_url: string | null;
  primary_color: string;
  primary_text_color: string;
  footer_text: string | null;
};

export const DEFAULT_BRANDING: EmailBranding = {
  site_name: "fresh-web",
  sender_name: "fresh-web",
  logo_url: null,
  primary_color: "#000000",
  primary_text_color: "#ffffff",
  footer_text: null,
};

export async function loadEmailBranding(): Promise<EmailBranding> {
  const { data, error } = await supabaseAdmin
    .from("email_branding" as any)
    .select("site_name, sender_name, logo_url, primary_color, primary_text_color, footer_text")
    .eq("id", 1)
    .maybeSingle();
  if (error || !data) return DEFAULT_BRANDING;
  return { ...DEFAULT_BRANDING, ...(data as any) };
}

async function assertAdmin(userId: string) {
  const { data } = await supabaseAdmin
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", "admin")
    .maybeSingle();
  if (!data) throw new Error("Forbidden");
}

export const getEmailBranding = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { userId } = context as { userId: string };
    await assertAdmin(userId);
    return loadEmailBranding();
  });

const HexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Must be a 6-digit hex color");

const UpdateSchema = z.object({
  site_name: z.string().min(1).max(120),
  sender_name: z.string().min(1).max(120),
  logo_url: z.string().url().max(500).nullable().or(z.literal("").transform(() => null)),
  primary_color: HexColor,
  primary_text_color: HexColor,
  footer_text: z.string().max(500).nullable().or(z.literal("").transform(() => null)),
});

export const updateEmailBranding = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) => UpdateSchema.parse(data))
  .handler(async ({ context, data }) => {
    const { userId } = context as { userId: string };
    await assertAdmin(userId);
    const { error } = await supabaseAdmin
      .from("email_branding" as any)
      .upsert({ id: 1, ...data });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

const TEMPLATES: Record<string, React.ComponentType<any>> = {
  signup: SignupEmail,
  invite: InviteEmail,
  magiclink: MagicLinkEmail,
  recovery: RecoveryEmail,
  email_change: EmailChangeEmail,
  reauthentication: ReauthenticationEmail,
};

const SAMPLE_URL = "https://example.com";
const SAMPLE_EMAIL = "user@example.test";

function sampleProps(type: string) {
  switch (type) {
    case "signup":
      return { siteUrl: SAMPLE_URL, recipient: SAMPLE_EMAIL, confirmationUrl: SAMPLE_URL };
    case "invite":
      return { siteUrl: SAMPLE_URL, confirmationUrl: SAMPLE_URL };
    case "magiclink":
    case "recovery":
      return { confirmationUrl: SAMPLE_URL };
    case "email_change":
      return { oldEmail: SAMPLE_EMAIL, email: SAMPLE_EMAIL, newEmail: "new@example.test", confirmationUrl: SAMPLE_URL };
    case "reauthentication":
      return { token: "123456" };
    default:
      return {};
  }
}

export const previewAuthEmail = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) => z.object({ type: z.string() }).parse(data))
  .handler(async ({ context, data }) => {
    const { userId } = context as { userId: string };
    await assertAdmin(userId);
    const Template = TEMPLATES[data.type];
    if (!Template) throw new Error(`Unknown email type: ${data.type}`);
    const row = await loadEmailBranding();
    const branding = {
      siteName: row.site_name,
      senderName: row.sender_name,
      logoUrl: row.logo_url,
      primaryColor: row.primary_color,
      primaryTextColor: row.primary_text_color,
      footerText: row.footer_text,
    };
    const props = { ...sampleProps(data.type), siteName: branding.siteName, branding };
    const html = await render(React.createElement(Template, props));
    return { html };
  });

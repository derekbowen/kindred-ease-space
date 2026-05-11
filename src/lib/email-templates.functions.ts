import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

async function assertAdmin(supabase: any, userId: string) {
  const { data, error } = await supabase.rpc("has_role", {
    _user_id: userId,
    _role: "admin",
  });
  if (error || !data) throw new Error("forbidden");
}

export const listEmailTemplates = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context.supabase, context.userId);
    const { TEMPLATE_DEFINITIONS } = await import("./email.server");
    const { data, error } = await supabaseAdmin
      .from("email_templates")
      .select("key,subject,html,text,is_enabled,updated_at,updated_by");
    if (error) throw error;
    const overrides = new Map((data ?? []).map((r: any) => [r.key, r]));
    return {
      templates: TEMPLATE_DEFINITIONS.map((def) => {
        const o: any = overrides.get(def.key) ?? null;
        return {
          key: def.key,
          name: def.name,
          description: def.description,
          category: def.category,
          placeholders: def.placeholders,
          defaultSubject: def.defaultSubject,
          defaultHtml: def.defaultHtml,
          defaultText: def.defaultText,
          subject: o?.subject ?? null,
          html: o?.html ?? null,
          text: o?.text ?? null,
          isEnabled: o?.is_enabled ?? true,
          isCustomized: !!o,
          updatedAt: o?.updated_at ?? null,
        };
      }),
    };
  });

export const saveEmailTemplate = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        key: z.string().min(1).max(80),
        subject: z.string().min(1).max(300),
        html: z.string().min(1).max(50000),
        text: z.string().max(50000).optional().nullable(),
        isEnabled: z.boolean().default(true),
      })
      .parse(d)
  )
  .handler(async ({ context, data }) => {
    await assertAdmin(context.supabase, context.userId);
    const { TEMPLATE_DEFINITIONS, clearEmailTemplateCache } = await import("./email.server");
    const def = TEMPLATE_DEFINITIONS.find((t) => t.key === data.key);
    if (!def) throw new Error("Unknown template");
    const { error } = await supabaseAdmin
      .from("email_templates")
      .upsert(
        {
          key: data.key,
          name: def.name,
          description: def.description,
          subject: data.subject,
          html: data.html,
          text: data.text ?? null,
          placeholders: def.placeholders.map((p) => p.name),
          is_enabled: data.isEnabled,
          updated_by: context.userId,
        },
        { onConflict: "key" }
      );
    if (error) throw error;
    clearEmailTemplateCache(data.key);
    return { ok: true };
  });

export const resetEmailTemplate = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { key: string }) => z.object({ key: z.string().min(1) }).parse(d))
  .handler(async ({ context, data }) => {
    await assertAdmin(context.supabase, context.userId);
    const { clearEmailTemplateCache } = await import("./email.server");
    const { error } = await supabaseAdmin
      .from("email_templates")
      .delete()
      .eq("key", data.key);
    if (error) throw error;
    clearEmailTemplateCache(data.key);
    return { ok: true };
  });

export const sendTestEmailTemplate = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        key: z.string().min(1),
        to: z.string().email(),
        subject: z.string().min(1),
        html: z.string().min(1),
        text: z.string().optional().nullable(),
      })
      .parse(d)
  )
  .handler(async ({ context, data }) => {
    await assertAdmin(context.supabase, context.userId);
    const { sendEmail, getTemplateDefinition, renderTemplatePreview } = await import(
      "./email.server"
    );
    const def = getTemplateDefinition(data.key);
    if (!def) throw new Error("Unknown template");
    const sampleVars = Object.fromEntries(def.placeholders.map((p) => [p.name, p.sample]));
    const rendered = renderTemplatePreview(
      def,
      { subject: data.subject, html: data.html, text: data.text },
      sampleVars
    );
    const res = await sendEmail({
      to: data.to,
      subject: `[Test] ${rendered.subject}`,
      html: rendered.html,
      text: rendered.text,
      meta: { kind: "template_test", template_key: data.key },
    });
    if (!res.ok) throw new Error(res.error || "send failed");
    return { ok: true };
  });

// Send a follow-up to a help feedback submitter.
export const sendHelpFeedbackFollowUp = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        feedbackId: z.string().uuid().optional().nullable(),
        articleId: z.string().uuid(),
        recipientEmail: z.string().email(),
        recipientName: z.string().max(120).optional().nullable(),
        comment: z.string().max(4000).optional().nullable(),
      })
      .parse(d)
  )
  .handler(async ({ context, data }) => {
    await assertAdmin(context.supabase, context.userId);
    const { sendEmail, helpFeedbackFollowUpTemplate, SUPPORT_INBOX_EMAIL } = await import(
      "./email.server"
    );
    const { data: art } = await supabaseAdmin
      .from("help_articles")
      .select("title,slug")
      .eq("id", data.articleId)
      .maybeSingle();
    if (!art) throw new Error("Article not found");
    const origin = process.env.PUBLIC_APP_URL || "https://founders.click";
    const articleUrl = `${origin}/help/${(art as any).slug}`;
    const tpl = await helpFeedbackFollowUpTemplate({
      name: data.recipientName,
      articleTitle: (art as any).title,
      articleUrl,
      comment: data.comment,
    });
    if (!tpl) return { ok: false, skipped: true };
    const res = await sendEmail({
      to: data.recipientEmail,
      subject: tpl.subject,
      html: tpl.html,
      text: tpl.text,
      replyTo: SUPPORT_INBOX_EMAIL,
      idempotencyKey: data.feedbackId ? `feedback-followup-${data.feedbackId}` : undefined,
      meta: { kind: "help_feedback_followup", article_id: data.articleId },
    });
    if (!res.ok) throw new Error(res.error || "send failed");
    return { ok: true };
  });

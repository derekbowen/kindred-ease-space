/**
 * MAGIC DESIGNS — server functions.
 *
 * Money rules, the same as the rest of billing here:
 *   - Every write uses the service role; clients can only read their own rows
 *     (migration 20261001000200).
 *   - Tokens are spent through spend_design_tokens(), which locks per user and
 *     is idempotent on (reason, ref): a design's create charge is keyed by the
 *     design id, a change's by the request id.
 *   - Tokens are spent BEFORE the engine is asked to work and refunded (one
 *     'refund' ledger row with the same ref) if the engine refuses the job, so
 *     a failure never costs the customer and a success is never free.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { CustomerFacingError } from "@/lib/ai/customer-error";
import {
  BRIEF_LIMITS,
  CHANGE_PRESETS,
  DESIGN_TOKEN_COSTS,
  MAGIC_DESIGN_BASES,
  TRANSACTION_TYPES,
  buildChangePrompt,
  buildCreatePrompt,
  type MagicDesignBrief,
} from "@/lib/magic-designs";
import {
  BASE_DESIGN_IDS,
  DesignEngineError,
  DesignEngineUnavailable,
  createEngineDesign,
  getEngineStatus,
  readEngineFiles,
  sendEnginePrompt,
} from "@/lib/magic-designs/provider.server";
import { buildDesignPackage } from "@/lib/magic-designs/package.server";

const sb = () => supabaseAdmin as any;

/** The engine asks for status polls no more than once a minute. */
const MIN_POLL_MS = 55_000;

const briefSchema = z.object({
  marketplaceName: z.string().trim().min(2).max(BRIEF_LIMITS.short),
  whatIsListed: z.string().trim().min(3).max(BRIEF_LIMITS.medium),
  providers: z.string().trim().min(2).max(BRIEF_LIMITS.medium),
  customers: z.string().trim().min(2).max(BRIEF_LIMITS.medium),
  transactionType: z.enum(Object.keys(TRANSACTION_TYPES) as [keyof typeof TRANSACTION_TYPES]),
  multipleSeats: z.boolean(),
  priceVariations: z.boolean(),
  searchLayout: z.enum(["map", "grid"]),
  listingLayout: z.enum(["carousel", "coverPhoto"]),
  brandColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  vibe: z.string().trim().max(BRIEF_LIMITS.medium),
  listingFields: z.string().trim().max(BRIEF_LIMITS.medium),
  notes: z.string().trim().max(BRIEF_LIMITS.long),
}) satisfies z.ZodType<MagicDesignBrief>;

export type MagicDesignRow = {
  id: string;
  name: string;
  base_template: string;
  brief: MagicDesignBrief;
  preview_url: string | null;
  status: "generating" | "ready" | "failed";
  created_at: string;
  updated_at: string;
};

async function balanceOf(userId: string): Promise<number> {
  const { data, error } = await sb().rpc("design_token_balance", { _user_id: userId });
  if (error) throw new Error(`balance read failed: ${error.message}`);
  return Number(data ?? 0);
}

async function spend(
  userId: string,
  amount: number,
  reason: "design_create" | "design_change",
  ref: string,
) {
  const { data, error } = await sb().rpc("spend_design_tokens", {
    _user_id: userId,
    _amount: amount,
    _reason: reason,
    _ref: ref,
  });
  if (error) throw new Error(`token spend failed: ${error.message}`);
  if (data !== true) {
    throw new CustomerFacingError(
      `You need ${amount} design tokens for this, and your balance is too low. Buy a token pack to continue.`,
    );
  }
}

async function refund(userId: string, amount: number, ref: string): Promise<void> {
  // Two attempts: a transient failure must not leave a charged customer.
  for (let attempt = 1; attempt <= 2; attempt++) {
    const { error } = await sb()
      .from("design_token_ledger")
      .insert({ user_id: userId, delta: amount, reason: "refund", ref });
    // 23505: already refunded — the refund exists, which is what we want.
    if (!error || error.code === "23505") return;
    console.error("[magic-designs] REFUND FAILED", {
      userId,
      ref,
      amount,
      attempt,
      error: error.message,
    });
  }
  // Never report a refund that did not happen. The ref lets support find the
  // spend in design_token_ledger and refund it by hand.
  throw new CustomerFacingError(
    `Something went wrong and we couldn't return your ${amount} tokens automatically. Contact support and quote reference ${ref} — we'll add them back.`,
  );
}

function engineFailure(e: unknown, charged = true): never {
  if (e instanceof DesignEngineUnavailable) {
    throw new CustomerFacingError(
      "Magic Designs is not available right now. Your tokens were not used.",
    );
  }
  if (e instanceof DesignEngineError) {
    console.error("[magic-designs] engine error", e.message);
    throw new CustomerFacingError(
      charged
        ? "The design engine couldn't take this request just now. Your tokens were refunded — try again in a few minutes."
        : "The design engine couldn't prepare your download just now. Try again in a few minutes.",
    );
  }
  throw e;
}

async function ownDesign(
  userId: string,
  id: string,
): Promise<MagicDesignRow & { provider_design_id: string | null; checked_at: string | null }> {
  const { data, error } = await sb()
    .from("magic_designs")
    .select("*")
    .eq("id", id)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(`design read failed: ${error.message}`);
  if (!data) throw new CustomerFacingError("That design doesn't exist.");
  return data;
}

// ── Reads ────────────────────────────────────────────────────────────────────

export const getMagicDesignsHome = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const [balance, { data, error }] = await Promise.all([
      balanceOf(context.userId),
      sb()
        .from("magic_designs")
        .select("id,name,base_template,status,preview_url,created_at,updated_at")
        .eq("user_id", context.userId)
        .order("created_at", { ascending: false })
        .limit(100),
    ]);
    if (error) throw new Error(`designs read failed: ${error.message}`);
    return {
      balance,
      designs: (data ?? []) as Omit<MagicDesignRow, "brief">[],
      engineReady: !!process.env.MAGIC_PATTERNS_API_KEY,
    };
  });

export const getMagicDesign = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const design = await ownDesign(context.userId, data.id);
    const [{ data: requests, error }, balance] = await Promise.all([
      sb()
        .from("magic_design_requests")
        .select("id,kind,summary,tokens,created_at")
        .eq("design_id", design.id)
        .order("created_at", { ascending: true }),
      balanceOf(context.userId),
    ]);
    if (error) throw new Error(`history read failed: ${error.message}`);
    const { provider_design_id: _p, checked_at: _c, ...publicDesign } = design;
    return { design: publicDesign as MagicDesignRow, requests: requests ?? [], balance };
  });

// ── Create ───────────────────────────────────────────────────────────────────

export const createMagicDesign = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        baseTemplate: z.enum(MAGIC_DESIGN_BASES.map((b) => b.slug) as [string, ...string[]]),
        brief: briefSchema,
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    if (!process.env.MAGIC_PATTERNS_API_KEY) engineFailure(new DesignEngineUnavailable());
    if (!BASE_DESIGN_IDS[data.baseTemplate])
      throw new CustomerFacingError("Choose a starting template.");
    const base = MAGIC_DESIGN_BASES.find((b) => b.slug === data.baseTemplate)!;
    const id = crypto.randomUUID();
    const cost = DESIGN_TOKEN_COSTS.create;

    // The row exists BEFORE anything is charged or started, so a later failure
    // can never strand a payment or an engine job without a record of it.
    const { error: rowErr } = await sb().from("magic_designs").insert({
      id,
      user_id: context.userId,
      name: data.brief.marketplaceName,
      base_template: data.baseTemplate,
      brief: data.brief,
      status: "generating",
      checked_at: new Date().toISOString(),
    });
    if (rowErr) throw new Error(`design save failed: ${rowErr.message}`);
    const markFailed = () =>
      sb()
        .from("magic_designs")
        .update({ status: "failed", updated_at: new Date().toISOString() })
        .eq("id", id);

    try {
      await spend(context.userId, cost, "design_create", id);
    } catch (e) {
      await sb().from("magic_designs").delete().eq("id", id);
      throw e;
    }

    let engine;
    try {
      engine = await createEngineDesign({
        baseSlug: data.baseTemplate,
        name: data.brief.marketplaceName,
        prompt: buildCreatePrompt(data.brief, base.name),
      });
    } catch (e) {
      await markFailed();
      await refund(context.userId, cost, id);
      engineFailure(e);
    }

    // Link the engine job to the paid row. Retried: losing this mapping would
    // orphan a design the customer paid for.
    let linked = false;
    for (let attempt = 1; attempt <= 3 && !linked; attempt++) {
      const { error } = await sb()
        .from("magic_designs")
        .update({ provider_design_id: engine.editorId, preview_url: engine.previewUrl })
        .eq("id", id);
      if (!error) linked = true;
      else
        console.error("[magic-designs] DESIGN LINK FAILED", {
          id,
          editorId: engine.editorId,
          attempt,
          error: error.message,
        });
    }
    if (!linked) {
      throw new CustomerFacingError(
        `Your design started but we couldn't save its link. Contact support and quote reference ${id} — nothing is lost.`,
      );
    }
    await sb()
      .from("magic_design_requests")
      .insert({
        design_id: id,
        user_id: context.userId,
        kind: "create",
        summary: `New design from ${base.name}`,
        tokens: cost,
      });
    return { id };
  });

// ── Poll ─────────────────────────────────────────────────────────────────────

export const refreshMagicDesign = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const design = await ownDesign(context.userId, data.id);
    if (design.status !== "generating" || !design.provider_design_id) {
      return { status: design.status, previewUrl: design.preview_url };
    }
    const last = design.checked_at ? Date.parse(design.checked_at) : 0;
    if (Date.now() - last < MIN_POLL_MS) {
      return { status: design.status, previewUrl: design.preview_url };
    }
    let status;
    try {
      status = await getEngineStatus(design.provider_design_id);
    } catch (e) {
      console.error(
        "[magic-designs] status poll failed",
        design.id,
        e instanceof Error ? e.message : e,
      );
      await sb()
        .from("magic_designs")
        .update({ checked_at: new Date().toISOString() })
        .eq("id", design.id);
      return { status: design.status, previewUrl: design.preview_url };
    }
    const next = status.isGenerating ? "generating" : status.activeArtifactId ? "ready" : "failed";
    const now = new Date().toISOString();
    await sb()
      .from("magic_designs")
      .update({
        status: next,
        checked_at: now,
        ...(next !== "generating" ? { updated_at: now } : {}),
      })
      .eq("id", design.id);
    return { status: next, previewUrl: design.preview_url };
  });

// ── Change ───────────────────────────────────────────────────────────────────

const presetKeys = CHANGE_PRESETS.map((p) => p.key) as [string, ...string[]];

export const requestMagicDesignChange = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        id: z.string().uuid(),
        change: z.string().trim().max(BRIEF_LIMITS.long),
        preset: z.enum(presetKeys).nullable(),
      })
      .refine((v) => v.change.length >= 3 || v.preset, "Describe the change or pick one.")
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const design = await ownDesign(context.userId, data.id);
    if (design.status === "generating") {
      throw new CustomerFacingError(
        "This design is still being generated. Wait until it's ready to request a change.",
      );
    }
    if (!design.provider_design_id) throw new CustomerFacingError("This design can't be changed.");
    const requestId = crypto.randomUUID();
    const cost = DESIGN_TOKEN_COSTS.change;
    const preset = data.preset ? CHANGE_PRESETS.find((p) => p.key === data.preset) : null;

    await spend(context.userId, cost, "design_change", requestId);
    try {
      await sendEnginePrompt(
        design.provider_design_id,
        buildChangePrompt(
          data.change,
          (data.preset as (typeof CHANGE_PRESETS)[number]["key"]) ?? null,
        ),
      );
    } catch (e) {
      await refund(context.userId, cost, requestId);
      engineFailure(e);
    }
    const now = new Date().toISOString();
    await sb()
      .from("magic_designs")
      .update({ status: "generating", checked_at: now, updated_at: now })
      .eq("id", design.id);
    await sb()
      .from("magic_design_requests")
      .insert({
        id: requestId,
        design_id: design.id,
        user_id: context.userId,
        kind: "change",
        summary: [preset?.label, data.change].filter(Boolean).join(" — ").slice(0, 500),
        tokens: cost,
      });
    return { ok: true };
  });

// ── Download ─────────────────────────────────────────────────────────────────

export const downloadMagicDesign = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const design = await ownDesign(context.userId, data.id);
    if (design.status !== "ready" || !design.provider_design_id) {
      throw new CustomerFacingError("The design isn't ready to download yet.");
    }
    let files;
    try {
      const status = await getEngineStatus(design.provider_design_id);
      if (status.isGenerating || !status.activeArtifactId) {
        throw new CustomerFacingError(
          "A change is still being applied. Try the download again in a minute.",
        );
      }
      files = await readEngineFiles(
        design.provider_design_id,
        status.activeArtifactId,
        status.availableFiles,
      );
    } catch (e) {
      if (e instanceof CustomerFacingError) throw e;
      engineFailure(e, false);
    }
    const pkg = await buildDesignPackage({ files, brief: design.brief });
    // Base64 in the JSON reply: the client turns it back into a file to save.
    let binary = "";
    for (let i = 0; i < pkg.zip.length; i += 0x8000) {
      binary += String.fromCharCode(...pkg.zip.subarray(i, i + 0x8000));
    }
    return { fileName: pkg.fileName, base64: btoa(binary) };
  });

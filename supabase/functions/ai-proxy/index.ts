// Unified AI proxy with BYOK -> platform fallback.
// Tries the workspace's own provider key first; otherwise uses the platform
// OpenRouter key and bills the workspace's purchased credits at a markup
// (after a small free trial quota). No hard cap — out of credits => top up.
//
// Surfaces real provider errors verbatim (no swallowing), but never logs the key.
// Logs every call (success or failure) into ai_usage_log.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  OPENROUTER_BASE,
  resolvePlatformModel,
  estimateCostMicros,
  creditsForUsage,
  estimateCreditsBeforeCall,
} from "../_shared/ai-pricing.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type Provider = "openai" | "anthropic" | "google" | "openrouter" | "platform";

type Body = {
  workspaceId: string;
  feature?: string;
  // OpenAI-style messages; we adapt for Anthropic / Google.
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  model?: string; // optional override; otherwise we pick provider default
  maxTokens?: number;
  temperature?: number;
  preferProvider?: Provider; // optional explicit choice
};

const PROVIDER_DEFAULT_MODEL: Record<Exclude<Provider, "platform">, string> = {
  openai: "gpt-5-mini",
  anthropic: "claude-haiku-4-5",
  google: "gemini-2.5-flash",
  openrouter: "google/gemini-3.1-pro-preview",
};

// ---------- provider adapters ----------

async function callOpenAICompatible(
  base: string,
  apiKey: string,
  body: { model: string; messages: Body["messages"]; max_tokens?: number; temperature?: number },
) {
  const r = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${r.status}: ${text.slice(0, 500)}`);
  const json = JSON.parse(text);
  return {
    text: json.choices?.[0]?.message?.content ?? "",
    promptTokens: json.usage?.prompt_tokens ?? 0,
    completionTokens: json.usage?.completion_tokens ?? 0,
  };
}

async function callAnthropic(apiKey: string, body: Body) {
  const system = body.messages.find((m) => m.role === "system")?.content;
  const messages = body.messages.filter((m) => m.role !== "system");
  const model = body.model ?? PROVIDER_DEFAULT_MODEL.anthropic;
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      system,
      max_tokens: body.maxTokens ?? 1024,
      temperature: body.temperature,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${r.status}: ${text.slice(0, 500)}`);
  const json = JSON.parse(text);
  return {
    text: json.content?.[0]?.text ?? "",
    promptTokens: json.usage?.input_tokens ?? 0,
    completionTokens: json.usage?.output_tokens ?? 0,
    model,
  };
}

async function callGoogle(apiKey: string, body: Body) {
  const model = body.model ?? PROVIDER_DEFAULT_MODEL.google;
  const contents = body.messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
  const system = body.messages.find((m) => m.role === "system")?.content;
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents,
        systemInstruction: system ? { parts: [{ text: system }] } : undefined,
        generationConfig: {
          maxOutputTokens: body.maxTokens ?? 1024,
          temperature: body.temperature,
        },
      }),
    },
  );
  const text = await r.text();
  if (!r.ok) throw new Error(`${r.status}: ${text.slice(0, 500)}`);
  const json = JSON.parse(text);
  return {
    text: json.candidates?.[0]?.content?.parts?.[0]?.text ?? "",
    promptTokens: json.usageMetadata?.promptTokenCount ?? 0,
    completionTokens: json.usageMetadata?.candidatesTokenCount ?? 0,
    model,
  };
}

// ---------- main ----------

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const PUBLISHABLE = Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? Deno.env.get("SUPABASE_ANON_KEY")!;
    const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY");

    const admin = createClient(SUPABASE_URL, SERVICE_KEY);

    // Authn: caller must be a workspace member.
    const authHeader = req.headers.get("Authorization") ?? "";
    const userClient = createClient(SUPABASE_URL, PUBLISHABLE, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: ures } = await userClient.auth.getUser();
    if (!ures?.user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...cors, "Content-Type": "application/json" },
      });
    }
    const userId = ures.user.id;
    const body = (await req.json()) as Body;
    if (!body?.workspaceId || !Array.isArray(body?.messages)) {
      return new Response(JSON.stringify({ error: "workspaceId and messages required" }), {
        status: 400, headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    const { data: isMember } = await admin.rpc("is_workspace_member", {
      _workspace_id: body.workspaceId, _user_id: userId,
    });
    if (!isMember) {
      return new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403, headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    // Pick provider: explicit -> first valid BYOK -> platform.
    const { data: creds } = await admin
      .from("tenant_ai_credentials")
      .select("provider, status, default_models")
      .eq("workspace_id", body.workspaceId);

    // Honor an explicit choice only if it's "platform" or a *valid* configured
    // credential — never let the caller force an unconfigured/invalid provider
    // (or pick platform to spend platform credits when they have their own key).
    const validCreds = (creds ?? []).filter((c) => c.status === "valid");
    let provider: Provider = "platform";
    if (body.preferProvider === "platform") {
      provider = "platform";
    } else if (body.preferProvider && validCreds.some((c) => c.provider === body.preferProvider)) {
      provider = body.preferProvider;
    } else if (validCreds[0]) {
      provider = validCreds[0].provider as Provider;
    }

    let result: { text: string; promptTokens: number; completionTokens: number; model: string };
    let usedByok = false;
    let platformBilling: "free_quota" | "credits" | null = null;

    if (provider === "platform") {
      // Platform path: OpenRouter key, billed to the workspace's credits.
      if (!OPENROUTER_API_KEY) throw new Error("Platform AI key not configured");
      const model = resolvePlatformModel(body.model);

      // 1. Spend the free trial quota first (a handful of free platform calls).
      const { error: qErr } = await admin.rpc("consume_platform_ai_credit", {
        _workspace_id: body.workspaceId,
      });
      if (!qErr) {
        platformBilling = "free_quota";
      } else if (typeof qErr.message === "string" && qErr.message.includes("platform_ai_quota_exhausted")) {
        // 2. Trial exhausted — bill purchased credits. Pre-check the balance so we
        //    don't pay OpenRouter for a client who can't cover it. No hard cap:
        //    a zero balance just means "top up to continue".
        platformBilling = "credits";
        const promptChars = body.messages.reduce((n, m) => n + (m.content?.length ?? 0), 0);
        const estCredits = estimateCreditsBeforeCall(model, promptChars, body.maxTokens);
        const { data: bal } = await admin
          .from("credit_balances").select("balance").eq("workspace_id", body.workspaceId).maybeSingle();
        if (!bal || bal.balance < estCredits) {
          const msg = "Out of AI credits. Top up in Billing to keep generating.";
          await admin.from("ai_usage_log").insert({
            workspace_id: body.workspaceId, user_id: userId, provider: "platform",
            model, feature: body.feature ?? null,
            status: "insufficient_credits", error: msg, used_byok: false,
          });
          return new Response(JSON.stringify({ error: msg, code: "insufficient_credits" }), {
            status: 402, headers: { ...cors, "Content-Type": "application/json" },
          });
        }
      } else {
        throw new Error(qErr.message);
      }

      const r = await callOpenAICompatible(
        OPENROUTER_BASE,
        OPENROUTER_API_KEY,
        { model, messages: body.messages, max_tokens: body.maxTokens, temperature: body.temperature },
      );
      result = { ...r, model };
    } else {
      // BYOK path: read decrypted key from vault via security-definer RPC.
      const { data: apiKey, error: keyErr } = await admin.rpc("tenant_get_ai_credential", {
        _workspace_id: body.workspaceId, _provider: provider,
      });
      if (keyErr || !apiKey) {
        throw new Error(`No ${provider} key stored. Add one in Settings → AI.`);
      }
      usedByok = true;
      if (provider === "openai") {
        const model = body.model ?? PROVIDER_DEFAULT_MODEL.openai;
        const r = await callOpenAICompatible(
          "https://api.openai.com/v1",
          apiKey as string,
          { model, messages: body.messages, max_tokens: body.maxTokens, temperature: body.temperature },
        );
        result = { ...r, model };
      } else if (provider === "openrouter") {
        const model = body.model ?? PROVIDER_DEFAULT_MODEL.openrouter;
        const r = await callOpenAICompatible(
          "https://openrouter.ai/api/v1",
          apiKey as string,
          { model, messages: body.messages, max_tokens: body.maxTokens, temperature: body.temperature },
        );
        result = { ...r, model };
      } else if (provider === "anthropic") {
        result = await callAnthropic(apiKey as string, body);
      } else {
        result = await callGoogle(apiKey as string, body);
      }
    }

    const costMicros = estimateCostMicros(result.model, result.promptTokens, result.completionTokens);

    // Settle credits AFTER a successful call (cost-accurate, and no charge on
    // failure). Only the purchased-credit platform path bills; BYOK and the free
    // trial quota do not touch the credit ledger.
    let creditsCharged = 0;
    if (platformBilling === "credits") {
      creditsCharged = creditsForUsage(result.model, result.promptTokens, result.completionTokens);
      const { error: dErr } = await admin.rpc("deduct_credits", {
        _workspace_id: body.workspaceId,
        _amount: creditsCharged,
        _reason: "ai_usage",
        _ai_model: result.model,
        _ref_type: body.feature ?? "ai",
        _ref_id: null,
        _metadata: { provider: "platform" },
      });
      if (dErr) {
        // Actual exceeded balance at settle time (rare) — clamp to what's left
        // rather than failing a response the client already received.
        const { data: bal2 } = await admin
          .from("credit_balances").select("balance").eq("workspace_id", body.workspaceId).maybeSingle();
        const remaining = Math.max(0, bal2?.balance ?? 0);
        if (remaining > 0) {
          await admin.rpc("deduct_credits", {
            _workspace_id: body.workspaceId, _amount: remaining, _reason: "ai_usage",
            _ai_model: result.model, _ref_type: body.feature ?? "ai", _ref_id: null,
            _metadata: { provider: "platform", clamped: true },
          });
        }
        creditsCharged = remaining;
      }
    }

    await admin.from("ai_usage_log").insert({
      workspace_id: body.workspaceId, user_id: userId,
      provider, model: result.model, feature: body.feature ?? null,
      prompt_tokens: result.promptTokens, completion_tokens: result.completionTokens,
      total_tokens: result.promptTokens + result.completionTokens,
      cost_usd_micros: costMicros, used_byok: usedByok, status: "ok",
    });

    return new Response(JSON.stringify({
      text: result.text, model: result.model, provider,
      usedByok, promptTokens: result.promptTokens, completionTokens: result.completionTokens,
      costUsd: costMicros / 1_000_000, creditsCharged,
    }), { headers: { ...cors, "Content-Type": "application/json" } });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    console.error("[ai-proxy]", msg);
    // Best-effort log; ignore failures.
    try {
      const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
      const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
      const admin = createClient(SUPABASE_URL, SERVICE_KEY);
      await admin.from("ai_usage_log").insert({
        workspace_id: "00000000-0000-0000-0000-000000000000",
        provider: "platform", model: "unknown", status: "error", error: msg.slice(0, 500), used_byok: false,
      });
    } catch { /* noop */ }
    return new Response(JSON.stringify({ error: msg }), {
      status: 500, headers: { ...cors, "Content-Type": "application/json" },
    });
  }
});

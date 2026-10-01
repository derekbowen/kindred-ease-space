/**
 * The design engine behind Magic Designs (server-only).
 *
 * Customers never see the provider: designs are presented and delivered as
 * founders.click products. The API key lives only in the Worker secret
 * MAGIC_PATTERNS_API_KEY; without it every call fails closed with
 * DesignEngineUnavailable and no tokens are spent (callers spend after the
 * engine accepts the job, and refund on a later failure).
 *
 * Generation is asynchronous and slow (2–10 minutes). The provider asks for
 * status polls no more often than once a minute; refreshDesign enforces that
 * per design via magic_designs.checked_at.
 */

const API_BASE = "https://api.magicpatterns.com/api/v3";

/**
 * Each store template's design in the provider, used as the starting point a
 * new Magic Design is forked from. Server-only: these ids never reach the
 * browser.
 */
export const BASE_DESIGN_IDS: Record<string, string> = {
  poolshare: "nutacczofe7ear6bsbrwe6",
  gearloop: "ooqvmanqpefa327zhthj1b",
  probook: "6wjeuyqegaa54dwgcbxjn8",
  thrifted: "fsusfd6jbejjq6zjmv5alk",
  venuely: "ge9p94qejrzpvecslk6btj",
  driveshare: "uyp9suzdr6wlc7mhcoae5k",
  staybnb: "xs6rqsnpr7reckthnspziw",
  loanable: "7e8r3bqle2zcyecjmifn3u",
  trackroom: "1ga357bv8hroau29xauuth",
  flowspace: "7inx4nghxtadh21xwpefyz",
  parkspot: "1aaxepvc4g9v177u3vjnvh",
  deskhop: "mvwsj8pngxes8nrpwsykh8",
  kitchenhub: "nudsbkhzqqa4q6zeddhofd",
  harborly: "fft3we8f98ytu6pnnfe23d",
  campout: "s6egh5cnm5e1yoczobqwly",
  gigsy: "cocgnt5pszfbkayacbn87y",
  craftly: "3r65tkebxsbqjcd15xw9x1",
  vowly: "2ngxcdfpn5goivdgxcwqcu",
  courttime: "offq6nbmqpm4jkjo51sgrz",
  tutorly: "4txg61hokpey5er38p6cba",
  taskpost: "6jszwu4dokzubhi389vtkt",
  harvestly: "jcmd4a6mscjasynxh2iphb",
  stashly: "j42rkl8vvgutuzkpknlw97",
  bulkly: "sqrckar3bbdmuawf5luriq",
  dressly: "ugzuxdqwcdqimy5wq3qm5k",
  sitterly: "3vtxqwusknb4jjwqgrmhde",
  roomly: "ortzzcohv79ywa8kzwcvnj",
  stackd: "vsmlehtuuuoz7a1nte9s6z",
};

export class DesignEngineUnavailable extends Error {
  constructor(message = "The design engine is not configured.") {
    super(message);
    this.name = "DesignEngineUnavailable";
  }
}

export class DesignEngineError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "DesignEngineError";
  }
}

function apiKey(): string {
  const key = process.env.MAGIC_PATTERNS_API_KEY;
  if (!key) throw new DesignEngineUnavailable();
  return key;
}

async function call<T>(path: string, init: { method: "GET" | "POST"; body?: unknown }): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: init.method,
    headers: {
      "x-mp-api-key": apiKey(),
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  if (!res.ok) {
    let detail = "";
    try {
      detail = ((await res.json()) as { error?: string }).error ?? "";
    } catch {
      // not JSON
    }
    throw new DesignEngineError(
      `design engine ${init.method} ${path} → ${res.status} ${detail}`.trim(),
      res.status,
    );
  }
  return (await res.json()) as T;
}

export type EngineDesign = {
  editorId: string;
  previewUrl: string | null;
};

export async function createEngineDesign(input: {
  baseSlug: string;
  name: string;
  prompt: string;
}): Promise<EngineDesign> {
  const templateId = BASE_DESIGN_IDS[input.baseSlug];
  if (!templateId) throw new DesignEngineError(`unknown base template ${input.baseSlug}`, 400);
  const out = await call<{ editorId: string; previewUrl: string | null }>("/designs", {
    method: "POST",
    body: { name: input.name, prompt: input.prompt, templateId },
  });
  return { editorId: out.editorId, previewUrl: out.previewUrl ?? null };
}

export type EngineStatus = {
  isGenerating: boolean;
  activeArtifactId: string | null;
  availableFiles: string[];
};

export async function getEngineStatus(editorId: string): Promise<EngineStatus> {
  const out = await call<EngineStatus>(`/designs/${encodeURIComponent(editorId)}/status`, {
    method: "GET",
  });
  return {
    isGenerating: !!out.isGenerating,
    activeArtifactId: out.activeArtifactId ?? null,
    availableFiles: Array.isArray(out.availableFiles) ? out.availableFiles : [],
  };
}

export async function sendEnginePrompt(editorId: string, prompt: string): Promise<void> {
  await call(`/designs/${encodeURIComponent(editorId)}/prompts`, {
    method: "POST",
    body: { prompt },
  });
}

export async function readEngineFiles(
  editorId: string,
  artifactId: string,
  fileNames: string[],
): Promise<Array<{ name: string; content: string }>> {
  const out: Array<{ name: string; content: string }> = [];
  // Read in batches to keep each response a sensible size.
  for (let i = 0; i < fileNames.length; i += 40) {
    const batch = fileNames.slice(i, i + 40);
    const res = await call<{ files: Array<{ name: string; content: string }> }>(
      `/designs/${encodeURIComponent(editorId)}/artifacts/${encodeURIComponent(artifactId)}/files/read`,
      { method: "POST", body: { fileNames: batch } },
    );
    out.push(...(res.files ?? []));
  }
  return out;
}

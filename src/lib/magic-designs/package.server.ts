/**
 * Turns a generated design into the downloadable project a developer gets:
 * a standalone Vite + React + Tailwind app with README, license and
 * SHARETRIBE_SETUP.md, every image bundled, and no trace of the design tool.
 *
 * The same steps the store templates were packaged with:
 *   - design-system components the engine exports as empty stubs are filled
 *     from the vendored sources in ./ds/;
 *   - images on the engine's CDN are downloaded into public/images/;
 *   - a generated `icon: BoxIcon;` prop type is corrected to `typeof BoxIcon`.
 */
import { zipSync, strToU8 } from "fflate";
import { buildSharetribeSetup, type MagicDesignBrief } from "@/lib/magic-designs";

const DS_SOURCES = import.meta.glob("./ds/*.tsx.txt", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const CDN = "https://cdn.magicpatterns.com/patterns/generated-images/";
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/** Packages the design-system sources import, added when a filled stub needs them. */
const DS_DEPENDENCIES: Record<string, string> = {
  classnames: "2.5.1",
  clsx: "2.1.1",
  "class-variance-authority": "0.7.1",
  "@radix-ui/react-dialog": "1.1.4",
  "@floating-ui/react": "0.26.28",
  "@use-gesture/react": "10.3.1",
};

const DEV_DEPENDENCIES: Record<string, string> = {
  "@types/react": "18.3.12",
  "@types/react-dom": "18.3.1",
  "@vitejs/plugin-react": "4.3.4",
  autoprefixer: "10.4.20",
  postcss: "8.4.49",
  tailwindcss: "3.4.17",
  typescript: "5.6.3",
  vite: "5.4.11",
};

export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "marketplace"
  );
}

function dsSourceFor(componentName: string): string | undefined {
  return DS_SOURCES[`./ds/${componentName}.tsx.txt`];
}

export async function buildDesignPackage(input: {
  files: Array<{ name: string; content: string }>;
  brief: MagicDesignBrief;
}): Promise<{ fileName: string; zip: Uint8Array }> {
  const { brief } = input;
  const slug = slugify(brief.marketplaceName);
  const root = `${slug}/`;
  const out: Record<string, Uint8Array | [Uint8Array, { level: 0 }]> = {};

  let deps: Record<string, string> = {};
  let tailwindTheme = "export default { theme: { extend: {} } }\n";
  const sources: Record<string, string> = {};

  for (const f of input.files) {
    if (f.name === "package.json") {
      try {
        deps = {
          ...(JSON.parse(f.content) as { dependencies?: Record<string, string> }).dependencies,
        };
      } catch {
        deps = {};
      }
      continue;
    }
    if (f.name === "tailwind.config.js") {
      tailwindTheme = f.content;
      continue;
    }
    sources[f.name] = f.content;
  }

  // Fill design-system stubs the engine exported empty.
  for (const [name, content] of Object.entries(sources)) {
    if (!name.endsWith(".tsx") || content.trim() !== "") continue;
    const component = name
      .split("/")
      .pop()!
      .replace(/\.tsx$/, "");
    const ds = dsSourceFor(component);
    if (!ds) continue;
    sources[name] = ds;
    for (const [pkg, ver] of Object.entries(DS_DEPENDENCIES)) {
      if (ds.includes(`from '${pkg}`) || ds.includes(`from "${pkg}`)) deps[pkg] = ver;
    }
  }

  // Bundle CDN images locally.
  const imageIds = new Set<string>();
  for (const content of Object.values(sources)) {
    if (!content.includes("cdn.magicpatterns.com")) continue;
    for (const id of content.match(UUID_RE) ?? []) imageIds.add(id);
  }
  const fetched = await Promise.all(
    [...imageIds].map(async (id) => {
      try {
        const res = await fetch(`${CDN}${id}.jpg`);
        if (!res.ok) return null;
        return [id, new Uint8Array(await res.arrayBuffer())] as const;
      } catch {
        return null;
      }
    }),
  );
  const bundled = new Set<string>();
  for (const hit of fetched) {
    if (!hit) continue;
    out[`${root}public/images/${hit[0]}.jpg`] = [hit[1], { level: 0 }];
    bundled.add(hit[0]);
  }
  // Every image downloaded: rewrite the CDN prefix wholesale (this also covers
  // URLs built in code, e.g. `${CDN}${id}.jpg`). Otherwise rewrite only the
  // literal URLs of images we have, and leave the rest pointing at the CDN so
  // nothing in the download is a broken local path.
  const allBundled = imageIds.size === bundled.size;
  const localizeImages = (content: string) =>
    allBundled
      ? content.split(CDN).join("/images/")
      : [...bundled].reduce((acc, id) => acc.split(`${CDN}${id}`).join(`/images/${id}`), content);

  const devDeps = { ...DEV_DEPENDENCIES };
  if (deps["@types/leaflet"]) {
    devDeps["@types/leaflet"] = deps["@types/leaflet"];
    delete deps["@types/leaflet"];
  }

  for (const [name, raw] of Object.entries(sources)) {
    const content = localizeImages(raw).replace(
      /(\b\w+\??):\s*BoxIcon\s*;/g,
      "$1: typeof BoxIcon;",
    );
    out[`${root}src/${name}`] = strToU8(content);
  }

  const text = (path: string, content: string) => {
    out[`${root}${path}`] = strToU8(content);
  };
  text(
    "package.json",
    JSON.stringify(
      {
        name: slug,
        private: true,
        version: "1.0.0",
        type: "module",
        scripts: { dev: "vite", build: "vite build", preview: "vite preview" },
        dependencies: deps,
        devDependencies: devDeps,
      },
      null,
      2,
    ) + "\n",
  );
  text(
    "index.html",
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${brief.marketplaceName.replace(/[<>&"]/g, "")}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/index.tsx"></script>
  </body>
</html>
`,
  );
  text("tailwind.theme.js", tailwindTheme);
  text(
    "tailwind.config.js",
    `import theme from './tailwind.theme.js'

/** @type {import('tailwindcss').Config} */
export default {
  ...theme,
  content: ['./index.html', './src/**/*.{ts,tsx}'],
}
`,
  );
  text(
    "postcss.config.js",
    "export default {\n  plugins: { tailwindcss: {}, autoprefixer: {} },\n}\n",
  );
  text(
    "vite.config.ts",
    "import { defineConfig } from 'vite'\nimport react from '@vitejs/plugin-react'\n\nexport default defineConfig({\n  plugins: [react()],\n})\n",
  );
  text(
    "tsconfig.json",
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2020",
          lib: ["ES2020", "DOM", "DOM.Iterable"],
          module: "ESNext",
          moduleResolution: "bundler",
          jsx: "react-jsx",
          strict: false,
          skipLibCheck: true,
          noEmit: true,
          isolatedModules: true,
          resolveJsonModule: true,
        },
        include: ["src"],
      },
      null,
      2,
    ) + "\n",
  );
  text(".gitignore", "node_modules\ndist\n");
  text("SHARETRIBE_SETUP.md", buildSharetribeSetup(brief));
  text(
    "README.md",
    `# ${brief.marketplaceName}

A custom marketplace design by **Magic Designs by founders.click**, built on the page structure
and transaction flows of the [Sharetribe Web Template](https://github.com/sharetribe/web-template).

## Run it

\`\`\`bash
npm install
npm run dev      # http://localhost:5173
npm run build    # static build in dist/
\`\`\`

## Hand it to your developer

1. **SHARETRIBE_SETUP.md** lists the Sharetribe Console settings (listing type, layout,
   branding, listing fields) this design was made for.
2. Every page maps to a Sharetribe Web Template container (Landing → LandingPage,
   Search → SearchPage, Listing → ListingPage, Checkout → CheckoutPage, Inbox →
   InboxPage / TransactionPage, Create listing → EditListingPage, and so on).
3. Brand name and colors live in one theme/brand file under \`src/\`; sample content is mock
   data under \`src/data/\`, to be replaced with Sharetribe Marketplace API data.

Made with https://www.founders.click/magic-designs
`,
  );
  text(
    "LICENSE.md",
    `# ${brief.marketplaceName} design license

Copyright (c) 2026 10000 Solutions LLC (founders.click), licensed to the purchaser.

The purchaser may use, modify and deploy this design for their own marketplace or for a client.
The purchaser may not resell or redistribute it as a template, theme or design asset.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.
`,
  );

  return { fileName: `${slug}-magic-design.zip`, zip: zipSync(out, { level: 6 }) };
}

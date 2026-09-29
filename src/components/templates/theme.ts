/**
 * A customer's brand on their own pages — never the platform's orange.
 *
 * Pages are served on the customer's domain, so the accent is the
 * workspace's brand_color when one is configured and a neutral slate when
 * not. The palette is handed to the page as CSS custom properties on the
 * template's root element (see TemplateShell) and every branded class reads
 * them, so nothing here depends on JavaScript running in the browser.
 *
 * Colours reach a style attribute, so only a strict #rgb / #rrggbb survives;
 * URLs reach href/src, so only http(s) survives.
 */
import type { CSSProperties } from "react";

/** Neutral accent (slate-800) when no brand colour is configured. */
export const NEUTRAL_BRAND_COLOR = "#1e293b";
const WHITE = "#ffffff";
const INK = "#0f172a";

/** A strict hex colour, normalised to lowercase #rrggbb; anything else → null. */
export function sanitizeBrandColor(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim().toLowerCase();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(s);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
  return /^#[0-9a-f]{6}$/.test(s) ? s : null;
}

/** An absolute http(s) URL, trimmed; anything else (javascript:, data:, relative, junk) → null. */
export function safeHttpUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s || s.length > 2048) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (!u.hostname) return null;
    return u.toString();
  } catch {
    return null;
  }
}

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function hex([r, g, b]: [number, number, number]): string {
  return `#${[r, g, b].map((c) => Math.round(c).toString(16).padStart(2, "0")).join("")}`;
}

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of a #rrggbb colour. */
export function relativeLuminance(color: string): number {
  const [r, g, b] = rgb(color);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio between two #rrggbb colours (1–21). */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

function mix(a: string, b: string, t: number): string {
  const x = rgb(a);
  const y = rgb(b);
  return hex([x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t]);
}

/** Text colour for a label drawn ON the brand colour (white or ink, whichever reads better). */
export function textColorOn(background: string): string {
  return contrastRatio(background, WHITE) >= contrastRatio(background, INK) ? WHITE : INK;
}

/**
 * The brand colour as link/label text on a white page: the colour itself
 * when it meets WCAG AA (4.5:1) there, otherwise darkened until it does — a
 * pale yellow brand still gets readable links.
 */
export function accentOnWhite(color: string): string {
  let c = color;
  for (let i = 0; i < 16 && contrastRatio(c, WHITE) < 4.5; i++) c = mix(c, "#000000", 0.12);
  return contrastRatio(c, WHITE) >= 4.5 ? c : NEUTRAL_BRAND_COLOR;
}

export type BrandPalette = {
  /** Buttons, rules, chips. */
  brand: string;
  /** Text drawn on `brand`. */
  onBrand: string;
  /** Links and accent text on white. */
  accent: string;
  /** A faint wash of the brand for hero bands (rgba). */
  soft: string;
};

export function brandPalette(color: string | null): BrandPalette {
  const brand = sanitizeBrandColor(color) ?? NEUTRAL_BRAND_COLOR;
  const [r, g, b] = rgb(brand);
  return {
    brand,
    onBrand: textColorOn(brand),
    accent: accentOnWhite(brand),
    soft: `rgba(${r}, ${g}, ${b}, 0.07)`,
  };
}

/** The palette as the CSS custom properties the templates' classes read. */
export function brandThemeStyle(color: string | null): CSSProperties {
  const p = brandPalette(color);
  return {
    "--tp-brand": p.brand,
    "--tp-on-brand": p.onBrand,
    "--tp-accent": p.accent,
    "--tp-brand-soft": p.soft,
  } as CSSProperties;
}

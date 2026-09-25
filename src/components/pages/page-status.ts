/**
 * Customer words for a tenant page's status. The badge on the Pages list and
 * in the editor printed the stored value, so a page paused by billing read
 * "billing_suspended". Unknown values are title-cased with the underscores
 * gone rather than shown raw.
 */
const PAGE_STATUS_LABEL: Record<string, string> = {
  published: "Published",
  draft: "Draft",
  archived: "Archived",
  billing_suspended: "Paused (billing)",
};

export function pageStatusLabel(status: string | null | undefined): string {
  const key = (status ?? "").trim().toLowerCase();
  if (!key) return "Draft";
  if (PAGE_STATUS_LABEL[key]) return PAGE_STATUS_LABEL[key];
  const words = key.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

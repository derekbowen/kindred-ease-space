import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
  listCategories,
  getCategoryBySlug,
  listArticlesByCategory,
  getArticleBySlug,
  getRelatedArticles,
  listPopularArticles,
  listRecentArticles,
  searchArticles,
  suggestArticleTitles,
  logSearchQuery,
  submitFeedback,
  submitTicket,
  incrementArticleView,
  type HelpCategory,
  type HelpArticleListItem,
  type HelpArticleFull,
  type HelpTitleSuggestion,
} from "./help.server";

export type HelpHomeData = {
  categories: HelpCategory[];
  popular: HelpArticleListItem[];
  recent: HelpArticleListItem[];
  countsBySlug: Record<string, number>;
};

export const getHelpHome = createServerFn({ method: "GET" }).handler(async (): Promise<HelpHomeData> => {
  try {
    const [categories, popular, recent] = await Promise.all([
      listCategories(),
      listPopularArticles(6),
      listRecentArticles(4),
    ]);
    // Article counts per category
    const counts: Record<string, number> = {};
    await Promise.all(
      categories.map(async (c) => {
        const arts = await listArticlesByCategory(c.slug);
        counts[c.slug] = arts.length;
      })
    );
    return { categories, popular, recent, countsBySlug: counts };
  } catch (e) {
    console.error("[help] getHelpHome", e);
    return { categories: [], popular: [], recent: [], countsBySlug: {} };
  }
});

export type HelpCategoryData = {
  category: HelpCategory | null;
  articles: HelpArticleListItem[];
  otherCategories: HelpCategory[];
};

export const getHelpCategory = createServerFn({ method: "GET" })
  .inputValidator((d: { slug: string }) => d)
  .handler(async ({ data }): Promise<HelpCategoryData> => {
    try {
      const [category, allCats] = await Promise.all([getCategoryBySlug(data.slug), listCategories()]);
      if (!category) return { category: null, articles: [], otherCategories: allCats };
      const articles = await listArticlesByCategory(data.slug);
      return {
        category,
        articles,
        otherCategories: allCats.filter((c) => c.slug !== category.slug),
      };
    } catch (e) {
      console.error("[help] getHelpCategory", e);
      return { category: null, articles: [], otherCategories: [] };
    }
  });

export type HelpArticleData = {
  article: HelpArticleFull | null;
  category: HelpCategory | null;
  related: HelpArticleListItem[];
};

export const getHelpArticle = createServerFn({ method: "GET" })
  .inputValidator((d: { categorySlug: string; articleSlug: string }) => d)
  .handler(async ({ data }): Promise<HelpArticleData> => {
    try {
      const article = await getArticleBySlug(data.categorySlug, data.articleSlug);
      if (!article) return { article: null, category: null, related: [] };
      const [category, related] = await Promise.all([
        getCategoryBySlug(data.categorySlug),
        article.related_article_ids?.length
          ? getRelatedArticles(article.related_article_ids)
          : Promise.resolve([] as HelpArticleListItem[]),
      ]);
      // Fire-and-forget view increment
      incrementArticleView(article.id).catch(() => {});
      return { article, category, related };
    } catch (e) {
      console.error("[help] getHelpArticle", e);
      return { article: null, category: null, related: [] };
    }
  });

export type HelpSearchResult = {
  query: string;
  results: HelpArticleListItem[];
  categories: HelpCategory[];
};

export const searchHelp = createServerFn({ method: "GET" })
  .inputValidator((d: { q: string }) => d)
  .handler(async ({ data }): Promise<HelpSearchResult> => {
    const q = (data.q ?? "").trim().slice(0, 200);
    if (!q) return { query: "", results: [], categories: await listCategories() };
    try {
      const [results, categories] = await Promise.all([searchArticles(q, 50), listCategories()]);
      // Fire-and-forget logging
      logSearchQuery(q, results.length).catch(() => {});
      return { query: q, results, categories };
    } catch (e) {
      console.error("[help] searchHelp", e);
      return { query: q, results: [], categories: [] };
    }
  });

const FeedbackSchema = z.object({
  articleId: z.string().uuid(),
  isHelpful: z.boolean(),
  comment: z.string().trim().max(1000).optional().nullable(),
});

export const submitArticleFeedback = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => FeedbackSchema.parse(d))
  .handler(async ({ data }) => {
    try {
      await submitFeedback({
        articleId: data.articleId,
        isHelpful: data.isHelpful,
        comment: data.comment ?? null,
      });
      return { ok: true as const };
    } catch (e) {
      console.error("[help] submitArticleFeedback", e);
      return { ok: false as const, error: "Failed to submit feedback" };
    }
  });

const TicketSchema = z.object({
  email: z.string().trim().email().max(255),
  name: z.string().trim().max(120).optional().nullable(),
  subject: z.string().trim().min(3).max(200),
  message: z.string().trim().min(10).max(5000),
  category: z.enum(["billing", "technical", "sales", "other"]).optional().nullable(),
});

export const submitSupportTicket = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => TicketSchema.parse(d))
  .handler(async ({ data }) => {
    try {
      const { id } = await submitTicket({
        email: data.email,
        name: data.name ?? null,
        subject: data.subject,
        message: data.message,
        category: data.category ?? null,
      });
      return { ok: true as const, ticketId: id };
    } catch (e) {
      console.error("[help] submitSupportTicket", e);
      return { ok: false as const, error: "Failed to submit ticket" };
    }
  });

export const quickSearchHelp = createServerFn({ method: "GET" })
  .inputValidator((d: { q: string }) => d)
  .handler(async ({ data }): Promise<{ results: HelpArticleListItem[] }> => {
    const q = (data.q ?? "").trim().slice(0, 200);
    if (!q) return { results: [] };
    try {
      const results = await searchArticles(q, 8);
      return { results };
    } catch (e) {
      console.error("[help] quickSearchHelp", e);
      return { results: [] };
    }
  });

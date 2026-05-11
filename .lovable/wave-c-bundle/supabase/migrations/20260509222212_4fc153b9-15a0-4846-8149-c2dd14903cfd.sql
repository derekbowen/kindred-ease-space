ALTER TABLE public.blog_posts
  ADD COLUMN IF NOT EXISTS tldr_bullets jsonb,
  ADD COLUMN IF NOT EXISTS related_slugs jsonb,
  ADD COLUMN IF NOT EXISTS enrichment_generated_at timestamptz;
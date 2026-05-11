ALTER TABLE public.blog_posts ADD COLUMN IF NOT EXISTS topic text;
CREATE INDEX IF NOT EXISTS idx_blog_posts_topic ON public.blog_posts (topic) WHERE is_published = true;
CREATE INDEX IF NOT EXISTS idx_blog_posts_published_at ON public.blog_posts (published_at DESC) WHERE is_published = true;
UPDATE public.blog_posts SET topic = 'hosting' WHERE topic IS NULL AND slug = 'how-to-host-a-pool-party';
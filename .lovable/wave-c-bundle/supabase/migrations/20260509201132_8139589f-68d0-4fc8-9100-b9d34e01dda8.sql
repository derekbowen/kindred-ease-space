UPDATE public.blog_posts
SET content = replace(content, '/blog/', '/p/'),
    updated_at = now()
WHERE content LIKE '%/blog/%';

UPDATE public.blog_posts
SET content = replace(content, '/p/host-tools', '/p/free-host-tools'),
    updated_at = now()
WHERE content LIKE '%/p/host-tools%'
  AND content NOT LIKE '%/p/free-host-tools%/p/host-tools%';
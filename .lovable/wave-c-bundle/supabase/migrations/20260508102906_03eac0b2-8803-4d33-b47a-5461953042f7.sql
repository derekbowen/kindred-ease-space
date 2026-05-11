UPDATE public.content_pages
SET url_path = '/p/terms-of-service',
    status = CASE WHEN status = 'pending' THEN 'published' ELSE status END
WHERE slug = 'terms-of-service';

UPDATE public.content_pages
SET url_path = '/p/privacy-policy'
WHERE slug = 'privacy-policy';
UPDATE public.content_pages
SET url_path = '/p/host-training-academy'
WHERE slug = 'host-training-academy';

UPDATE public.content_pages
SET url_path = '/p/become-a-host',
    status = CASE WHEN status = 'pending' THEN 'published' ELSE status END
WHERE slug = 'become-a-host';

UPDATE public.content_pages
SET url_path = '/p/become-a-swimming-pool-host',
    status = CASE WHEN status = 'pending' THEN 'published' ELSE status END
WHERE slug = 'become-a-swimming-pool-host';
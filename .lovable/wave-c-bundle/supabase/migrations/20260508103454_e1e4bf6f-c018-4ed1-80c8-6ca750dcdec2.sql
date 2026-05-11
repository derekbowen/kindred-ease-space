UPDATE public.content_pages
SET url_path = '/p/how-it-works'
WHERE slug = 'how-it-works' AND url_path = '/infos/how-it-works';

UPDATE public.content_pages
SET in_sitemap = false,
    redirect_to = '/p/learningacademy'
WHERE slug = 'learning-academy';

UPDATE public.content_pages
SET status = 'published'
WHERE slug = 'aprende-a-rentar-tu-piscina' AND status = 'pending';
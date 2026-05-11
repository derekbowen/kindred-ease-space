UPDATE public.content_pages
SET status = 'published'
WHERE template_type = 'host_advocacy_state'
  AND status = 'scraped'
  AND slug IN (
    'host-advocacy-oregon',
    'host-advocacy-virginia',
    'host-advocacy-nevada',
    'host-advocacy-new-york'
  );
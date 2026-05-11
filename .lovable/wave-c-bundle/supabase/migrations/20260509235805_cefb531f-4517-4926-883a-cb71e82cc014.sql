UPDATE public.content_pages
SET body_markdown = NULL,
    updated_at = now()
WHERE template_type = 'host_advocacy_state'
  AND slug IN (
    'host-advocacy-oregon',
    'host-advocacy-virginia',
    'host-advocacy-nevada',
    'host-advocacy-new-york'
  );

ALTER TABLE public.gsc_query_data DROP CONSTRAINT IF EXISTS gsc_query_data_url_path_query_key;
DROP INDEX IF EXISTS public.gsc_query_data_url_path_query_key;
ALTER TABLE public.gsc_query_data ADD CONSTRAINT gsc_query_data_workspace_url_query_key UNIQUE (workspace_id, url_path, query);

ALTER TABLE public.competitor_pages DROP CONSTRAINT IF EXISTS competitor_pages_url_key;
DROP INDEX IF EXISTS public.competitor_pages_url_key;
ALTER TABLE public.competitor_pages ADD CONSTRAINT competitor_pages_workspace_url_key UNIQUE (workspace_id, url);

ALTER TABLE public.internal_link_suggestions DROP CONSTRAINT IF EXISTS internal_link_suggestions_from_url_to_url_key;
DROP INDEX IF EXISTS public.internal_link_suggestions_from_url_to_url_key;
ALTER TABLE public.internal_link_suggestions ADD CONSTRAINT internal_link_suggestions_workspace_from_to_key UNIQUE (workspace_id, from_url, to_url);

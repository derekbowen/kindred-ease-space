
create extension if not exists vector;

create table if not exists public.help_article_embeddings (
  id uuid primary key default gen_random_uuid(),
  article_id uuid not null references public.help_articles(id) on delete cascade,
  chunk_index int not null,
  content text not null,
  embedding vector(1536) not null,
  created_at timestamptz not null default now(),
  unique (article_id, chunk_index)
);

create index if not exists help_article_embeddings_embedding_idx
  on public.help_article_embeddings using hnsw (embedding vector_cosine_ops);

create index if not exists help_article_embeddings_article_idx
  on public.help_article_embeddings(article_id);

alter table public.help_article_embeddings enable row level security;

create or replace function public.match_help_chunks(
  query_embedding vector(1536),
  match_count int default 6
)
returns table (
  article_id uuid,
  chunk_index int,
  content text,
  similarity float,
  article_title text,
  article_slug text,
  category_slug text
)
language sql
stable
security definer
set search_path = public
as $$
  select
    e.article_id,
    e.chunk_index,
    e.content,
    1 - (e.embedding <=> query_embedding) as similarity,
    a.title as article_title,
    a.slug as article_slug,
    a.category_slug as category_slug
  from public.help_article_embeddings e
  join public.help_articles a on a.id = e.article_id
  where coalesce(a.status, 'published') = 'published'
    and coalesce(a.is_published, true) = true
    and a.workspace_id is null
  order by e.embedding <=> query_embedding
  limit greatest(match_count, 1);
$$;

revoke all on function public.match_help_chunks(vector, int) from public, anon, authenticated;

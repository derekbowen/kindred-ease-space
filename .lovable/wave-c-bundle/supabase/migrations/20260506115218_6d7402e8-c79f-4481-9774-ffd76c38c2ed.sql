DELETE FROM content_pages WHERE slug = 'pool-pros';
INSERT INTO content_pages (slug, url_path, template_type, status, in_sitemap, locale, title, seo_title, seo_description, description, body_markdown)
VALUES (
  'pool-pros',
  '/p/pool-pros',
  'resource',
  'published',
  true,
  'en',
  'Pool Pros Directory',
  'Pool Pros Directory | Pool Rental Near Me',
  'Browse trusted pool builders, cleaners, and service pros across the US.',
  'Browse trusted pool builders, cleaners, and service pros across the US.',
  $$## Find a pool pro near you

Looking for a builder, cleaner, or service pro for your swimming pool? Our directory connects you with trusted local professionals across the United States.

### What you can find here

- **Pool builders** for new construction and renovations
- **Pool cleaners** for weekly and one-time service
- **Repair specialists** for pumps, heaters, and equipment
- **Inspection services** before buying or renting out a pool

### Why hosts use Pool Pros

If you rent your pool through Pool Rental Near Me, keeping it spotless and well-maintained is the difference between a 4-star and a 5-star listing. Hiring a local pro pays for itself with one extra booking.

### List your business

Run a pool service company? Get in touch to be listed in the directory.
$$
);
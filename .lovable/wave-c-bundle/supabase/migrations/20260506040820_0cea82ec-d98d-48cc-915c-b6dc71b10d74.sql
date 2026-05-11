-- Seed default competitor sites for radar
INSERT INTO public.competitor_sites (domain, sitemap_url, label) VALUES
  ('swimply.com', 'https://swimply.com/sitemap.xml', 'Swimply'),
  ('giggster.com', 'https://giggster.com/sitemap.xml', 'Giggster'),
  ('peerspace.com', 'https://www.peerspace.com/sitemap.xml', 'Peerspace')
ON CONFLICT (domain) DO NOTHING;

-- Seed priority tracked keywords
INSERT INTO public.tracked_keywords (keyword, target_url_path, market) VALUES
  ('pool rental near me', '/', 'us'),
  ('rent a pool by the hour', '/', 'us'),
  ('swimply alternative', '/p/swimply-alternative-vs-pool-rental-near-me', 'us'),
  ('private pool rental', '/', 'us'),
  ('hourly pool rental', '/', 'us')
ON CONFLICT (keyword, market) DO NOTHING;
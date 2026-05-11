UPDATE public.synced_listings
SET state_code = upper(m[1])
FROM (
  SELECT id, regexp_match(address, ',\s*([A-Z]{2})\s+\d{5}') AS m
  FROM public.synced_listings
  WHERE state_code IS NULL AND address IS NOT NULL
) sub
WHERE public.synced_listings.id = sub.id
  AND sub.m IS NOT NULL;
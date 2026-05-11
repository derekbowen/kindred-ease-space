UPDATE public.content_pages
SET body_markdown = REPLACE(
  body_markdown,
  E'**How much does it cost to list?**\nListing your pool is completely free. Pool Rental Near Me charges a 15% commission on completed bookings only.',
  E'**How much does it cost to list?**\nListing your pool is completely free. Pool Rental Near Me charges a flat 10% host commission on completed bookings — hosts keep 90% of every booking subtotal. A separate 10% renter service fee is paid by the guest, for a 20% total platform take that is transparent on every booking.'
),
updated_at = now()
WHERE slug = 'faq'
  AND body_markdown LIKE '%15% commission on completed bookings%';
-- Service categories
CREATE TABLE IF NOT EXISTS public.service_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  plural_name text NOT NULL,
  icon text,
  hero_image_url text,
  intro_markdown text,
  seo_title text,
  seo_description text,
  sort_order int NOT NULL DEFAULT 100,
  is_published boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.service_categories ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public can read published service categories"
  ON public.service_categories FOR SELECT TO anon, authenticated
  USING (is_published = true);

CREATE POLICY "Admins manage service categories"
  ON public.service_categories FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

CREATE TRIGGER update_service_categories_updated_at
  BEFORE UPDATE ON public.service_categories
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

INSERT INTO public.service_categories (slug, name, plural_name, icon, sort_order, seo_title, seo_description, intro_markdown) VALUES
  ('pool-builders', 'Pool Builder', 'Pool Builders', 'Hammer', 10,
   'Pool Builders Directory — Find Local Pool Construction Pros',
   'Browse vetted pool builders near you. Compare designs, materials, and quotes for inground, fiberglass, and concrete pools.',
   'Find a trusted local **pool builder** for your inground, fiberglass, or gunite project. All listings include service area, specialties, and direct contact.'),
  ('pool-cleaners', 'Pool Cleaner', 'Pool Cleaners', 'Sparkles', 20,
   'Pool Cleaning Services — Weekly & One-Time Pool Maintenance',
   'Find local pool cleaners for weekly maintenance, chemical balancing, and seasonal service. Compare local pros now.',
   'Browse local **pool cleaning services** offering weekly maintenance, chemical balancing, vacuuming, and tile scrubbing.'),
  ('pool-repair', 'Pool Repair Pro', 'Pool Repair Pros', 'Wrench', 30,
   'Pool Repair Services — Pump, Liner, Heater & Equipment Repair',
   'Local pool repair specialists for pumps, heaters, liners, filters, and plumbing leaks. Get matched with a pro fast.',
   'Find **pool repair specialists** for pumps, heaters, filters, liner replacement, and equipment troubleshooting.'),
  ('pool-manufacturers', 'Pool Manufacturer', 'Pool Manufacturers', 'Factory', 40,
   'Pool Manufacturers — Fiberglass Shells, Liners & Equipment',
   'Browse leading pool manufacturers and suppliers of fiberglass shells, vinyl liners, and pool equipment.',
   'Browse **pool manufacturers** producing fiberglass shells, vinyl liners, pumps, heaters, and full pool equipment lines.'),
  ('pool-openers-closers', 'Opening & Closing Service', 'Pool Opening & Closing Services', 'CalendarClock', 50,
   'Pool Opening & Closing Services — Seasonal Pool Pros',
   'Schedule local pool opening and winter closing services. Find seasonal pool pros for spring start-ups and winterizing.',
   'Find local pros for **seasonal pool openings and winterizations** — pump priming, chemical balancing, cover install, and antifreeze line blowouts.'),
  ('pool-leak-detection', 'Leak Detection Specialist', 'Pool Leak Detection Specialists', 'SearchCheck', 60,
   'Pool Leak Detection Services — Find & Fix Pool Leaks',
   'Find pool leak detection specialists using pressure testing, dye, and sonic equipment to locate and repair pool leaks.',
   'Locate hidden pool leaks fast with **certified leak-detection specialists** using pressure, dye, and sonic testing.'),
  ('pool-resurfacing', 'Resurfacing Pro', 'Pool Resurfacing Pros', 'PaintBucket', 70,
   'Pool Resurfacing — Plaster, Pebble & Tile Refinishing',
   'Find pool resurfacing pros for plaster, pebble, quartz, and tile refinishing. Restore your aging pool surface.',
   'Refinish an aging pool with **plaster, pebble, quartz, or tile resurfacing** by vetted local pros.')
ON CONFLICT (slug) DO NOTHING;

-- Extend providers
ALTER TABLE public.providers
  ADD COLUMN IF NOT EXISTS primary_category text REFERENCES public.service_categories(slug) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS secondary_categories text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS is_featured boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS featured_until timestamptz,
  ADD COLUMN IF NOT EXISTS listing_paid_until timestamptz,
  ADD COLUMN IF NOT EXISTS plan text NOT NULL DEFAULT 'free',
  ADD COLUMN IF NOT EXISTS claim_status text NOT NULL DEFAULT 'unclaimed',
  ADD COLUMN IF NOT EXISTS submission_status text NOT NULL DEFAULT 'approved',
  ADD COLUMN IF NOT EXISTS submitter_email text,
  ADD COLUMN IF NOT EXISTS submission_notes text;

CREATE INDEX IF NOT EXISTS providers_primary_category_idx ON public.providers (primary_category) WHERE is_published = true;
CREATE INDEX IF NOT EXISTS providers_state_idx ON public.providers (state_code) WHERE is_published = true;
CREATE INDEX IF NOT EXISTS providers_featured_idx ON public.providers (is_featured) WHERE is_published = true AND is_featured = true;
CREATE INDEX IF NOT EXISTS providers_submission_status_idx ON public.providers (submission_status) WHERE submission_status = 'pending';

-- Allow anyone to submit a new pending provider (admin must approve before publish)
DROP POLICY IF EXISTS "Anyone can submit a provider" ON public.providers;
CREATE POLICY "Anyone can submit a provider"
  ON public.providers FOR INSERT TO anon, authenticated
  WITH CHECK (
    is_published = false
    AND submission_status = 'pending'
    AND claim_status IN ('unclaimed', 'pending')
  );
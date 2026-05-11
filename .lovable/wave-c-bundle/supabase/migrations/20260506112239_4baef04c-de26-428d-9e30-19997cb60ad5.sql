
-- Privacy requests capture table
CREATE TABLE IF NOT EXISTS public.privacy_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_type text NOT NULL,
  email text NOT NULL,
  full_name text,
  state_code text,
  details text,
  gpc_signal boolean DEFAULT false,
  source_url text,
  user_agent text,
  status text NOT NULL DEFAULT 'new',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.privacy_requests ENABLE ROW LEVEL SECURITY;

-- Anyone (including anon) can submit a privacy request
CREATE POLICY "Anyone can submit a privacy request"
  ON public.privacy_requests
  FOR INSERT
  TO anon, authenticated
  WITH CHECK (true);

-- Only admins can read/update privacy requests
CREATE POLICY "Admins can view privacy requests"
  ON public.privacy_requests
  FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can update privacy requests"
  ON public.privacy_requests
  FOR UPDATE
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

CREATE TRIGGER update_privacy_requests_updated_at
  BEFORE UPDATE ON public.privacy_requests
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE INDEX idx_privacy_requests_created_at ON public.privacy_requests (created_at DESC);
CREATE INDEX idx_privacy_requests_status ON public.privacy_requests (status);

-- Backfill the "Why Hosts Are Leaving Swimply" page body with the new content
UPDATE public.content_pages
SET
  title = 'Why hosts are leaving Swimply for Pool Rental Near Me',
  seo_title = 'Why hosts are leaving Swimply for PRNM',
  seo_description = 'Lower fees, included $2M insurance, and a 2026 privacy policy that actually complies with all 20 state laws. Here is why hosts are switching.',
  body_markdown = $md$
Hosts switch platforms for three reasons: take rate, protection, and trust. Pool Rental Near Me beats Swimply on all three. Here is the short version, then the receipts.

## The fee gap costs you four figures a year

Swimply takes 15%+ from every booking. We take 10% flat. On a pool earning $4,000/month in summer, that is $2,400 you keep over a four-month season. Multiply that across years and the math gets loud.

[Run your own numbers in the earnings calculator.](/p/earnings-calculator)

## $2M liability insurance is included, not an upsell

Every booking on PRNM ships with $2M of host liability coverage. Built in. No separate signup, no gotcha exclusions for "commercial use" that void your homeowner policy at the worst moment. Most hosts do not realize their personal policy will not cover a paid pool rental until a claim gets denied.

## A privacy policy that actually complies with 2026 state law

This is the one nobody is talking about. Swimply's privacy policy is generic boilerplate written for a 2019 internet. Ours is lawyer-grade and current with the 20 US state privacy laws now in effect.

What that means for you, the host:

- We honor **Global Privacy Control** signals automatically. No clicking, no forms — your browser tells us, we comply.
- We do not share your mobile location or device data with ad networks. Period.
- We give every user a **30-day arbitration opt-out** at signup. Most platforms hide this in fine print or skip it entirely.
- We do not sell personal information for money, and we limit "sharing" for cross-context advertising the moment you opt out.
- Sensitive data (ID verification, precise location) is restricted to the operations that need it and deleted on the schedule the law requires.
- California, Colorado, Connecticut, Virginia, Texas, Oregon, Delaware, New Jersey, Montana, and the rest of the 2024-2026 wave are all covered in one document, not bolted-on addenda.

When a guest, neighbor, or regulator asks "how does this platform treat my data," you can hand them [our policy](/privacy-policy) and the conversation ends. That is a trust signal Swimply cannot hand you back.

## Payouts and support are not an afterthought

Fast ACH payouts, a real human on support, and a host community that talks to each other through our [free host tools](/p/free-host-tools). You are not ticket #48,291 here.

## The switch takes 20 minutes

Pull your photos, copy your description, set your rate. Done.

[List your pool free.](/l/draft/00000000-0000-0000-0000-000000000000/new/details)

## FAQ

**Can I run on both platforms?** Yes. Most hosts test PRNM with their existing calendar, see the take-home difference, then move primary. Nothing stops you from dual-listing.

**What about my existing Swimply reviews?** Bring screenshots into your PRNM listing description. Reputation transfers because guests read the writeup, not the source URL.

**How do I exercise my own privacy rights as a host?** [Submit a request here](/p/privacy-request) — we honor every state's rights regardless of where you live. If your browser sends GPC, we already know.
$md$,
  status = 'published',
  updated_at = now()
WHERE url_path = '/p/why-hosts-are-leaving-swimply';

-- Host tools registry
CREATE TABLE public.host_tools (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  title text NOT NULL,
  summary text,
  category text NOT NULL DEFAULT 'Calculator',
  icon text,
  sort_order integer NOT NULL DEFAULT 0,
  is_published boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.host_tools ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public can read published host tools" ON public.host_tools
  FOR SELECT TO anon, authenticated USING (is_published = true);

CREATE POLICY "Admins can manage host tools" ON public.host_tools
  FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

CREATE TRIGGER update_host_tools_updated_at
  BEFORE UPDATE ON public.host_tools
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Message board threads
CREATE TABLE public.mb_threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  author_name text,
  title text NOT NULL,
  body text NOT NULL,
  category text,
  is_pinned boolean NOT NULL DEFAULT false,
  reply_count integer NOT NULL DEFAULT 0,
  like_count integer NOT NULL DEFAULT 0,
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.mb_threads ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read threads" ON public.mb_threads
  FOR SELECT TO anon, authenticated USING (true);

CREATE POLICY "Authenticated can create threads" ON public.mb_threads
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Authors update own threads" ON public.mb_threads
  FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Authors delete own threads" ON public.mb_threads
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

CREATE POLICY "Admins manage threads" ON public.mb_threads
  FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

CREATE TRIGGER update_mb_threads_updated_at
  BEFORE UPDATE ON public.mb_threads
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE INDEX idx_mb_threads_last_activity ON public.mb_threads (last_activity_at DESC);

-- Replies
CREATE TABLE public.mb_replies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id uuid NOT NULL REFERENCES public.mb_threads(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  author_name text,
  body text NOT NULL,
  like_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.mb_replies ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read replies" ON public.mb_replies
  FOR SELECT TO anon, authenticated USING (true);

CREATE POLICY "Authenticated can create replies" ON public.mb_replies
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Authors update own replies" ON public.mb_replies
  FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Authors delete own replies" ON public.mb_replies
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

CREATE POLICY "Admins manage replies" ON public.mb_replies
  FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

CREATE TRIGGER update_mb_replies_updated_at
  BEFORE UPDATE ON public.mb_replies
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE INDEX idx_mb_replies_thread ON public.mb_replies (thread_id, created_at);

-- Likes
CREATE TABLE public.mb_likes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  thread_id uuid REFERENCES public.mb_threads(id) ON DELETE CASCADE,
  reply_id uuid REFERENCES public.mb_replies(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((thread_id IS NOT NULL) <> (reply_id IS NOT NULL))
);

CREATE UNIQUE INDEX uniq_mb_likes_thread ON public.mb_likes (user_id, thread_id) WHERE thread_id IS NOT NULL;
CREATE UNIQUE INDEX uniq_mb_likes_reply ON public.mb_likes (user_id, reply_id) WHERE reply_id IS NOT NULL;

ALTER TABLE public.mb_likes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read likes" ON public.mb_likes
  FOR SELECT TO anon, authenticated USING (true);

CREATE POLICY "Users add own likes" ON public.mb_likes
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users remove own likes" ON public.mb_likes
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- Triggers to keep counts in sync
CREATE OR REPLACE FUNCTION public.mb_update_thread_reply_count()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE public.mb_threads
      SET reply_count = reply_count + 1,
          last_activity_at = now()
      WHERE id = NEW.thread_id;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE public.mb_threads
      SET reply_count = GREATEST(reply_count - 1, 0)
      WHERE id = OLD.thread_id;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER mb_replies_count_trigger
  AFTER INSERT OR DELETE ON public.mb_replies
  FOR EACH ROW EXECUTE FUNCTION public.mb_update_thread_reply_count();

CREATE OR REPLACE FUNCTION public.mb_update_like_counts()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.thread_id IS NOT NULL THEN
      UPDATE public.mb_threads SET like_count = like_count + 1 WHERE id = NEW.thread_id;
    ELSIF NEW.reply_id IS NOT NULL THEN
      UPDATE public.mb_replies SET like_count = like_count + 1 WHERE id = NEW.reply_id;
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD.thread_id IS NOT NULL THEN
      UPDATE public.mb_threads SET like_count = GREATEST(like_count - 1, 0) WHERE id = OLD.thread_id;
    ELSIF OLD.reply_id IS NOT NULL THEN
      UPDATE public.mb_replies SET like_count = GREATEST(like_count - 1, 0) WHERE id = OLD.reply_id;
    END IF;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER mb_likes_count_trigger
  AFTER INSERT OR DELETE ON public.mb_likes
  FOR EACH ROW EXECUTE FUNCTION public.mb_update_like_counts();

-- Seed all 56 tools
INSERT INTO public.host_tools (slug, title, summary, category, icon, sort_order) VALUES
('pool-rental-earnings-calculator','Pool Rental Earnings Calculator','Advanced income estimator with amenities, location & charts','Calculator','dollar',1),
('pool-earnings','Pool Earnings Calculator','Quick estimate of pool rental income','Calculator','dollar',2),
('pool-party-pricing','Pool Party Pricing Calculator','Figure out the right price for pool parties','Calculator','party',3),
('pool-insurance','Pool Insurance Estimator','Estimate pool rental insurance costs','Calculator','shield',4),
('pool-capacity','Pool Capacity Calculator','How many guests fit in your pool','Calculator','users',5),
('pool-break-even','Pool Break-Even Calculator','When does your pool pay for itself?','Calculator','target',6),
('pool-roi-calculator','Pool ROI Calculator','Return on investment for pool ownership','Calculator','trending',7),
('pool-cost-calculator','How Much Does a Pool Cost?','Total pool cost calculator with installation, maintenance & ROI','Calculator','dollar',8),
('private-pool-pricing-calculator','Private Pool Pricing','Pricing for private & adult-only bookings','Calculator','lock',9),
('pool-heating-cost','Pool Heating Cost Calculator','Cost to heat your pool by heater type','Calculator','flame',10),
('pool-maintenance-cost','Pool Maintenance Cost Calculator','Monthly maintenance cost estimates','Calculator','wrench',11),
('pool-chemical-cost','Pool Chemical Cost Calculator','Monthly chemical cost breakdown','Calculator','flask',12),
('pool-water-usage','Pool Water Usage Calculator','Water volume and cost estimates','Calculator','droplet',13),
('pool-pump-cost-calculator','Pool Pump Energy Cost','Electricity cost to run your pool pump','Calculator','zap',14),
('pool-fill-cost-calculator','Pool Fill Cost Calculator','Cost and time to fill your pool','Calculator','droplet',15),
('pool-heating-time-calculator','Pool Heating Time Calculator','How long to heat your pool','Calculator','flame',16),
('pool-evaporation-calculator','Pool Evaporation Calculator','Water lost to evaporation and refill costs','Calculator','droplet',17),
('pool-volume-calculator','Pool Volume Calculator','Calculate gallons of water in your pool','Calculator','droplet',18),
('pool-deck-size-calculator','Pool Deck Size Calculator','Recommended deck area for your pool','Calculator','ruler',19),
('pool-party-capacity','Pool Party Capacity','Safe party size for your pool and deck','Guide','users',20),
('pool-shade-calculator','Pool Shade Calculator','How much shade coverage you need','Calculator','umbrella',21),
('pool-chemical-dose-calculator','Pool Chemical Dose Calculator','Right amount of chlorine, shock, or algaecide','Calculator','flask',22),
('pool-water-chemistry','Pool Water Chemistry Advisor','Enter test readings, get exact chemical doses & step-by-step instructions','Guide','flask',23),
('pool-liability-waiver','Pool Liability Waiver Generator','Generate a printable liability waiver','Generator','file',24),
('pool-rules','Pool Rules Generator','Create printable pool rules signs','Generator','file',25),
('pool-guest-agreement','Pool Guest Agreement Builder','Comprehensive guest agreements','Generator','file',26),
('pool-safety-checklist','Pool Safety Checklist','Safety compliance checklist','Checklist','check',27),
('pool-host-checklist','Pool Host Checklist','Pre-booking preparation guide','Checklist','check',28),
('pool-wifi-qr','Pool WiFi QR Generator','QR code for guest WiFi access','Generator','qr',29),
('pool-welcome-sign','Pool Welcome Sign Generator','Printable welcome signs','Generator','file',30),
('pool-cleaning-schedule','Pool Cleaning Schedule','Maintenance schedule generator','Planner','calendar',31),
('message-board','Pool Host Message Board','Public board for hosts to share tips & connect','Community','message',32),
('host-marketing-engine','Host Marketing Engine','Generate flyers, social posts, DM scripts & campaigns instantly','AI','sparkles',33),
('pool-listing-ai-writer','Pool Listing AI Writer','Generate optimized listing titles, descriptions & photo tips','AI','sparkles',34),
('social-media-calendar','Social Media Content Calendar','30-day posting schedule with ready-to-use captions & hashtags','Planner','calendar',35),
('review-response-generator','Review Response Generator','Professional replies to guest reviews — positive or negative','AI','sparkles',36),
('email-sms-campaigns','Email & SMS Campaign Builder','Drip campaigns for repeat guests, seasonal promos & referrals','AI','sparkles',37),
('pool-listing-score','Pool Listing Score','Grade your pool listing quality','Guide','star',38),
('pool-host-pricing-ai','Pool Host Pricing AI','AI-driven pricing recommendations','AI','sparkles',39),
('pool-rental-price-index','Pool Rental Price Index','Local market pricing data','Guide','chart',40),
('seasonality','Seasonality Calculator','Best months to rent by region','Calculator','calendar',41),
('backyard-income-calculator','Backyard Income Calculator','Total backyard earning potential from pools, events & more','Calculator','dollar',42),
('backyard-monetization','Backyard Monetization Calculator','Full backyard earning potential','Calculator','dollar',43),
('event-profit','Event Profit Calculator','Party and event profitability','Calculator','party',44),
('swim-lesson-pricing','Swim Lesson Pricing Tool','Private lesson rate calculator','Calculator','dollar',45),
('birthday-party-planner','Birthday Party Planner','Budget and plan pool parties','Planner','party',46),
('backyard-event-pricing','Backyard Event Pricing','Price your backyard for events','Calculator','dollar',47),
('pool-rental-profit','Pool Rental Profit Calculator','Net profit from pool rentals','Calculator','dollar',48),
('noise-distance','Noise Distance Calculator','Check party noise compliance','Calculator','volume',49),
('hoa-risk-checker','HOA Risk Checker','Assess HOA compatibility','Checklist','shield',50),
('hoa-pool-rental-defense-kit','HOA Pool Rental Defense Kit','Legal templates & strategies to protect your right to rent your pool','Guide','shield',51),
('amenity-revenue-guide','Amenity & Upgrade Revenue Guide','Interactive ROI calculator for 249 pool amenities & upgrades','Guide','star',52),
('pool-host-academy','Pool Host Academy','Free courses and guides to become a top-rated pool host','Guide','book',53),
('pool-host-community','Pool Host Community','Connect with other pool hosts, share tips & grow together','Community','users',54),
('new-host-courses','New Host Courses','Latest training courses for pool hosts','Guide','book',55),
('cursos-en-espanol','Cursos en Español','Aprende a rentar tu piscina — Spanish hosting guides','Guide','book',56);
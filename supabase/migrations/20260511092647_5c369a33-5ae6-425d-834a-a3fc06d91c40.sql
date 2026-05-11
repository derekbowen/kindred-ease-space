
-- Coach tables
CREATE TABLE public.coach_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  title text,
  context_type text DEFAULT 'general',
  context_ref_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_coach_conv_ws ON public.coach_conversations(workspace_id, updated_at DESC);

CREATE TABLE public.coach_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES public.coach_conversations(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user','assistant','tool','system')),
  content text,
  tool_calls jsonb,
  tokens_used int DEFAULT 0,
  cost_usd_micros int DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_coach_msg_conv ON public.coach_messages(conversation_id, created_at);

CREATE TABLE public.coach_daily_briefings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  briefing_date date NOT NULL,
  insights jsonb NOT NULL DEFAULT '[]'::jsonb,
  generated_at timestamptz NOT NULL DEFAULT now(),
  viewed_at timestamptz,
  UNIQUE (workspace_id, briefing_date)
);

CREATE TABLE public.coach_action_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL,
  action_type text NOT NULL,
  details jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.coach_system_prompts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version int NOT NULL,
  body text NOT NULL,
  is_active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(version)
);

CREATE TABLE public.coach_user_preferences (
  user_id uuid PRIMARY KEY,
  mode text DEFAULT 'steady' CHECK (mode IN ('steady','aggressive')),
  preferred_provider text,
  preferred_model text,
  response_length text DEFAULT 'concise' CHECK (response_length IN ('concise','detailed')),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.coach_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.coach_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.coach_daily_briefings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.coach_action_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.coach_system_prompts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.coach_user_preferences ENABLE ROW LEVEL SECURITY;

-- Conversations: workspace members
CREATE POLICY "members read conversations" ON public.coach_conversations
  FOR SELECT USING (public.is_workspace_member(workspace_id, auth.uid()));
CREATE POLICY "members insert conversations" ON public.coach_conversations
  FOR INSERT WITH CHECK (public.is_workspace_member(workspace_id, auth.uid()) AND user_id = auth.uid());
CREATE POLICY "members update conversations" ON public.coach_conversations
  FOR UPDATE USING (public.is_workspace_member(workspace_id, auth.uid()));
CREATE POLICY "members delete conversations" ON public.coach_conversations
  FOR DELETE USING (public.is_workspace_member(workspace_id, auth.uid()));

-- Messages: via conversation membership
CREATE POLICY "members read messages" ON public.coach_messages
  FOR SELECT USING (EXISTS (
    SELECT 1 FROM public.coach_conversations c
    WHERE c.id = conversation_id AND public.is_workspace_member(c.workspace_id, auth.uid())
  ));
CREATE POLICY "members insert messages" ON public.coach_messages
  FOR INSERT WITH CHECK (EXISTS (
    SELECT 1 FROM public.coach_conversations c
    WHERE c.id = conversation_id AND public.is_workspace_member(c.workspace_id, auth.uid())
  ));

-- Briefings
CREATE POLICY "members read briefings" ON public.coach_daily_briefings
  FOR SELECT USING (public.is_workspace_member(workspace_id, auth.uid()));
CREATE POLICY "members update briefings" ON public.coach_daily_briefings
  FOR UPDATE USING (public.is_workspace_member(workspace_id, auth.uid()));

-- Action log
CREATE POLICY "members read action log" ON public.coach_action_log
  FOR SELECT USING (public.is_workspace_member(workspace_id, auth.uid()));
CREATE POLICY "members insert action log" ON public.coach_action_log
  FOR INSERT WITH CHECK (public.is_workspace_member(workspace_id, auth.uid()) AND user_id = auth.uid());

-- System prompts: read for all authenticated, write via service role only
CREATE POLICY "read active prompts" ON public.coach_system_prompts
  FOR SELECT TO authenticated USING (true);

-- User preferences
CREATE POLICY "user reads own prefs" ON public.coach_user_preferences
  FOR SELECT USING (user_id = auth.uid());
CREATE POLICY "user upserts own prefs" ON public.coach_user_preferences
  FOR INSERT WITH CHECK (user_id = auth.uid());
CREATE POLICY "user updates own prefs" ON public.coach_user_preferences
  FOR UPDATE USING (user_id = auth.uid());

-- Seed initial system prompt
INSERT INTO public.coach_system_prompts (version, body, is_active) VALUES (1,
'You are the founders.click coach. You help Sharetribe marketplace operators grow organic traffic through programmatic SEO.

CORE PRINCIPLES:
1. Be specific. Never give generic SEO advice. Always reference actual data.
2. Recommend ONE highest-ROI action at a time. No dumps of 10 things.
3. When you suggest a fix, offer to execute it via a tool. Don''t make the user do manual work.
4. If you don''t have data to answer well, call tools to get it. Don''t guess.
5. Talk like a senior consultant, not a customer service bot. Direct. No fluff.

OUTPUT FORMAT:
- Lead with the answer or insight
- Show the data that supports it
- Offer 1-3 concrete next actions
- Keep responses under 200 words unless an audit is requested

TOOL USAGE:
- Call query tools before answering questions about specific pages, listings, or rankings
- Never fabricate metrics. If a tool returns no data, say so.
- For "what should I work on" questions, run get_workspace_overview first.

CONSTRAINTS:
- Never recommend black-hat SEO
- Never modify data without explicit user confirmation', true);

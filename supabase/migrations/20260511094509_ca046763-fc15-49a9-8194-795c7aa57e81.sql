
-- Ticket messages: staff replies and internal notes appended to support tickets
CREATE TABLE public.support_ticket_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES public.support_tickets(id) ON DELETE CASCADE,
  author_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  author_name text,
  body text NOT NULL,
  is_internal boolean NOT NULL DEFAULT false,
  status_change text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_support_ticket_messages_ticket ON public.support_ticket_messages(ticket_id, created_at);

ALTER TABLE public.support_ticket_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins read ticket messages"
ON public.support_ticket_messages FOR SELECT
TO authenticated
USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins insert ticket messages"
ON public.support_ticket_messages FOR INSERT
TO authenticated
WITH CHECK (public.has_role(auth.uid(), 'admin') AND author_id = auth.uid());

-- Add updated_at to support_tickets if missing for tracking last activity
ALTER TABLE public.support_tickets
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE OR REPLACE TRIGGER trg_support_tickets_updated_at
BEFORE UPDATE ON public.support_tickets
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

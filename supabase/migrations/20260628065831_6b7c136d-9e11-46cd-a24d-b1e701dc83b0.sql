-- Prevent two parallel ensureWorkspace() calls from creating two owner workspaces
-- for the same user (TOCTOU race). A partial unique index on user_id WHERE role='owner'
-- makes the second concurrent owner insert fail, which the app handles by rolling
-- back its orphan workspace and reading the winner.
CREATE UNIQUE INDEX IF NOT EXISTS workspace_members_one_owner_per_user
  ON public.workspace_members (user_id)
  WHERE role = 'owner';
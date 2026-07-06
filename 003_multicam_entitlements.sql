-- ─────────────────────────────────────────────────────────────────────────────
-- MultiCam (and future signed apps) — per-app premium entitlements
-- ─────────────────────────────────────────────────────────────────────────────
-- Run this in the Supabase Dashboard → SQL Editor.
--
-- This creates a single app-agnostic table that the admin page uses to grant
-- premium access per-user per-app.  Each signed app (MultiCam, pianoce, etc.)
-- queries its own row after forum login to decide whether premium features are
-- unlocked.
--
-- The forum_users table is assumed to already exist (shared with pianoce).
-- user_id here MUST match forum_users.id, which is the `sub` claim in the JWT
-- issued by the forum login endpoint.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Entitlements table --------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.app_entitlements (
    id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     uuid        NOT NULL,
    app         text        NOT NULL,           -- 'multicam', 'pianoce', ...
    premium     boolean     NOT NULL DEFAULT false,
    granted_at  timestamptz DEFAULT now(),
    granted_by  uuid,                           -- admin user_id who enabled it
    notes       text,
    UNIQUE (user_id, app)                        -- one row per user per app
);

-- Index for the client query: "my entitlement for app X"
CREATE INDEX IF NOT EXISTS idx_app_ent_user_app
    ON public.app_entitlements (user_id, app);

-- Index for the admin page: "all users with premium for app X"
CREATE INDEX IF NOT EXISTS idx_app_ent_app_premium
    ON public.app_entitlements (app, premium);

COMMENT ON TABLE public.app_entitlements IS
    'Per-app premium entitlements granted by admin. user_id matches forum_users.id / JWT sub.';

-- 2. Row Level Security --------------------------------------------------------
-- Users can READ their own entitlements only.
-- Writes (INSERT/UPDATE/DELETE) are blocked for regular users — the admin page
-- uses the service-role key, which bypasses RLS entirely.

ALTER TABLE public.app_entitlements ENABLE ROW LEVEL SECURITY;

-- Drop existing policies if re-running this script
DROP POLICY IF EXISTS "entitlements_self_select" ON public.app_entitlements;
DROP POLICY IF EXISTS "entitlements_no_insert"   ON public.app_entitlements;
DROP POLICY IF EXISTS "entitlements_no_update"   ON public.app_entitlements;
DROP POLICY IF EXISTS "entitlements_no_delete"   ON public.app_entitlements;

-- A user can read only rows where user_id matches their JWT sub claim.
-- auth.uid() reads the `sub` claim from the Bearer JWT passed by the client.
CREATE POLICY "entitlements_self_select"
    ON public.app_entitlements
    FOR SELECT
    USING (auth.uid() = user_id);

-- Explicitly deny writes for authenticated users (defense in depth).
-- The admin page uses the service role key, which ignores RLS.
CREATE POLICY "entitlements_no_insert"
    ON public.app_entitlements
    FOR INSERT
    WITH CHECK (false);

CREATE POLICY "entitlements_no_update"
    ON public.app_entitlements
    FOR UPDATE
    USING (false);

CREATE POLICY "entitlements_no_delete"
    ON public.app_entitlements
    FOR DELETE
    USING (false);

-- 3. Force PostgREST to pick up the new table ---------------------------------
NOTIFY pgrst, 'reload schema';
SELECT pg_sleep(1);
SELECT pg_notify('pgrst', 'reload schema');

-- ─────────────────────────────────────────────────────────────────────────────
-- VERIFICATION (run manually after, to confirm):
--
--   SELECT * FROM public.app_entitlements LIMIT 5;
--
-- GRANT premium for a user (run from the admin page, or manually with the
-- service-role key / in the SQL editor which runs as postgres):
--
--   INSERT INTO public.app_entitlements (user_id, app, premium, granted_by)
--   VALUES ('<user-uuid>', 'multicam', true, '<admin-uuid>')
--   ON CONFLICT (user_id, app) DO UPDATE SET premium = true, granted_at = now();
--
-- REVOKE premium:
--
--   UPDATE public.app_entitlements SET premium = false
--   WHERE user_id = '<user-uuid>' AND app = 'multicam';
-- ─────────────────────────────────────────────────────────────────────────────

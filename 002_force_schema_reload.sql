-- Force PostgREST schema cache reload — trying all known methods
-- Run this in the Supabase Dashboard → SQL Editor

-- Method 1: New partial reload commands (PostgREST v14.3+)
NOTIFY pgrst, 'reload tables';
NOTIFY pgrst, 'reload relationships';

-- Wait a moment for the first notification to be processed
SELECT pg_sleep(2);

-- Method 2: Full schema reload
NOTIFY pgrst, 'reload schema';

-- Wait again
SELECT pg_sleep(2);

-- Method 3: Config reload (sometimes triggers schema reload too)
NOTIFY pgrst, 'reload config';

-- Wait
SELECT pg_sleep(2);

-- Method 4: Use pg_notify function directly (bypasses SQL parser NOTIFY)
SELECT pg_notify('pgrst', 'reload schema');

-- Wait
SELECT pg_sleep(3);

-- Method 5: Create an event trigger that auto-reloads on DDL changes
-- This ensures future table changes are automatically picked up
CREATE OR REPLACE FUNCTION public.pgrst_reload_schema()
RETURNS event_trigger AS $$
BEGIN
    NOTIFY pgrst, 'reload schema';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP EVENT TRIGGER IF EXISTS pgrst_watch;
CREATE EVENT TRIGGER pgrst_watch
    ON ddl_command_end
    EXECUTE FUNCTION public.pgrst_reload_schema();

-- Now make a trivial DDL change to trigger the event trigger
COMMENT ON TABLE domain_ratings IS 'User domain ELO ratings';
COMMENT ON TABLE user_progress IS 'User lesson progress';
COMMENT ON TABLE unit_scores IS 'User unit scores';
COMMENT ON TABLE weak_areas IS 'User weak areas for spaced repetition';
COMMENT ON TABLE trials IS 'User trial data';

-- Final wait and notification
SELECT pg_sleep(3);
SELECT pg_notify('pgrst', 'reload schema');

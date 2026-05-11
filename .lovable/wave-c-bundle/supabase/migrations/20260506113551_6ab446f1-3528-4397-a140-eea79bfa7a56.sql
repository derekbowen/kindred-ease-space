DO $migration$
DECLARE
  body_text text;
BEGIN
  body_text := pg_read_file('/tmp/swimply.md', 0, 200000);
EXCEPTION WHEN others THEN
  body_text := NULL;
END
$migration$;
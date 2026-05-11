-- Fix mojibake (U+FFFD replacement chars) in advocacy bodies.
-- Heuristics applied in order, mapping context to the original character.
UPDATE public.content_pages
SET body_markdown =
  regexp_replace(
    regexp_replace(
      regexp_replace(
        regexp_replace(
          regexp_replace(
            regexp_replace(
              -- 1) "Code §123" pattern: "Code <FFFD>123" -> "Code §123"
              regexp_replace(body_markdown, 'Code ' || E'\uFFFD' || '(\d)', 'Code §\1', 'g'),
              -- 2) Degrees: "50s<FFFD>F" / "70<FFFD>F" / "<FFFD>C" -> "°F" / "°C"
              '(\d)s?' || E'\uFFFD' || '([FC])\b', '\1°\2', 'g'
            ),
            -- 3) En dash between digits/currency with no spaces: "75<FFFD>150" -> "75–150"
            '(\$?\d+(?:,\d+)*)' || E'\uFFFD' || '(\$?\d)', '\1–\2', 'g'
          ),
          -- 4) En dash in numeric range with optional units: "10<FFFD>11" -> "10–11" (already covered above; keep for safety)
          '(\d)' || E'\uFFFD' || '(\d)', '\1–\2', 'g'
        ),
        -- 5) En dash between letters with no spaces: "May<FFFD>October" -> "May–October"
        '([A-Za-z])' || E'\uFFFD' || '([A-Za-z])', '\1–\2', 'g'
      ),
      -- 6) Em dash with surrounding spaces becomes comma per voice rules: " <FFFD> " -> ", "
      '\s' || E'\uFFFD' || '\s', ', ', 'g'
    ),
    -- 7) Anything else: drop to a plain hyphen so nothing renders as a black diamond.
    E'\uFFFD', '-', 'g'
  ),
  updated_at = now()
WHERE template_type IN ('host_advocacy_state', 'host_advocacy_hub')
  AND body_markdown LIKE '%' || E'\uFFFD' || '%';
UPDATE content_pages
SET body_markdown = regexp_replace(body_markdown, '\]\(https://www\.poolrentalnearme\.com/', '](/', 'g')
WHERE body_markdown LIKE '%](https://www.poolrentalnearme.com/%';
-- Faster field uploads (requested by the owner): stop uploading a separate un-watermarked
-- original for new photos. Existing files in Drive are not touched. Can be switched back
-- in the dashboard (Google Drive & retention).
UPDATE settings SET value = json_set(value, '$.keepOriginals', json('false')) WHERE key = 'app';

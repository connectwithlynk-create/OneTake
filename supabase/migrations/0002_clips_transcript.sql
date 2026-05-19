-- Applied to project arkzlehcpbzohmxwpntl via MCP.
-- Stores the Deepgram transcript so it backs up + restores cross-device,
-- and drives talking/b-roll + the spoken-words title.
alter table public.clips add column if not exists transcript text;

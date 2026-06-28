-- Kör mot live-D1 innan besöksstatistiken fungerar:
--   npx wrangler d1 execute <DB> --remote --file infra/migrations/001_visits.sql
CREATE TABLE IF NOT EXISTS visits (
  id TEXT PRIMARY KEY,
  visitor_hash TEXT NOT NULL,
  visited_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_visits_visited_at ON visits(visited_at);
CREATE INDEX IF NOT EXISTS idx_visits_hash ON visits(visitor_hash);

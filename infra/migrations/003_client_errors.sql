-- Dedup-/räkningstabell för automatiskt rapporterade klientfel.
-- En rad per unik felsignatur (meddelande + fil:rad); github_issue_url sätts
-- när en GitHub-issue skapats för felet (NULL = ingen issue, t.ex. pga dygnstak).
CREATE TABLE IF NOT EXISTS client_errors (
  signature TEXT PRIMARY KEY,
  message TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  github_issue_url TEXT
);
CREATE INDEX IF NOT EXISTS idx_client_errors_first_seen ON client_errors (first_seen);

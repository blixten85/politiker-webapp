-- Politiker-webapp D1-schema

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  password_set_by_user INTEGER NOT NULL DEFAULT 0, -- 0 för konton skapade via OAuth med slumpat oanvändbart lösenord, 1 efter setPassword()
  email_verified INTEGER NOT NULL DEFAULT 0,
  verification_code TEXT,
  verification_expires_at INTEGER,
  daily_send_cap INTEGER NOT NULL DEFAULT 200,
  is_admin INTEGER NOT NULL DEFAULT 0,
  reset_token TEXT,
  reset_expires_at INTEGER,
  totp_secret TEXT,
  totp_enabled INTEGER NOT NULL DEFAULT 0,
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- Länkar externa OAuth-identiteter (Google/GitHub/Microsoft/Apple) till ett
-- lokalt konto. Ett konto skapat enbart via OAuth har tom password_hash/salt
-- (kan inte logga in med lösenord förrän det sätts explicit).
CREATE TABLE oauth_identities (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  provider TEXT NOT NULL, -- google | github | microsoft | apple
  provider_user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(provider, provider_user_id),
  UNIQUE(account_id, provider)
);

-- Två typer av mailkoppling i samma tabell:
-- 1) SMTP (gmail/outlook/icloud/yahoo/generic): smtp_*/encrypted_password ifyllda, oauth_*-kolumner NULL.
-- 2) OAuth/Graph (microsoft_graph): oauth_*-kolumner ifyllda (krypterade), smtp_*/encrypted_password
--    får platshållarvärden ("oauth"/0) eftersom kolumnerna är NOT NULL och SQLite inte
--    enkelt stödjer att släppa det villkoret i efterhand.
CREATE TABLE mail_credentials (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  provider TEXT NOT NULL, -- gmail | outlook | icloud | yahoo | generic | microsoft_graph
  smtp_host TEXT NOT NULL,
  smtp_port INTEGER NOT NULL,
  smtp_user TEXT NOT NULL,
  encrypted_password TEXT NOT NULL, -- AES-GCM, nyckel = Wrangler secret MAIL_CRED_KEY
  from_address TEXT NOT NULL,
  verified_at INTEGER, -- sätts efter lyckad SMTP AUTH-testhandskakning / OAuth-koppling
  daily_cap INTEGER, -- = floor(leverantörens hårdkodade tak * user_cap_pct / 100), heltal
  user_cap_pct INTEGER NOT NULL DEFAULT 100, -- användarens egna val av andel av taket (1-100)
  oauth_access_token TEXT, -- krypterad, endast för provider = microsoft_graph
  oauth_refresh_token TEXT, -- krypterad, används för att förnya access_token
  oauth_token_expires_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE politicians (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  area_name TEXT NOT NULL,   -- t.ex. "Lysekils kommun", "Region Halland", "Sveriges riksdag"
  area_type TEXT NOT NULL,   -- kommun | region | riksdag | regering
  last_scraped_at INTEGER NOT NULL,
  verification_status TEXT NOT NULL DEFAULT 'unknown', -- unknown | valid_via_send | dead_via_send (satt i realtid av sender/src/index.ts vid riktiga utskick) | valid | dead | catchall_unverified | unreachable_* | unknown_code_* | error_* (historiskt satt av politiker-kontakter/verify/verify_emails.py, ej längre i drift — port 25 blockerad både i Cloudflare Workers och hos mp100:s leverantör)
  last_verified_at INTEGER,
  UNIQUE(email, area_name)
);
CREATE INDEX idx_politicians_area ON politicians(area_type, area_name);

CREATE TABLE letters (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  html_body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- mode: 'attach' (skickas som bilaga) | 'extract' (innehållet konverterades
-- till HTML och lades in i letters.html_body — raden behålls bara för spårbarhet)
CREATE TABLE letter_attachments (
  id TEXT PRIMARY KEY,
  letter_id TEXT NOT NULL REFERENCES letters(id),
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  mode TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- En rad per sändningsomgång (för statusvy: "243 av 500 skickade")
CREATE TABLE send_jobs (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  letter_id TEXT NOT NULL REFERENCES letters(id),
  mail_credential_id TEXT NOT NULL REFERENCES mail_credentials(id),
  total_recipients INTEGER NOT NULL,
  sent_count INTEGER NOT NULL DEFAULT 0,
  bounce_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | sending | done | aborted
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);

-- En rad per mottagare, facit för rate-limit och bounce-cirkelbrytare
CREATE TABLE send_log (
  id TEXT PRIMARY KEY,
  send_job_id TEXT NOT NULL REFERENCES send_jobs(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  recipient_email TEXT NOT NULL,
  status TEXT NOT NULL, -- ok | bounce
  error TEXT,
  sent_at INTEGER NOT NULL
);
CREATE INDEX idx_send_log_account_date ON send_log(account_id, sent_at);

-- Granskningskö för civilsamhälls-brev (kvartalsvis, anonymt avsändarkonto).
-- Inget skickas förrän status='approved' satts via en token-länk i ett
-- granskningsmail — ingen passiv timeout, ingen auto-send.
CREATE TABLE civic_letter_drafts (
  id TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  html_body TEXT NOT NULL,
  topic_source_url TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected | sending | done
  approve_token TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  approved_at INTEGER
);

CREATE TABLE feedback (
  id TEXT PRIMARY KEY,
  account_id TEXT,
  message TEXT NOT NULL,
  github_issue_url TEXT,
  created_at INTEGER NOT NULL
);

-- Personliga API-nycklar: alternativ till sessionskaka för programmatisk
-- åtkomst (Authorization: Bearer <nyckel>). Bara hash lagras, klartext visas
-- en gång vid skapande.
CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  key_hash TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);

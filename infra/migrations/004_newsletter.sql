-- Nyhetsbrev: prenumeranter (dubbel opt-in) + utskickslogg per kampanjbrev.
--
-- Flödet: besökare anmäler sig (POST /api/newsletter/subscribe, Turnstile-
-- skyddat) -> bekräftelsemail med länk (confirmed_at sätts) -> campaign-
-- Workerns newsletter-steg skickar varje publicerat kampanjbrev
-- (public_letters, source='campaign') som ett dagligt digest till alla
-- bekräftade prenumeranter. Avregistrering via token-länk i varje utskick.

CREATE TABLE newsletter_subscribers (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  token TEXT NOT NULL,             -- bekräftelse- OCH avregistreringstoken
  created_at INTEGER NOT NULL,
  confirmed_at INTEGER,            -- NULL = obekräftad (får inga utskick)
  unsubscribed_at INTEGER          -- satt = avregistrerad (får inga utskick)
);

CREATE TABLE newsletter_sends (
  id TEXT PRIMARY KEY,
  letter_id TEXT NOT NULL,         -- public_letters.id (source='campaign')
  subscriber_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | sent | failed
  sent_at INTEGER,
  error TEXT,
  UNIQUE(letter_id, subscriber_id)
);

CREATE INDEX idx_newsletter_sends_status ON newsletter_sends(status);

-- Land per besök (Cloudflare ISO-3166-1 alpha-2, t.ex. "SE"). Nullbart:
-- äldre rader saknar det, och country kan vara okänt (T1/Tor m.m.).
-- Coarse land-nivå bryter inte anonymiteten — visitor_hash är fortfarande
-- irreversibelt utan både IP och user-agent.
ALTER TABLE visits ADD COLUMN country TEXT;

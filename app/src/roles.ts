// Kanonisk normalisering av skrapade befattningstexter. Källorna skriver samma
// roll på många sätt ("Ordförande", "Ordf", "1:e vice ordförande", "2:e vice
// ordförande", "vice ordf"…), vilket gav en lång lista med i praktiken samma
// befattning i mottagarfiltret. Här slås varje variant ihop till EN baskategori.
//
// Enligt operatörens val: ALLT ordförande-aktigt (inkl. vice ordförande, oavsett
// ordningstal) räknas som "Ordförande". Vill man nå en specifik nivå kombinerar
// man rollen med områdesfiltret (t.ex. Ordförande + EU) — det görs i UI:t, inte
// här. Roller utan känd baskategori behålls som sin egen (städade) text.

export interface CanonicalRole {
  key: string; // stabil nyckel som skickas mellan frontend och backend
  label: string; // visningstext
}

export function canonicalRole(raw: string): CanonicalRole {
  const s = raw.trim().toLowerCase();
  // "ordf" fångar ordförande/ordf/vice ordförande/1:e vice ordförande m.fl.
  if (s.includes("ordf")) return { key: "ordförande", label: "Ordförande" };
  if (s.includes("ledamot") || s.includes("ledamöter")) return { key: "ledamot", label: "Ledamot" };
  if (s.includes("ersätt") || s.includes("supple")) return { key: "ersättare", label: "Ersättare" };
  if (s.includes("gruppledare")) return { key: "gruppledare", label: "Gruppledare" };
  // Okänd baskategori: behåll städad originaltext, nyckel = lower+trim.
  return { key: s, label: raw.trim() };
}

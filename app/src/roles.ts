// Kanonisk normalisering av skrapade befattningstexter. Källorna skriver samma
// roll på många sätt ("Ordförande", "Ordf", "1:e vice ordförande", "led",
// "Lekmannarevisorssuppleant"…) — 109 råa varianter i produktion 2026-07-03.
// Här slås varje variant ihop till EN baskategori (16 st mot samma data).
//
// Enligt operatörens val: ALLT ordförande-aktigt (inkl. vice ordförande, oavsett
// ordningstal) räknas som "Ordförande". Vill man nå en specifik nivå kombinerar
// man rollen med områdesfiltret (t.ex. Ordförande + EU) — det görs i UI:t, inte
// här. Roller utan känd baskategori behålls som sin egen (städade) text.
//
// Ordningen på reglerna är betydelsebärande:
// - vigsel/revisor före ordförande: "Revisor - förtroendevald ordf." är i första
//   hand revisor; "Vigsel- och partnerskapsförrättare" är aldrig beslutfattare.
// - revisor före ersättare: "Lekmannarevisorssuppleant" hör till Revisor,
//   inte Ersättare.
// - ordförande före ledamot: "Ledamot och vice ordförande" -> Ordförande
//   (ordförande-delen väger tyngst per operatörens val).
// - ersättare före ombud: "Ombud ersättare"/"Ersättare till ombud" är i första
//   hand ersättare.

export interface CanonicalRole {
  key: string; // stabil nyckel som skickas mellan frontend och backend
  label: string; // visningstext
}

// "1:e vice"/"2:e vice" utan efterföljande "ordförande" — underförstått vice
// ordförande i källorna.
const VICE_ONLY = /^\d+\s*[:.]?\s*[ae]?\s*vice$/;

const CATEGORIES: { match: (s: string) => boolean; label: string }[] = [
  { match: (s) => s.includes("vigsel"), label: "Vigselförrättare" },
  { match: (s) => s.includes("revisor"), label: "Revisor" },
  { match: (s) => s.includes("ordf") || VICE_ONLY.test(s), label: "Ordförande" },
  { match: (s) => s.includes("gruppledare"), label: "Gruppledare" },
  { match: (s) => s.includes("nämndem"), label: "Nämndeman" },
  { match: (s) => s.includes("ledamot") || s.includes("ledamöter") || s === "led", label: "Ledamot" },
  { match: (s) => s.includes("ersätt") || s.includes("supple") || s === "ers", label: "Ersättare" },
  { match: (s) => s.includes("ombud"), label: "Ombud" },
  { match: (s) => s.includes("god man") || s.includes("gode män"), label: "God man" },
  { match: (s) => s.includes("representant"), label: "Representant" },
];

export function canonicalRole(raw: string): CanonicalRole {
  const s = raw.trim().toLowerCase();
  for (const c of CATEGORIES) {
    if (c.match(s)) return { key: c.label.toLowerCase(), label: c.label };
  }
  // Okänd baskategori: behåll städad originaltext, nyckel = lower+trim.
  return { key: s, label: raw.trim() };
}

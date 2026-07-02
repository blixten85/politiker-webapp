// Escapar text som ska in i en HTML-kropp (mejl eller DOM på serversidan).
// Escapar alla tre tecknen &, <, > — att bara escapa "<" lämnar entiteter
// och vinkelparenteser orörda (ofullständig sanering som CodeQL flaggar).
export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Plockar ut ren text ur en (av oss själv genererad) HTML-sträng, för mejlens
// text/plain-del. Tar bort taggar i en loop tills strängen är stabil — en
// enkel engångs-replace av /<[^>]+>/ kan lämna kvar innehåll vid överlappande
// eller nästlade vinkelparenteser (CodeQL js/incomplete-multi-character-
// sanitization). Loop-tills-stabil är den rekommenderade lösningen.
export function htmlToText(html: string): string {
  let text = html;
  let prev: string;
  do {
    prev = text;
    text = text.replace(/<[^>]*>/g, "");
  } while (text !== prev);
  return text;
}

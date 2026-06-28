// Escapar text som ska in i en HTML-kropp (mejl eller DOM på serversidan).
// Escapar alla tre tecknen &, <, > — att bara escapa "<" lämnar entiteter
// och vinkelparenteser orörda (ofullständig sanering som CodeQL flaggar).
export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

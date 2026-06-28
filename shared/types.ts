// Delade typer mellan app-worker (producent) och sender-worker (konsument).

// OBS: brevkroppen ligger MEDVETET inte i meddelandet — den kan vara stor
// (inline-extraherade bilagor) och skulle annars dupliceras en gång per
// mottagare genom kön. Sender hämtar html_body från letters via send_jobs
// .letter_id, en gång per jobb. Ämnet är litet och får ligga kvar här.
export interface SendJobMessage {
  sendJobId: string;
  accountId: string;
  mailCredentialId: string;
  recipientEmail: string;
  recipientName: string;
  subject?: string;
}

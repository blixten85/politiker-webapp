// Delade typer mellan app-worker (producent) och sender-worker (konsument).

export interface SendJobMessage {
  sendJobId: string;
  accountId: string;
  mailCredentialId: string;
  recipientEmail: string;
  recipientName: string;
  htmlBody: string;
  subject?: string;
}

// Minimal SMTP-klient byggd på Workers' cloudflare:sockets API.
// Skriven själv (inte en extern dependency) eftersom den hanterar
// användarnas riktiga mail-lösenord — ska vara enkel att granska.
//
// Stödjer: STARTTLS (port 587) och direkt TLS (port 465), AUTH LOGIN.
//
// VIKTIGT (hittat i produktion 2026-06-22): innan `socket.startTls()`
// anropas måste den ursprungliga writer/reader-låset släppas med
// `.releaseLock()` — ett `.close()`-anrop håller kvar låset och
// startTls() kastar då "This WritableStream is currently locked to a
// writer". releaseLock(), inte close(), är rätt väg in i TLS-uppgraderingen.

import { connect } from "cloudflare:sockets";
// escapeHtml bor i shared/html.ts; återexporteras här eftersom befintliga
// importörer (campaign/letter-sender, bounce-sweep) hämtar den från smtp.
export { escapeHtml } from "./html";

export interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  fromAddress: string;
}

export class SmtpError extends Error {}

interface SmtpResponse {
  code: number;
  text: string;
}

interface Connection {
  write: (line: string) => Promise<void>;
  read: () => Promise<SmtpResponse>;
  quit: () => Promise<void>;
}

async function openConnection(host: string, port: number): Promise<Connection> {
  const useDirectTls = port === 465;
  let socket = connect({ hostname: host, port }, { secureTransport: useDirectTls ? "on" : "starttls", allowHalfOpen: false });

  let writer = socket.writable.getWriter();
  let reader = socket.readable.getReader();

  const read = () => readSmtpResponse(reader);
  const write = (line: string) => writer.write(new TextEncoder().encode(line + "\r\n"));

  await expect(await read(), 220, "Servern svarade inte med 220 vid anslutning");
  await write(`EHLO politiker.denied.se`);
  await read();

  if (!useDirectTls) {
    await write("STARTTLS");
    await expect(await read(), 220, "STARTTLS nekades av servern");

    // Släpp låset (inte close!) innan TLS-uppgraderingen.
    writer.releaseLock();
    reader.releaseLock();

    socket = await socket.startTls();
    writer = socket.writable.getWriter();
    reader = socket.readable.getReader();

    await write(`EHLO politiker.denied.se`);
    await read();
  }

  const quit = async () => {
    try {
      await write("QUIT");
    } catch {
      /* anslutningen kan redan vara på väg ner */
    }
    try {
      writer.releaseLock();
    } catch {
      /* redan släppt */
    }
  };

  return { write, read, quit };
}

async function authenticate(conn: Connection, config: SmtpConfig): Promise<void> {
  await conn.write("AUTH LOGIN");
  await expect(await conn.read(), 334, "Servern accepterade inte AUTH LOGIN");
  await conn.write(btoa(config.user));
  await expect(await conn.read(), 334, "Användarnamn accepterades inte");
  await conn.write(btoa(config.password));
  const authResp = await conn.read();
  if (authResp.code !== 235) {
    throw new SmtpError(`Inloggning misslyckades (${authResp.code}): ${authResp.text}`);
  }
}

export interface MailAttachment {
  filename: string;
  contentType: string;
  bytes: ArrayBuffer;
}

export async function sendSmtpMail(
  config: SmtpConfig,
  opts: { to: string; subject?: string; html: string; attachments?: MailAttachment[] },
): Promise<void> {
  const conn = await openConnection(config.host, config.port);
  try {
    await authenticate(conn, config);

    await conn.write(`MAIL FROM:<${config.fromAddress}>`);
    await expect(await conn.read(), 250, "MAIL FROM nekades");

    await conn.write(`RCPT TO:<${opts.to}>`);
    const rcptResp = await conn.read();
    if (rcptResp.code !== 250 && rcptResp.code !== 251) {
      throw new SmtpError(`RCPT TO nekades (${rcptResp.code}): ${rcptResp.text}`);
    }

    await conn.write("DATA");
    await expect(await conn.read(), 354, "Servern accepterade inte DATA");

    const message = buildMimeMessage(config.fromAddress, opts.to, opts.subject, opts.html, opts.attachments ?? []);
    const stuffed = message.replace(/\r?\n\./g, "\n.."); // dot-stuffing på hela meddelandet, en gång
    await conn.write(`${stuffed}\r\n.`);
    await expect(await conn.read(), 250, "Mejlet accepterades inte av servern");
  } finally {
    await conn.quit();
  }
}

function buildMimeMessage(
  from: string,
  to: string,
  subject: string | undefined,
  html: string,
  attachments: MailAttachment[],
): string {
  const baseHeaders = [
    `From: ${from}`,
    `To: ${to}`,
    subject ? `Subject: ${encodeHeaderValue(subject)}` : null,
    "MIME-Version: 1.0",
  ].filter((l): l is string => l !== null);

  if (attachments.length === 0) {
    return [...baseHeaders, "Content-Type: text/html; charset=UTF-8", "", html].join("\r\n");
  }

  const boundary = `----politiker-${crypto.randomUUID()}`;
  const parts = [
    [`Content-Type: text/html; charset=UTF-8`, "", html].join("\r\n"),
    ...attachments.map((att) =>
      [
        `Content-Type: ${att.contentType}; name="${att.filename}"`,
        `Content-Disposition: attachment; filename="${att.filename}"`,
        "Content-Transfer-Encoding: base64",
        "",
        wrapBase64(bytesToBase64(att.bytes)),
      ].join("\r\n"),
    ),
  ];

  const body = parts.map((p) => `--${boundary}\r\n${p}`).join("\r\n") + `\r\n--${boundary}--`;
  return [...baseHeaders, `Content-Type: multipart/mixed; boundary="${boundary}"`, "", body].join("\r\n");
}

function bytesToBase64(bytes: ArrayBuffer): string {
  let binary = "";
  for (const b of new Uint8Array(bytes)) binary += String.fromCharCode(b);
  return btoa(binary);
}

function wrapBase64(b64: string): string {
  const lines = [];
  for (let i = 0; i < b64.length; i += 76) lines.push(b64.slice(i, i + 76));
  return lines.join("\r\n");
}

// Testar bara att AUTH lyckas (ingen DATA/sändning) — används när
// användaren lägger till en mailkoppling, för omedelbar feedback.
export async function testSmtpAuth(config: SmtpConfig): Promise<void> {
  const conn = await openConnection(config.host, config.port);
  try {
    await authenticate(conn, config);
  } finally {
    await conn.quit();
  }
}

async function readSmtpResponse(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<SmtpResponse> {
  let buffer = "";
  const decoder = new TextDecoder();
  while (true) {
    const { value, done } = await reader.read();
    if (done) throw new SmtpError("Anslutningen stängdes oväntat");
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\r\n").filter(Boolean);
    const last = lines[lines.length - 1];
    // Sista raden i ett (eventuellt flerradigt) svar har "kod " (mellanslag), inte "kod-"
    if (last && /^\d{3} /.test(last)) {
      const code = parseInt(last.slice(0, 3), 10);
      return { code, text: lines.join("\n") };
    }
  }
}

async function expect(resp: SmtpResponse, expectedCode: number, errorMessage: string): Promise<void> {
  if (resp.code !== expectedCode) {
    throw new SmtpError(`${errorMessage} (fick ${resp.code}: ${resp.text})`);
  }
}

// RFC 2047 "encoded-word" — krävs för att åäö (eller annan icke-ASCII text)
// i header-fält som Subject ska visas rätt, eftersom rå SMTP-headers är
// ASCII-only. Body-texten behöver inte detta (den har sin egen
// Content-Type/charset), bara header-rader som Subject/From-visningsnamn.
export function encodeHeaderValue(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value; // redan rent ASCII, ingen kodning behövs
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return `=?UTF-8?B?${btoa(binary)}?=`;
}

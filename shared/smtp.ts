// Minimal SMTP-klient byggd på Workers' cloudflare:sockets API.
// Skriven själv (inte en extern dependency) eftersom den hanterar
// användarnas riktiga mail-lösenord — ska vara enkel att granska.
//
// Stödjer: STARTTLS (port 587) och direkt TLS (port 465), AUTH LOGIN,
// ett mejl per anrop. Testas mot `wrangler dev --remote` innan skarp drift
// (se planens verifieringssteg) — cloudflare:sockets-detaljer (startTls-
// signatur m.m.) kan skilja sig något mot vad som antagits här.

import { connect } from "cloudflare:sockets";

export interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  fromAddress: string;
}

export class SmtpError extends Error {}

export async function sendSmtpMail(
  config: SmtpConfig,
  opts: { to: string; subject?: string; html: string },
): Promise<void> {
  const useDirectTls = config.port === 465;

  let socket = connect(
    { hostname: config.host, port: config.port },
    { secureTransport: useDirectTls ? "on" : "starttls", allowHalfOpen: false },
  );

  const writer = socket.writable.getWriter();
  const reader = socket.readable.getReader();

  const read = () => readSmtpResponse(reader);
  const write = (line: string) => writer.write(new TextEncoder().encode(line + "\r\n"));

  try {
    await expect(await read(), 220, "Servern svarade inte med 220 vid anslutning");

    await write(`EHLO ${new URL("https://" + config.host).hostname || "politiker.denied.se"}`);
    await read(); // EHLO-svar (kan vara flerradigt, readSmtpResponse hanterar det)

    if (!useDirectTls) {
      await write("STARTTLS");
      await expect(await read(), 220, "STARTTLS nekades av servern");
      socket = await socket.startTls();
      writer.close().catch(() => {});
      const newWriter = socket.writable.getWriter();
      const newReader = socket.readable.getReader();
      await sendAfterStartTls(newWriter, newReader, config, opts);
      return;
    }

    await authenticateAndSend(write, read, config, opts);
  } finally {
    try {
      await writer.close();
    } catch {
      /* redan stängd */
    }
  }
}

async function sendAfterStartTls(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  reader: ReadableStreamDefaultReader<Uint8Array>,
  config: SmtpConfig,
  opts: { to: string; subject?: string; html: string },
): Promise<void> {
  const read = () => readSmtpResponse(reader);
  const write = (line: string) => writer.write(new TextEncoder().encode(line + "\r\n"));

  await write(`EHLO politiker.denied.se`);
  await read();
  await authenticateAndSend(write, read, config, opts);
  await writer.close();
}

async function authenticateAndSend(
  write: (line: string) => Promise<void>,
  read: () => Promise<SmtpResponse>,
  config: SmtpConfig,
  opts: { to: string; subject?: string; html: string },
): Promise<void> {
  await write("AUTH LOGIN");
  await expect(await read(), 334, "Servern accepterade inte AUTH LOGIN");
  await write(btoa(config.user));
  await expect(await read(), 334, "Användarnamn accepterades inte");
  await write(btoa(config.password));
  const authResp = await read();
  if (authResp.code !== 235) {
    throw new SmtpError(`Inloggning misslyckades (${authResp.code}): ${authResp.text}`);
  }

  await write(`MAIL FROM:<${config.fromAddress}>`);
  await expect(await read(), 250, "MAIL FROM nekades");

  await write(`RCPT TO:<${opts.to}>`);
  const rcptResp = await read();
  if (rcptResp.code !== 250 && rcptResp.code !== 251) {
    throw new SmtpError(`RCPT TO nekades (${rcptResp.code}): ${rcptResp.text}`);
  }

  await write("DATA");
  await expect(await read(), 354, "Servern accepterade inte DATA");

  const headers = [
    `From: ${config.fromAddress}`,
    `To: ${opts.to}`,
    opts.subject ? `Subject: ${opts.subject}` : null,
    "MIME-Version: 1.0",
    "Content-Type: text/html; charset=UTF-8",
    "",
  ].filter((l): l is string => l !== null);

  const body = opts.html.replace(/\r?\n\./g, "\n.."); // dot-stuffing
  await write([...headers, body, "."].join("\r\n"));
  await expect(await read(), 250, "Mejlet accepterades inte av servern");

  await write("QUIT");
}

// Testar bara att AUTH lyckas (ingen DATA/sändning) — används när
// användaren lägger till en mailkoppling, för omedelbar feedback.
export async function testSmtpAuth(config: SmtpConfig): Promise<void> {
  const useDirectTls = config.port === 465;
  let socket = connect(
    { hostname: config.host, port: config.port },
    { secureTransport: useDirectTls ? "on" : "starttls", allowHalfOpen: false },
  );
  let writer = socket.writable.getWriter();
  let reader = socket.readable.getReader();
  const read = () => readSmtpResponse(reader);
  const write = (line: string) => writer.write(new TextEncoder().encode(line + "\r\n"));

  try {
    await expect(await read(), 220, "Servern svarade inte vid anslutning");
    await write(`EHLO politiker.denied.se`);
    await read();

    if (!useDirectTls) {
      await write("STARTTLS");
      await expect(await read(), 220, "STARTTLS nekades");
      socket = await socket.startTls();
      writer = socket.writable.getWriter();
      reader = socket.readable.getReader();
      await write(`EHLO politiker.denied.se`);
      await read();
    }

    await write("AUTH LOGIN");
    await expect(await read(), 334, "AUTH LOGIN stöds inte");
    await write(btoa(config.user));
    await expect(await read(), 334, "Användarnamn nekades");
    await write(btoa(config.password));
    const authResp = await read();
    if (authResp.code !== 235) {
      throw new SmtpError(`Felaktiga inloggningsuppgifter (${authResp.code}): ${authResp.text}`);
    }
    await write("QUIT");
  } finally {
    try {
      await writer.close();
    } catch {
      /* redan stängd */
    }
  }
}

interface SmtpResponse {
  code: number;
  text: string;
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

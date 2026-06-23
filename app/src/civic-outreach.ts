import { randomId } from "../../shared/crypto";
import { sendSmtpMail } from "../../shared/smtp";
import type { Env } from "./db";

// Kvartalsvis civilsamhälls-utskick: forskar fram ett aktuellt samhällsämne,
// författar ett brev, och mailar det till en granskare INNAN något skickas.
// Inget går ut förrän draften aktivt godkänts via approve-länken — ingen
// passiv timeout, ingen auto-send.
//
// Granskningsmailet skickas MEDVETET via det dedikerade Outlook-kontot, inte
// plattformens systemmail (denied.se) — hela den här funktionen ska hållas
// helt skild från användarens egen identifierbara adress.
const APPROVAL_NOTIFY_EMAIL = "steedpower3@gmail.com";
const OUTLOOK_SMTP_CONFIG = {
  host: "smtp.office365.com",
  port: 587,
  user: "RichMissile@outlook.com",
  password: "cetjwajmmgsksjgt",
  fromAddress: "RichMissile@outlook.com",
};

export interface CivicLetterDraft {
  id: string;
  subject: string;
  htmlBody: string;
  topicSourceUrl: string | null;
  status: "pending" | "approved" | "rejected" | "sending" | "done";
  approveToken: string;
  createdAt: number;
  approvedAt: number | null;
}

export async function createCivicLetterDraft(
  env: Env,
  fields: { subject: string; htmlBody: string; topicSourceUrl?: string },
): Promise<CivicLetterDraft> {
  const id = randomId();
  const approveToken = randomId() + randomId();
  const now = Date.now();

  await env.DB.prepare(
    `INSERT INTO civic_letter_drafts (id, subject, html_body, topic_source_url, status, approve_token, created_at)
     VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
  )
    .bind(id, fields.subject, fields.htmlBody, fields.topicSourceUrl ?? null, approveToken, now)
    .run();

  return {
    id,
    subject: fields.subject,
    htmlBody: fields.htmlBody,
    topicSourceUrl: fields.topicSourceUrl ?? null,
    status: "pending",
    approveToken,
    createdAt: now,
    approvedAt: null,
  };
}

export async function sendApprovalNotification(draft: CivicLetterDraft): Promise<void> {
  const mail = approvalEmailBody(draft);
  await sendSmtpMail(OUTLOOK_SMTP_CONFIG, { to: mail.to, subject: mail.subject, html: mail.html });
}

export function approvalEmailBody(draft: CivicLetterDraft): { to: string; subject: string; html: string } {
  const approveUrl = `https://politiker.denied.se/api/civic-letter/${draft.id}/approve?token=${draft.approveToken}`;
  const rejectUrl = `https://politiker.denied.se/api/civic-letter/${draft.id}/reject?token=${draft.approveToken}`;
  return {
    to: APPROVAL_NOTIFY_EMAIL,
    subject: `Granska civilsamhälls-brev: ${draft.subject}`,
    html: `
      <p>Ett nytt förslag till kvartalsbrev väntar på ditt godkännande. Inget skickas förrän du klickar "Godkänn".</p>
      ${draft.topicSourceUrl ? `<p>Källa: <a href="${draft.topicSourceUrl}">${draft.topicSourceUrl}</a></p>` : ""}
      <hr>
      <h3>${draft.subject}</h3>
      ${draft.htmlBody}
      <hr>
      <p>
        <a href="${approveUrl}" style="background:#2e7d32;color:#fff;padding:10px 20px;text-decoration:none;border-radius:4px;">Godkänn och skicka</a>
        &nbsp;
        <a href="${rejectUrl}" style="background:#c62828;color:#fff;padding:10px 20px;text-decoration:none;border-radius:4px;">Avslå</a>
      </p>
    `,
  };
}

export async function approveCivicLetterDraft(env: Env, draftId: string, token: string): Promise<void> {
  const draft = await env.DB.prepare("SELECT approve_token, status FROM civic_letter_drafts WHERE id = ?")
    .bind(draftId)
    .first<{ approve_token: string; status: string }>();
  if (!draft || draft.approve_token !== token) throw new Error("Ogiltig eller okänd länk");
  if (draft.status !== "pending") throw new Error(`Redan hanterad (status: ${draft.status})`);

  await env.DB.prepare("UPDATE civic_letter_drafts SET status = 'approved', approved_at = ? WHERE id = ?")
    .bind(Date.now(), draftId)
    .run();
}

export async function rejectCivicLetterDraft(env: Env, draftId: string, token: string): Promise<void> {
  const draft = await env.DB.prepare("SELECT approve_token, status FROM civic_letter_drafts WHERE id = ?")
    .bind(draftId)
    .first<{ approve_token: string; status: string }>();
  if (!draft || draft.approve_token !== token) throw new Error("Ogiltig eller okänd länk");
  if (draft.status !== "pending") throw new Error(`Redan hanterad (status: ${draft.status})`);

  await env.DB.prepare("UPDATE civic_letter_drafts SET status = 'rejected' WHERE id = ?").bind(draftId).run();
}

const ALLOWED_STATUS_TRANSITIONS: Record<"sending" | "done", string> = {
  sending: "approved",
  done: "sending",
};

export async function setCivicLetterStatus(env: Env, draftId: string, status: "sending" | "done"): Promise<void> {
  const requiredCurrentStatus = ALLOWED_STATUS_TRANSITIONS[status];
  const result = await env.DB.prepare("UPDATE civic_letter_drafts SET status = ? WHERE id = ? AND status = ?")
    .bind(status, draftId, requiredCurrentStatus)
    .run();
  if (result.meta.changes === 0) {
    throw new Error(`Ogiltig statusövergång till "${status}" — draften finns inte eller har inte status "${requiredCurrentStatus}"`);
  }
}

export async function getCivicLetterDraft(env: Env, draftId: string): Promise<CivicLetterDraft | null> {
  const row = await env.DB.prepare(
    "SELECT id, subject, html_body, topic_source_url, status, approve_token, created_at, approved_at FROM civic_letter_drafts WHERE id = ?",
  )
    .bind(draftId)
    .first<{
      id: string;
      subject: string;
      html_body: string;
      topic_source_url: string | null;
      status: string;
      approve_token: string;
      created_at: number;
      approved_at: number | null;
    }>();
  if (!row) return null;
  return {
    id: row.id,
    subject: row.subject,
    htmlBody: row.html_body,
    topicSourceUrl: row.topic_source_url,
    status: row.status as CivicLetterDraft["status"],
    approveToken: row.approve_token,
    createdAt: row.created_at,
    approvedAt: row.approved_at,
  };
}

export type CivicLetterDraftPublic = Omit<CivicLetterDraft, "approveToken">;

export function redactApproveToken(draft: CivicLetterDraft): CivicLetterDraftPublic {
  const { approveToken: _approveToken, ...rest } = draft;
  return rest;
}

export async function getApprovedUnsentDraft(env: Env): Promise<CivicLetterDraft | null> {
  const row = await env.DB.prepare(
    "SELECT id, subject, html_body, topic_source_url, status, approve_token, created_at, approved_at FROM civic_letter_drafts WHERE status = 'approved' ORDER BY approved_at ASC LIMIT 1",
  ).first<{
    id: string;
    subject: string;
    html_body: string;
    topic_source_url: string | null;
    status: string;
    approve_token: string;
    created_at: number;
    approved_at: number;
  }>();
  if (!row) return null;
  return {
    id: row.id,
    subject: row.subject,
    htmlBody: row.html_body,
    topicSourceUrl: row.topic_source_url,
    status: row.status as CivicLetterDraft["status"],
    approveToken: row.approve_token,
    createdAt: row.created_at,
    approvedAt: row.approved_at,
  };
}

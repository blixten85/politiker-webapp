import { randomId } from "../../shared/crypto";
import { convertToHtml } from "./document-parsing";
import type { Env } from "./db";

export interface AttachmentInput {
  filename: string;
  contentType: string;
  mode: "attach" | "extract";
  base64Data: string;
}

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10 MB per fil — gott om utrymme för brev/dokument, skydd mot missbruk

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Hanterar uppladdade filer för ett brev: "extract"-läge konverteras direkt
// till HTML och returneras för att läggas till i brevtexten. "attach"-läge
// lagras i R2 och kopplas till letterId — sender-workern hämtar dem vid
// sändning (en gång per utskick, inte en gång per mottagare).
export async function processAttachments(
  env: Env,
  letterId: string,
  attachments: AttachmentInput[],
): Promise<{ extractedHtml: string }> {
  let extractedHtml = "";

  for (const att of attachments) {
    const bytes = base64ToBytes(att.base64Data);
    if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
      throw new Error(`${att.filename} är större än 10 MB — för stort.`);
    }

    if (att.mode === "extract") {
      const html = await convertToHtml(att.filename, att.contentType, bytes.buffer as ArrayBuffer);
      extractedHtml += `\n<hr>\n${html}`;
    }

    const r2Key = `${letterId}/${randomId()}-${att.filename}`;
    await env.ATTACHMENTS.put(r2Key, bytes, { httpMetadata: { contentType: att.contentType } });
    await env.DB.prepare(
      `INSERT INTO letter_attachments (id, letter_id, filename, content_type, r2_key, size_bytes, mode, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(randomId(), letterId, att.filename, att.contentType, r2Key, bytes.byteLength, att.mode, Date.now())
      .run();
  }

  return { extractedHtml };
}

export async function getAttachmentsForSending(
  env: Env,
  letterId: string,
): Promise<Array<{ filename: string; contentType: string; bytes: ArrayBuffer }>> {
  const { results } = await env.DB.prepare(
    "SELECT filename, content_type, r2_key FROM letter_attachments WHERE letter_id = ? AND mode = 'attach'",
  )
    .bind(letterId)
    .all<{ filename: string; content_type: string; r2_key: string }>();

  const attachments = [];
  for (const row of results) {
    const obj = await env.ATTACHMENTS.get(row.r2_key);
    if (!obj) continue; // borttagen/utgången — skippa snarare än krascha hela utskicket
    attachments.push({ filename: row.filename, contentType: row.content_type, bytes: await obj.arrayBuffer() });
  }
  return attachments;
}

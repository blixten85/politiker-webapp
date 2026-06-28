// Konverterar uppladdade dokument till HTML-brevtext ("extract"-läge).
// .doc (gamla binära Word-formatet) stöds INTE — inget rimligt lättviktigt
// bibliotek finns för det; sådana filer kan bara bifogas, inte konverteras.

import { escapeHtml } from "../../shared/html";

export async function convertToHtml(filename: string, contentType: string, bytes: ArrayBuffer): Promise<string> {
  const ext = filename.toLowerCase().split(".").pop();

  if (ext === "txt" || contentType === "text/plain") {
    const text = new TextDecoder().decode(bytes);
    return text
      .split(/\r?\n\r?\n/)
      .map((para) => `<p>${escapeHtml(para).replace(/\r?\n/g, "<br>")}</p>`)
      .join("\n");
  }

  if (ext === "docx" || contentType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    const mammoth = await import("mammoth");
    const result = await mammoth.convertToHtml({ arrayBuffer: bytes });
    return result.value;
  }

  if (ext === "pdf" || contentType === "application/pdf") {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const { text } = await extractText(pdf, { mergePages: true });
    return text
      .split(/\n{2,}/)
      .map((para) => `<p>${escapeHtml(para).replace(/\n/g, "<br>")}</p>`)
      .join("\n");
  }

  if (ext === "doc") {
    throw new Error(
      "Gamla .doc-formatet (innan Word 2007) kan inte konverteras till brevtext automatiskt — spara om filen som .docx, eller bifoga den som bilaga istället.",
    );
  }

  throw new Error(`Filtypen .${ext} kan inte konverteras till brevtext.`);
}

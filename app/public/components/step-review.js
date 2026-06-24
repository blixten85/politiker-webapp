// Steg 3: granska & skicka. Rent presentationslager — bygger en
// sammanfattning av redan insamlad state (mottagarantal, valda nivåer,
// ämne, brevförhandsgranskning). Själva skicka-knappen/anropet ägs av
// app.js (samma /api/send-logik som tidigare, oförändrad).

export function renderReview(container, { recipientCount, typeLabels, subject, bodyHtml, t }) {
  container.innerHTML = "";

  const summary = document.createElement("div");
  summary.className = "review-summary";

  const countRow = document.createElement("p");
  countRow.className = "review-count";
  countRow.textContent = t("review_recipient_count", { count: recipientCount });
  summary.appendChild(countRow);

  if (typeLabels.length > 0) {
    const typesRow = document.createElement("p");
    typesRow.className = "hint";
    typesRow.textContent = t("review_levels", { levels: typeLabels.join(", ") });
    summary.appendChild(typesRow);
  }

  const subjectRow = document.createElement("p");
  subjectRow.innerHTML = `<strong>${t("review_subject_label")}:</strong> ${subject ? escapeHtml(subject) : t("review_no_subject")}`;
  summary.appendChild(subjectRow);

  const previewLabel = document.createElement("p");
  previewLabel.className = "hint";
  previewLabel.textContent = t("review_body_preview_label");
  summary.appendChild(previewLabel);

  const preview = document.createElement("div");
  preview.className = "review-body-preview card";
  preview.innerHTML = bodyHtml || `<em>${t("review_no_body")}</em>`;
  summary.appendChild(preview);

  container.appendChild(summary);
}

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

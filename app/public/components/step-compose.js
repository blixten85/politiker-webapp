// Steg 2: skrivläget. Subject/textarea/AI-utkast är enkla fält i
// index.html med befintlig logik kvar i app.js. Den här modulen äger
// bygglogiken för bifogade-filer-listan (attach/extract-läge per fil) —
// flyttad rakt av från den tidigare inline-koden i app.js, oförändrad
// logik, bara fysiskt flyttad hit.

export function renderFileModeList(container, files, { t }) {
  container.innerHTML = "";
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const row = document.createElement("div");
    const isDoc = file.name.toLowerCase().endsWith(".doc");
    const modeName = `mode-${i}-${file.name}`;

    const span = document.createElement("span");
    span.textContent = `${file.name} (${(file.size / 1024).toFixed(0)} KB)`;

    const attachLabel = document.createElement("label");
    const attachInput = document.createElement("input");
    attachInput.type = "radio";
    attachInput.name = modeName;
    attachInput.value = "attach";
    attachInput.checked = true;
    attachLabel.appendChild(attachInput);
    attachLabel.append(" " + t("btn_attach"));

    const extractLabel = document.createElement("label");
    const extractInput = document.createElement("input");
    extractInput.type = "radio";
    extractInput.name = modeName;
    extractInput.value = "extract";
    extractInput.disabled = isDoc;
    extractLabel.appendChild(extractInput);
    extractLabel.append(` ${t("btn_use_as_text")}${isDoc ? t("hint_not_possible_for_doc") : ""}`);

    row.appendChild(span);
    row.appendChild(attachLabel);
    row.appendChild(extractLabel);
    container.appendChild(row);
  }
}

function providerHelp(provider) {
  return t(`provider_help_${provider}`);
}

let pendingAccountId = null;
let selectedAreas = new Set();
let allAreas = [];

// Tema: mörkt som standard, växlingsbart till ljust/system, sparas lokalt.
const THEME_ORDER = ["dark", "light", "system"];

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  document.getElementById("theme-toggle").textContent = t(`theme_${theme}`);
}

function initTheme() {
  const saved = localStorage.getItem("theme") || "dark";
  applyTheme(saved);
}

document.getElementById("theme-toggle").addEventListener("click", () => {
  const current = document.documentElement.getAttribute("data-theme") || "dark";
  const next = THEME_ORDER[(THEME_ORDER.indexOf(current) + 1) % THEME_ORDER.length];
  localStorage.setItem("theme", next);
  applyTheme(next);
});

initI18n();
initTheme();

// Automatisk felrapportering: riktiga JS-fel (buggar) skickas till
// /api/feedback utan att användaren behöver agera debug-verktyg. Fungerar
// utan inloggning (endpointen kräver inte session). Användarens egna
// hanterade meddelanden (fel lösenord, validering m.m.) rapporteras INTE
// automatiskt — bara oväntade undantag.
let lastAutoReportAt = 0;
async function autoReportError(message, extra = {}) {
  const now = Date.now();
  if (now - lastAutoReportAt < 5000) return; // undvik spam vid upprepade fel
  lastAutoReportAt = now;
  try {
    await fetch("/api/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: `[Auto-rapport] ${message}`,
        context: { url: location.href, userAgent: navigator.userAgent, ...extra },
      }),
    });
    showToast(t("msg_auto_error_reported"));
  } catch {
    // Om till och med felrapporteringen misslyckas finns inget mer att göra klientsidan.
  }
}

window.addEventListener("error", (e) => {
  autoReportError(e.message, { stack: e.error?.stack });
});
window.addEventListener("unhandledrejection", (e) => {
  autoReportError(String(e.reason?.message ?? e.reason), { stack: e.reason?.stack });
});

function showToast(text) {
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = text;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 6000);
}

async function api(path, opts = {}) {
  const resp = await fetch(path, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers ?? {}) },
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error ?? t("msg_generic_error"));
  return data;
}

document.getElementById("signup-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  try {
    const result = await api("/api/signup", {
      method: "POST",
      body: JSON.stringify({ email: fd.get("email"), password: fd.get("password") }),
    });
    pendingAccountId = result.accountId;
    document.getElementById("verify-card").hidden = false;
    document.getElementById("signup-msg").textContent = t("msg_signup_success");
  } catch (err) {
    document.getElementById("signup-msg").textContent = err.message;
  }
});

document.getElementById("verify-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  try {
    await api("/api/verify", { method: "POST", body: JSON.stringify({ accountId: pendingAccountId, code: fd.get("code") }) });
    document.getElementById("verify-msg").textContent = t("msg_verify_success");
  } catch (err) {
    document.getElementById("verify-msg").textContent = err.message;
  }
});

document.getElementById("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const msg = document.getElementById("login-msg");
  try {
    await api("/api/login", {
      method: "POST",
      body: JSON.stringify({ email: fd.get("email"), password: fd.get("password"), totpCode: fd.get("totpCode") || undefined }),
    });
    showApp();
  } catch (err) {
    if (err.message === "TOTP_REQUIRED") {
      document.getElementById("login-totp").hidden = false;
      msg.textContent = t("msg_totp_required");
    } else {
      msg.textContent = err.message;
    }
  }
});

document.getElementById("forgot-password-btn").addEventListener("click", () => {
  document.getElementById("forgot-password-card").hidden = false;
});

document.getElementById("forgot-password-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const msg = document.getElementById("forgot-password-msg");
  try {
    await api("/api/request-password-reset", { method: "POST", body: JSON.stringify({ email: fd.get("email") }) });
    msg.textContent = t("msg_reset_link_sent");
  } catch (err) {
    msg.textContent = err.message;
  }
});

document.getElementById("reset-password-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const msg = document.getElementById("reset-password-msg");
  const token = new URLSearchParams(location.search).get("reset");
  try {
    await api("/api/reset-password", { method: "POST", body: JSON.stringify({ token, newPassword: fd.get("newPassword") }) });
    msg.textContent = t("msg_password_changed");
    history.replaceState(null, "", "/");
  } catch (err) {
    msg.textContent = err.message;
  }
});

document.getElementById("logout-btn").addEventListener("click", async () => {
  await api("/api/logout", { method: "POST" });
  location.reload();
});

document.getElementById("set-password-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const msg = document.getElementById("set-password-msg");
  try {
    await api("/api/set-password", { method: "POST", body: JSON.stringify({ newPassword: fd.get("newPassword") }) });
    msg.textContent = t("msg_password_saved");
    e.target.reset();
  } catch (err) {
    msg.textContent = err.message;
  }
});

document.getElementById("provider-select").addEventListener("change", (e) => {
  document.getElementById("generic-fields").hidden = e.target.value !== "generic";
  document.getElementById("provider-help").textContent = providerHelp(e.target.value) ?? "";
});

document.getElementById("add-credential-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const msg = document.getElementById("credential-msg");
  msg.textContent = t("msg_testing_credential");
  try {
    await api("/api/mail-credentials", {
      method: "POST",
      body: JSON.stringify({
        provider: fd.get("provider"),
        host: fd.get("host") || undefined,
        port: fd.get("port") ? parseInt(fd.get("port"), 10) : undefined,
        user: fd.get("user"),
        password: fd.get("password"),
        fromAddress: fd.get("fromAddress"),
      }),
    });
    msg.textContent = t("msg_credential_connected");
    e.target.reset();
    loadMailCredentials();
  } catch (err) {
    msg.textContent = t("msg_failed_prefix", { error: err.message });
  }
});

async function loadMailCredentials() {
  const list = await api("/api/mail-credentials");
  const ul = document.getElementById("mail-credentials-list");
  ul.innerHTML = "";
  for (const c of list) {
    const li = document.createElement("li");
    const capText = c.daily_cap ? t("msg_daily_cap_suffix", { cap: c.daily_cap }) : "";
    li.textContent = `${c.from_address} (${c.provider}${capText}) `;
    const del = document.createElement("button");
    del.textContent = t("btn_remove");
    del.onclick = async () => {
      await api(`/api/mail-credentials/${c.id}`, { method: "DELETE" });
      loadMailCredentials();
    };
    li.appendChild(del);
    ul.appendChild(li);
  }
  return list;
}

async function loadAreas() {
  allAreas = await api("/api/areas");
  renderAreas();
}

function renderAreas() {
  const filter = document.getElementById("area-filter").value.toLowerCase();
  const div = document.getElementById("area-list");
  div.innerHTML = "";
  for (const a of allAreas.filter((a) => a.area_name.toLowerCase().includes(filter))) {
    const label = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = selectedAreas.has(a.area_name);
    cb.onchange = () => {
      if (cb.checked) selectedAreas.add(a.area_name);
      else selectedAreas.delete(a.area_name);
    };
    label.appendChild(cb);
    label.append(` ${a.area_name} (${a.area_type})`);
    div.appendChild(label);
  }
}
document.getElementById("area-filter").addEventListener("input", renderAreas);

document.getElementById("letter-files").addEventListener("change", (e) => {
  const container = document.getElementById("file-mode-list");
  container.innerHTML = "";
  for (let i = 0; i < e.target.files.length; i++) {
    const file = e.target.files[i];
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
});

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// Skydd mot förlorat brev: varna innan sidan stängs/laddas om så länge
// brevtexten inte är tom och inte just skickades iväg.
let letterUnsaved = false;
document.getElementById("letter-body").addEventListener("input", (e) => {
  letterUnsaved = e.target.value.trim().length > 0;
});
window.addEventListener("beforeunload", (e) => {
  if (letterUnsaved) {
    e.preventDefault();
    e.returnValue = "";
  }
});

function setSendProgress(fraction) {
  const bar = document.getElementById("send-progress");
  const fill = document.getElementById("send-progress-fill");
  if (fraction === null) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  fill.style.width = `${Math.round(fraction * 100)}%`;
}

document.getElementById("send-btn").addEventListener("click", async () => {
  const msg = document.getElementById("send-msg");
  const sendBtn = document.getElementById("send-btn");
  const credentials = await loadMailCredentials();
  if (credentials.length === 0) {
    msg.textContent = t("msg_connect_mail_first");
    return;
  }
  if (selectedAreas.size === 0) {
    msg.textContent = t("msg_select_area_first");
    return;
  }
  const html = document.getElementById("letter-body").value;
  const subject = document.getElementById("letter-subject").value;
  if (!html.trim()) {
    msg.textContent = t("msg_write_letter_first");
    return;
  }

  sendBtn.disabled = true;
  setSendProgress(0.02);
  try {
    const files = [...document.getElementById("letter-files").files];
    const attachments = [];
    if (files.length > 0) {
      msg.textContent = t("msg_processing_files");
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const mode = document.querySelector(`input[name="mode-${i}-${file.name}"]:checked`).value;
        const base64Data = await fileToBase64(file);
        attachments.push({ filename: file.name, contentType: file.type || "application/octet-stream", mode, base64Data });
        setSendProgress(0.1 + 0.4 * ((i + 1) / files.length));
      }
    }

    msg.textContent = t("msg_sending");
    setSendProgress(0.7);
    const result = await api("/api/send", {
      method: "POST",
      body: JSON.stringify({
        letterHtml: html,
        subject: subject || undefined,
        mailCredentialId: credentials[0].id,
        areaNames: [...selectedAreas],
        attachments: attachments.length > 0 ? attachments : undefined,
      }),
    });
    setSendProgress(1);
    letterUnsaved = false;
    msg.textContent = t("msg_sending_to_n", { n: result.totalRecipients });
    loadSendJobs();
  } catch (err) {
    msg.textContent = t("msg_failed_prefix", { error: err.message });
  } finally {
    sendBtn.disabled = false;
    setTimeout(() => setSendProgress(null), 800);
  }
});

async function loadSendJobs() {
  const jobs = await api("/api/send-jobs");
  const ul = document.getElementById("send-jobs-list");
  ul.innerHTML = "";
  for (const j of jobs) {
    const li = document.createElement("li");
    li.textContent = t("msg_sendjob_status", {
      date: new Date(j.created_at).toLocaleString(currentLocale()),
      sent: j.sent_count,
      total: j.total_recipients,
      bounce: j.bounce_count,
      status: j.status,
    });
    ul.appendChild(li);
  }
}

document.getElementById("totp-setup-btn").addEventListener("click", async () => {
  const msg = document.getElementById("totp-msg");
  try {
    const { secret, authUri } = await api("/api/totp/setup", { method: "POST" });
    document.getElementById("totp-secret").textContent = secret;
    document.getElementById("totp-disabled-view").hidden = true;
    document.getElementById("totp-setup-view").hidden = false;
    msg.textContent = "";
    console.log("TOTP auth URI (för manuell otpauth-länk om du vill):", authUri);
  } catch (err) {
    msg.textContent = err.message;
  }
});

document.getElementById("totp-confirm-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const msg = document.getElementById("totp-msg");
  try {
    await api("/api/totp/confirm", { method: "POST", body: JSON.stringify({ code: fd.get("code") }) });
    document.getElementById("totp-setup-view").hidden = true;
    document.getElementById("totp-enabled-view").hidden = false;
    msg.textContent = t("msg_totp_enabled");
  } catch (err) {
    msg.textContent = err.message;
  }
});

document.getElementById("totp-disable-btn").addEventListener("click", async () => {
  await api("/api/totp/disable", { method: "POST" });
  document.getElementById("totp-enabled-view").hidden = true;
  document.getElementById("totp-disabled-view").hidden = false;
});

async function loadApiKeys() {
  const keys = await api("/api/api-keys");
  const ul = document.getElementById("api-keys-list");
  ul.innerHTML = "";
  for (const k of keys) {
    const li = document.createElement("li");
    const lastUsed = k.last_used_at ? new Date(k.last_used_at).toLocaleString(currentLocale()) : t("never_used");
    li.textContent = t("msg_apikey_row", {
      name: k.name,
      created: new Date(k.created_at).toLocaleDateString(currentLocale()),
      lastUsed,
    }) + " ";
    const del = document.createElement("button");
    del.textContent = t("btn_revoke");
    del.onclick = async () => {
      await api(`/api/api-keys/${k.id}`, { method: "DELETE" });
      loadApiKeys();
    };
    li.appendChild(del);
    ul.appendChild(li);
  }
}

document.getElementById("create-api-key-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const msg = document.getElementById("api-key-msg");
  try {
    const result = await api("/api/api-keys", { method: "POST", body: JSON.stringify({ name: fd.get("name") }) });
    msg.textContent = t("msg_new_apikey", { key: result.key });
    e.target.reset();
    loadApiKeys();
  } catch (err) {
    msg.textContent = err.message;
  }
});

async function loadAdminPanel() {
  const accounts = await api("/api/admin/accounts");
  const accUl = document.getElementById("admin-accounts-list");
  accUl.innerHTML = "";
  for (const a of accounts) {
    const li = document.createElement("li");
    li.textContent = t("msg_admin_account_row", {
      email: a.email,
      adminSuffix: a.is_admin ? t("admin_suffix") : "",
      verified: a.email_verified ? t("yes_label") : t("no_label"),
      cap: a.daily_send_cap,
    });
    accUl.appendChild(li);
  }

  const feedback = await api("/api/admin/feedback");
  const fbUl = document.getElementById("admin-feedback-list");
  fbUl.innerHTML = "";
  for (const f of feedback) {
    const li = document.createElement("li");
    li.textContent = t("msg_admin_feedback_row", { date: new Date(f.created_at).toLocaleString(currentLocale()), message: f.message });
    fbUl.appendChild(li);
  }
}

function openFeedbackDialog(type) {
  document.getElementById("feedback-type").value = type;
  document.getElementById("feedback-dialog-title").textContent = type === "contact" ? t("feedback_title_contact") : t("feedback_title_bug");
  document.getElementById("feedback-replyto").hidden = type !== "contact";
  document.getElementById("feedback-dialog").showModal();
}
document.getElementById("feedback-btn").addEventListener("click", () => openFeedbackDialog("bug"));
document.getElementById("contact-btn").addEventListener("click", () => openFeedbackDialog("contact"));
document.getElementById("feedback-cancel").addEventListener("click", () => document.getElementById("feedback-dialog").close());
document.getElementById("feedback-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  await api("/api/feedback", {
    method: "POST",
    body: JSON.stringify({
      message: fd.get("message"),
      type: fd.get("type"),
      replyTo: fd.get("replyTo") || undefined,
      context: { url: location.href },
    }),
  });
  document.getElementById("feedback-dialog").close();
  e.target.reset();
});

document.getElementById("faq-btn").addEventListener("click", () => document.getElementById("faq-dialog").showModal());
document.getElementById("faq-close").addEventListener("click", () => document.getElementById("faq-dialog").close());

async function showApp() {
  document.getElementById("auth-view").hidden = true;
  document.getElementById("app-view").hidden = false;
  document.getElementById("logout-btn").hidden = false;
  const me = await api("/api/me");
  if (me.totpEnabled) {
    document.getElementById("totp-disabled-view").hidden = true;
    document.getElementById("totp-enabled-view").hidden = false;
  }
  const tasks = [loadMailCredentials(), loadAreas(), loadSendJobs(), loadApiKeys()];
  if (me.isAdmin) {
    document.getElementById("admin-card").hidden = false;
    tasks.push(loadAdminPanel());
  }
  await Promise.all(tasks);
}

document.addEventListener("languagechange", () => {
  if (!document.getElementById("app-view").hidden) {
    loadMailCredentials();
    renderAreas();
    loadSendJobs();
    loadApiKeys();
    if (!document.getElementById("admin-card").hidden) loadAdminPanel();
  }
});

(async function init() {
  const resetToken = new URLSearchParams(location.search).get("reset");
  if (resetToken) {
    document.getElementById("reset-password-card").hidden = false;
  }

  const me = await api("/api/me");
  if (me.loggedIn) showApp();
})();

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

let providerCeilings = null;
async function loadProviderCeilings() {
  if (!providerCeilings) providerCeilings = await api("/api/provider-ceilings");
  return providerCeilings;
}

function resolveCapPctChoice() {
  const choice = document.getElementById("cap-pct-select").value;
  if (choice !== "custom") return parseInt(choice, 10);
  const custom = parseInt(document.getElementById("cap-pct-custom-input").value, 10);
  return Math.min(100, Math.max(1, Number.isFinite(custom) ? custom : 100));
}

async function updateCapPreview() {
  const provider = document.getElementById("provider-select").value;
  const ceilings = await loadProviderCeilings();
  const info = ceilings[provider];
  const preview = document.getElementById("cap-pct-preview");
  if (!info || info.ceiling === null) {
    preview.textContent = t("msg_cap_preview_unknown");
    return;
  }
  const pct = resolveCapPctChoice();
  const cap = Math.max(1, Math.floor(info.ceiling * (pct / 100)));
  preview.textContent = t("msg_cap_preview", { ceiling: info.ceiling, limit: info.providerDailyLimit, pct, cap });
}

document.getElementById("provider-select").addEventListener("change", (e) => {
  document.getElementById("generic-fields").hidden = e.target.value !== "generic";
  document.getElementById("provider-help").textContent = providerHelp(e.target.value) ?? "";
  updateCapPreview();
});
document.getElementById("cap-pct-select").addEventListener("change", (e) => {
  document.getElementById("cap-pct-custom-input").hidden = e.target.value !== "custom";
  updateCapPreview();
});
document.getElementById("cap-pct-custom-input").addEventListener("input", updateCapPreview);

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
        userCapPct: resolveCapPctChoice(),
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
    const textSpan = document.createElement("span");
    textSpan.textContent = `${c.from_address} (${c.provider}${capText}) `;
    li.appendChild(textSpan);

    if (c.daily_cap !== null && c.daily_cap !== undefined) {
      const row = document.createElement("span");
      row.className = "cred-cap-row";
      const select = document.createElement("select");
      for (const pct of [100, 75, 50, 25]) {
        const opt = document.createElement("option");
        opt.value = pct;
        opt.textContent = pct + "%";
        if (c.user_cap_pct === pct) opt.selected = true;
        select.appendChild(opt);
      }
      if (![100, 75, 50, 25].includes(c.user_cap_pct)) {
        const opt = document.createElement("option");
        opt.value = c.user_cap_pct;
        opt.textContent = c.user_cap_pct + "%";
        opt.selected = true;
        select.appendChild(opt);
      }
      select.onchange = async () => {
        const result = await api(`/api/mail-credentials/${c.id}/cap-pct`, {
          method: "POST",
          body: JSON.stringify({ userCapPct: parseInt(select.value, 10) }),
        });
        showToast(t("msg_cap_updated", { cap: result.dailyCap, pct: select.value }));
        loadMailCredentials();
      };
      row.appendChild(select);
      li.appendChild(row);
    }

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

const OAUTH_LINK_PROVIDERS = ["google", "github", "microsoft"];

async function loadOAuthIdentities() {
  const linked = await api("/api/oauth-identities");
  const div = document.getElementById("oauth-identities-list");
  div.innerHTML = "";
  for (const provider of OAUTH_LINK_PROVIDERS) {
    const row = document.createElement("p");
    row.textContent = provider.charAt(0).toUpperCase() + provider.slice(1) + ": ";
    if (linked.includes(provider)) {
      const span = document.createElement("span");
      span.textContent = t("oauth_linked") + " ";
      const unlink = document.createElement("button");
      unlink.textContent = t("btn_unlink");
      unlink.onclick = async () => {
        const msg = document.getElementById("oauth-identities-msg");
        try {
          await api(`/api/oauth-identities/${provider}`, { method: "DELETE" });
          msg.textContent = "";
          loadOAuthIdentities();
        } catch (err) {
          msg.textContent = err.message;
        }
      };
      row.appendChild(span);
      row.appendChild(unlink);
    } else {
      const link = document.createElement("a");
      link.href = `/api/oauth-link/${provider}/start`;
      link.textContent = t("btn_link");
      row.appendChild(link);
    }
    div.appendChild(row);
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

let adminStatsRaw = null;

async function loadAdminPanel() {
  await Promise.all([loadAdminAccounts(), loadAdminFeedback(), loadAdminStats()]);
}

async function loadAdminAccounts() {
  const accounts = await api("/api/admin/accounts");
  const tbody = document.getElementById("admin-accounts-list");
  tbody.innerHTML = "";
  for (const a of accounts) {
    const tr = document.createElement("tr");

    const tdEmail = document.createElement("td");
    tdEmail.textContent = a.email;
    tr.appendChild(tdEmail);

    const tdBadges = document.createElement("td");
    const verifiedBadge = document.createElement("span");
    verifiedBadge.className = "admin-badge " + (a.email_verified ? "ok" : "warn");
    verifiedBadge.textContent = a.email_verified ? t("admin_verified_yes") : t("admin_verified_no");
    tdBadges.appendChild(verifiedBadge);
    if (a.is_admin) {
      const adminBadge = document.createElement("span");
      adminBadge.className = "admin-badge ok";
      adminBadge.textContent = t("admin_admin_badge");
      tdBadges.appendChild(adminBadge);
    }
    if (a.disabled) {
      const disabledBadge = document.createElement("span");
      disabledBadge.className = "admin-badge danger";
      disabledBadge.textContent = t("admin_disabled_badge");
      tdBadges.appendChild(disabledBadge);
    }
    tr.appendChild(tdBadges);

    const tdCap = document.createElement("td");
    tdCap.textContent = a.daily_send_cap;
    tr.appendChild(tdCap);

    const tdActions = document.createElement("td");
    const resetBtn = document.createElement("button");
    resetBtn.textContent = t("btn_reset_password");
    resetBtn.onclick = async () => {
      await api(`/api/admin/accounts/${a.id}/reset-password`, { method: "POST" });
      showToast(t("msg_reset_password_sent", { email: a.email }));
    };
    tdActions.appendChild(resetBtn);

    const toggleBtn = document.createElement("button");
    toggleBtn.textContent = a.disabled ? t("btn_enable_account") : t("btn_disable_account");
    toggleBtn.onclick = async () => {
      const confirmMsg = a.disabled
        ? t("confirm_enable_account", { email: a.email })
        : t("confirm_disable_account", { email: a.email });
      if (!confirm(confirmMsg)) return;
      await api(`/api/admin/accounts/${a.id}/toggle-disabled`, {
        method: "POST",
        body: JSON.stringify({ disabled: !a.disabled }),
      });
      loadAdminAccounts();
    };
    tdActions.appendChild(toggleBtn);
    tr.appendChild(tdActions);

    tbody.appendChild(tr);
  }
}

async function loadAdminFeedback() {
  const feedback = await api("/api/admin/feedback");
  const fbUl = document.getElementById("admin-feedback-list");
  fbUl.innerHTML = "";
  for (const f of feedback) {
    const li = document.createElement("li");
    li.textContent = t("msg_admin_feedback_row", { date: new Date(f.created_at).toLocaleString(currentLocale()), message: f.message });
    fbUl.appendChild(li);
  }
}

async function loadAdminStats() {
  adminStatsRaw = await api("/api/admin/stats");

  const totalsDiv = document.getElementById("admin-stats-totals");
  totalsDiv.innerHTML = "";
  const boxes = [
    [t("stat_total_accounts"), adminStatsRaw.totalAccounts],
    [t("stat_total_letters"), adminStatsRaw.totalLetters],
    [t("stat_total_sent"), adminStatsRaw.totalSent],
    [t("stat_total_bounced"), adminStatsRaw.totalBounced],
  ];
  for (const [label, n] of boxes) {
    const box = document.createElement("div");
    box.className = "stat-box";
    box.innerHTML = `<span class="n">${n}</span><span class="l">${label}</span>`;
    totalsDiv.appendChild(box);
  }

  const years = [...new Set(adminStatsRaw.dailySeries.map((d) => d.day.slice(0, 4)))].sort();
  const yearSelect = document.getElementById("admin-stats-year");
  yearSelect.innerHTML = "";
  const allYearsOpt = document.createElement("option");
  allYearsOpt.value = "";
  allYearsOpt.textContent = "—";
  yearSelect.appendChild(allYearsOpt);
  for (const y of years) {
    const opt = document.createElement("option");
    opt.value = y;
    opt.textContent = y;
    yearSelect.appendChild(opt);
  }

  const monthSelect = document.getElementById("admin-stats-month");
  if (monthSelect.options.length === 1) {
    for (let m = 1; m <= 12; m++) {
      const mm = String(m).padStart(2, "0");
      const opt = document.createElement("option");
      opt.value = mm;
      opt.textContent = mm;
      monthSelect.appendChild(opt);
    }
  }

  const leaderboardTbody = document.getElementById("admin-leaderboard-list");
  leaderboardTbody.innerHTML = "";
  for (const row of adminStatsRaw.leaderboard) {
    if (row.sentCount === 0) continue;
    const tr = document.createElement("tr");
    const tdEmail = document.createElement("td");
    tdEmail.textContent = row.email;
    const tdCount = document.createElement("td");
    tdCount.textContent = row.sentCount;
    tr.appendChild(tdEmail);
    tr.appendChild(tdCount);
    leaderboardTbody.appendChild(tr);
  }

  renderStatsChart();
}

function bucketKey(day, granularity) {
  // day är "YYYY-MM-DD"
  if (granularity === "day") return day;
  if (granularity === "month") return day.slice(0, 7);
  if (granularity === "year") return day.slice(0, 4);
  // week: ISO-veckonummer, approximerat utan extra bibliotek
  const d = new Date(day + "T00:00:00Z");
  const onejan = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - onejan) / 86400000 + onejan.getUTCDay() + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function renderStatsChart() {
  if (!adminStatsRaw) return;
  const granularity = document.getElementById("admin-stats-granularity").value;
  const yearFilter = document.getElementById("admin-stats-year").value;
  const monthFilter = document.getElementById("admin-stats-month").value;

  let series = adminStatsRaw.dailySeries;
  if (yearFilter) series = series.filter((d) => d.day.slice(0, 4) === yearFilter);
  if (monthFilter) series = series.filter((d) => d.day.slice(5, 7) === monthFilter);

  const buckets = new Map();
  for (const { day, sent } of series) {
    const key = bucketKey(day, granularity);
    buckets.set(key, (buckets.get(key) || 0) + sent);
  }
  const keys = [...buckets.keys()].sort().slice(-60); // visa max 60 senaste staplarna
  const values = keys.map((k) => buckets.get(k));

  const canvas = document.getElementById("admin-stats-chart");
  const ctx = canvas.getContext("2d");
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  if (keys.length === 0) return;

  const max = Math.max(...values, 1);
  const padding = 24;
  const barAreaW = w - padding * 2;
  const barW = barAreaW / keys.length;
  const accentColor = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#006aa7";

  ctx.fillStyle = accentColor;
  for (let i = 0; i < keys.length; i++) {
    const barH = (values[i] / max) * (h - padding * 2);
    ctx.fillRect(padding + i * barW + 1, h - padding - barH, Math.max(barW - 2, 1), barH);
  }

  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--hint").trim() || "#9aa0a8";
  ctx.font = "10px sans-serif";
  ctx.fillText(String(max), 2, padding);
  ctx.fillText(keys[0], padding, h - 4);
  if (keys.length > 1) {
    const lastLabel = keys[keys.length - 1];
    ctx.fillText(lastLabel, w - padding - ctx.measureText(lastLabel).width, h - 4);
  }
}

document.getElementById("admin-stats-granularity").addEventListener("change", renderStatsChart);
document.getElementById("admin-stats-year").addEventListener("change", renderStatsChart);
document.getElementById("admin-stats-month").addEventListener("change", renderStatsChart);

document.querySelectorAll(".admin-tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".admin-tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".admin-tab-panel").forEach((p) => (p.hidden = true));
    btn.classList.add("active");
    document.getElementById(`admin-tab-${btn.dataset.tab}`).hidden = false;
  });
});
document.querySelector('.admin-tab-btn[data-tab="accounts"]').classList.add("active");

function downloadExport(section, format) {
  window.location.href = `/api/admin/export?section=${section}&format=${format}`;
}
document.getElementById("admin-export-accounts-btn").addEventListener("click", () => downloadExport("accounts", "csv"));
document.getElementById("admin-export-feedback-btn").addEventListener("click", () => downloadExport("feedback", "csv"));
document.getElementById("admin-export-stats-btn").addEventListener("click", () => downloadExport("stats", "csv"));
document.getElementById("admin-export-politicians-btn").addEventListener("click", () => downloadExport("politicians", "csv"));
document.getElementById("admin-export-all-btn").addEventListener("click", () => downloadExport("all", "json"));

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
  const btn = document.getElementById("feedback-submit-btn");
  const statusMsg = document.getElementById("feedback-status-msg");
  btn.disabled = true;
  statusMsg.textContent = t("msg_sending");
  try {
    await api("/api/feedback", {
      method: "POST",
      body: JSON.stringify({
        message: fd.get("message"),
        type: fd.get("type"),
        replyTo: fd.get("replyTo") || undefined,
        context: { url: location.href },
      }),
    });
    statusMsg.textContent = t("msg_sent_success");
    setTimeout(() => {
      document.getElementById("feedback-dialog").close();
      e.target.reset();
      statusMsg.textContent = "";
    }, 900);
  } catch (err) {
    statusMsg.textContent = "❌ " + t("msg_failed_prefix", { error: err.message });
  } finally {
    btn.disabled = false;
  }
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
  const tasks = [loadMailCredentials(), loadAreas(), loadSendJobs(), loadApiKeys(), loadOAuthIdentities(), updateCapPreview()];
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
    loadOAuthIdentities();
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

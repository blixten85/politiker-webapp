function providerHelp(provider) {
  return t(`provider_help_${provider}`);
}

let pendingAccountId = null;
let selectedAreas = new Set();
// Vilka områdesgrupper (eu/riksdag/regering/region/kommun) som är hopfällda
// i Avancerat-listan — börjar tom (allt utfällt) tills första renderAreas()
// sätter ett rimligt default (stora grupper som kommun hopfällda från start).
let collapsedAreaGroups = new Set();
let allAreas = [];
let allParties = [];
let excludedParties = new Set();
let excludedRecipients = new Map(); // email -> name
let allRoles = [];
let includedRoles = new Set(); // tom = ingen begränsning (alla befattningar)

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
function autoReportError(message, extra = {}) {
  console.error("[Auto-rapport]", message, { url: location.href, ...extra });
}

// Webbläsartillägg injicerar egen kod på sidan, och fel DÄRIFRÅN dyker upp i
// samma globala error/unhandledrejection-händelser som våra egna — utan att
// vara något vi kan göra något åt (vi har ingen insyn i tilläggets kod).
// Webkit/Firefox/Chrome maskar eller döper om käll-URL:en till tilläggets
// egna protokoll i det fallet, vilket vi kan filtrera bort innan rapportering.
const EXTERNAL_SCRIPT_MARKERS = ["-extension://", "webkit-masked-url", "safari-web-extension"];
function looksLikeExternalScript(filename, stack) {
  const text = `${filename ?? ""} ${stack ?? ""}`;
  return EXTERNAL_SCRIPT_MARKERS.some((marker) => text.includes(marker));
}

const NOISE_MESSAGES = ["Script error.", "Load failed", "NetworkError when attempting to fetch resource."];
window.addEventListener("error", (e) => {
  if (looksLikeExternalScript(e.filename, e.error?.stack)) return;
  if (NOISE_MESSAGES.includes(e.message)) return;
  autoReportError(e.message, { stack: e.error?.stack });
});
window.addEventListener("unhandledrejection", (e) => {
  if (looksLikeExternalScript(null, e.reason?.stack)) return;
  const msg = String(e.reason?.message ?? e.reason);
  if (NOISE_MESSAGES.includes(msg)) return;
  autoReportError(msg, { stack: e.reason?.stack });
});

function showToast(text) {
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = text;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 6000);
}

// Escapar serverdata innan den läggs in via innerHTML. Publika brev byggs av
// RSS-titlar och AI-genererad text — aldrig oescapad in i DOM:en.
const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

// Ring-buffer med senaste API-anrop — inkluderas i felrapporter för kontext.
// Loggar aldrig request-body (kan innehålla lösenord/SMTP-uppgifter).
const recentApiCalls = [];
const RECENT_API_MAX = 15;

async function api(path, opts = {}) {
  const resp = await fetch(path, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers ?? {}) },
  });
  const data = await resp.json();
  const entry = { ts: new Date().toISOString(), method: opts.method ?? "GET", endpoint: path, status: resp.status };
  if (!resp.ok) entry.error = data.error;
  recentApiCalls.push(entry);
  if (recentApiCalls.length > RECENT_API_MAX) recentApiCalls.shift();
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
  allParties = await api("/api/parties");
  allRoles = await api("/api/roles");

  // Standard: stora grupper (kommun/region, hundratals rader) hopfällda från
  // start så Avancerat-listan inte kräver en lång skroll bara för att öppnas
  // — mindre grupper (EU/riksdag/regering) får vara utfällda direkt.
  const COLLAPSE_THRESHOLD = 30;
  const countByType = new Map();
  for (const a of allAreas) countByType.set(a.area_type, (countByType.get(a.area_type) ?? 0) + 1);
  for (const [areaType, count] of countByType) {
    if (count > COLLAPSE_THRESHOLD) collapsedAreaGroups.add(areaType);
  }

  renderAreas();
}

// De 5 övergripande mottagarkorten (EU/Riksdag/Regering/Region/Kommun) —
// nytt i steg 1, presentationslager i en egen modul. Klick väljer/avväljer
// ALLA områden av den typen, samma beteende som "Välj alla"/"Avmarkera
// alla" i den detaljerade Avancerat-listan nedanför.
async function renderAreaTypeCards() {
  const container = document.getElementById("area-type-cards");
  if (!container) return;
  const { renderAreaTypeCards: render } = await import("/components/step-select-recipients.js");
  const areasByType = new Map();
  for (const a of allAreas) {
    if (!areasByType.has(a.area_type)) areasByType.set(a.area_type, []);
    areasByType.get(a.area_type).push(a);
  }
  render(container, {
    areasByType,
    selectedAreas,
    t,
    onToggleType: (_areaType, areas, select) => {
      for (const a of areas) {
        if (select) selectedAreas.add(a.area_name);
        else selectedAreas.delete(a.area_name);
      }
      renderAreas();
      updateRecipientCountPreview();
    },
  });
}

function renderAreas() {
  const filter = document.getElementById("area-filter").value.toLowerCase();
  const div = document.getElementById("area-groups");
  div.innerHTML = "";

  const filtered = allAreas.filter((a) => a.area_name.toLowerCase().includes(filter));
  const byType = new Map();
  for (const a of filtered) {
    if (!byType.has(a.area_type)) byType.set(a.area_type, []);
    byType.get(a.area_type).push(a);
  }

  for (const [areaType, areas] of byType) {
    const group = document.createElement("div");
    group.className = "area-group";

    const header = document.createElement("div");
    header.className = "area-group-header";

    // Vid aktiv sökning forceras gruppen utfälld, annars syns inte
    // träffarna bara för att gruppen råkar vara hopfälld sedan tidigare.
    const collapsed = !filter && collapsedAreaGroups.has(areaType);
    const toggleBtn = document.createElement("button");
    toggleBtn.type = "button";
    toggleBtn.className = "area-group-toggle" + (collapsed ? "" : " expanded");
    toggleBtn.setAttribute("aria-label", t("aria_toggle_group"));
    toggleBtn.textContent = "▶";
    toggleBtn.onclick = () => {
      if (collapsedAreaGroups.has(areaType)) collapsedAreaGroups.delete(areaType);
      else collapsedAreaGroups.add(areaType);
      renderAreas();
    };
    header.appendChild(toggleBtn);

    const title = document.createElement("strong");
    title.textContent = `${areaType} (${areas.length})`;
    title.style.cursor = "pointer";
    title.onclick = () => toggleBtn.onclick();
    header.appendChild(title);

    const selectAllBtn = document.createElement("button");
    selectAllBtn.type = "button";
    selectAllBtn.textContent = t("btn_select_all");
    selectAllBtn.onclick = () => {
      for (const a of areas) selectedAreas.add(a.area_name);
      renderAreas();
      updateRecipientCountPreview();
    };
    const deselectAllBtn = document.createElement("button");
    deselectAllBtn.type = "button";
    deselectAllBtn.textContent = t("btn_deselect_all");
    deselectAllBtn.onclick = () => {
      for (const a of areas) selectedAreas.delete(a.area_name);
      renderAreas();
      updateRecipientCountPreview();
    };
    header.appendChild(selectAllBtn);
    header.appendChild(deselectAllBtn);
    group.appendChild(header);

    const list = document.createElement("div");
    list.className = "area-group-list";
    list.hidden = collapsed;
    for (const a of areas) {
      const label = document.createElement("label");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = selectedAreas.has(a.area_name);
      cb.onchange = () => {
        if (cb.checked) selectedAreas.add(a.area_name);
        else selectedAreas.delete(a.area_name);
        renderPartyExcludeList();
        renderRoleFilterList();
        updateRecipientCountPreview();
      };
      label.appendChild(cb);
      label.append(` ${a.area_name} (${a.count})`);
      list.appendChild(label);
    }
    group.appendChild(list);
    div.appendChild(group);
  }

  renderPartyExcludeList();
  renderRoleFilterList();
  renderAreaTypeCards();
  updateRecipientCountPreview();
}
document.getElementById("area-filter").addEventListener("input", renderAreas);

function renderRoleFilterList() {
  const div = document.getElementById("role-filter-list");
  div.innerHTML = "";
  const relevant = allRoles.filter((r) => selectedAreas.has(r.area_name));

  // Gruppera på normaliserad nyckel (lower+trim) — samma roll skriven med
  // olika skiftläge ("Ledamot"/"ledamot"/"LEDAMOT") ska bli EN kryssruta,
  // inte en per stavning. includedRoles lagrar därför role_key, inte den
  // visade textens exakta skiftläge — annars matchar inte skicka-filtret
  // (som också jämför normaliserat, se db.ts) mot alla varianter.
  const byKey = new Map();
  for (const r of relevant) {
    const existing = byKey.get(r.role_key);
    if (existing) {
      existing.count += r.count;
      if (r.count > existing.topCount) {
        existing.label = r.role;
        existing.topCount = r.count;
      }
    } else {
      byKey.set(r.role_key, { label: r.role, count: r.count, topCount: r.count });
    }
  }

  // Ta bort befattningar ur valet som inte längre är relevanta (t.ex. om
  // användaren avmarkerade ett område) — annars filtreras mottagare tyst
  // bort enligt en roll som inte längre syns/går att avmarkera i UI:t.
  for (const roleKey of [...includedRoles]) {
    if (!byKey.has(roleKey)) includedRoles.delete(roleKey);
  }

  if (relevant.length === 0) return;

  for (const [roleKey, { label: roleLabel, count }] of byKey) {
    const label = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = includedRoles.has(roleKey);
    cb.onchange = () => {
      if (cb.checked) includedRoles.add(roleKey);
      else includedRoles.delete(roleKey);
      updateRecipientCountPreview();
    };
    label.appendChild(cb);
    label.append(` ${roleLabel} (${count})`);
    div.appendChild(label);
  }
}

function renderPartyExcludeList() {
  const div = document.getElementById("party-exclude-list");
  div.innerHTML = "";
  const relevant = allParties.filter((p) => selectedAreas.has(p.area_name));
  if (relevant.length === 0) return;

  const byParty = new Map();
  for (const p of relevant) {
    byParty.set(p.party, (byParty.get(p.party) ?? 0) + p.count);
  }
  for (const [party, count] of byParty) {
    const label = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = excludedParties.has(party);
    cb.onchange = () => {
      if (cb.checked) excludedParties.add(party);
      else excludedParties.delete(party);
      updateRecipientCountPreview();
    };
    label.appendChild(cb);
    label.append(` ${t("label_exclude_party", { party, count })}`);
    div.appendChild(label);
  }
}

function renderExcludedList() {
  const ul = document.getElementById("excluded-list");
  ul.innerHTML = "";
  for (const [email, name] of excludedRecipients) {
    const li = document.createElement("li");
    li.textContent = `${name} <${email}> `;
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.textContent = t("btn_remove");
    removeBtn.onclick = () => {
      excludedRecipients.delete(email);
      renderExcludedList();
      updateRecipientCountPreview();
    };
    li.appendChild(removeBtn);
    ul.appendChild(li);
  }
}

let excludeSearchTimeout = null;
document.getElementById("exclude-search").addEventListener("input", (e) => {
  clearTimeout(excludeSearchTimeout);
  const q = e.target.value.trim();
  const resultsDiv = document.getElementById("exclude-search-results");
  if (q.length < 2 || selectedAreas.size === 0) {
    resultsDiv.innerHTML = "";
    return;
  }
  excludeSearchTimeout = setTimeout(async () => {
    const params = new URLSearchParams({ q });
    for (const a of selectedAreas) params.append("areaName", a);
    const results = await api(`/api/politicians/search?${params.toString()}`);
    resultsDiv.innerHTML = "";
    for (const r of results) {
      const label = document.createElement("label");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = excludedRecipients.has(r.email);
      cb.onchange = () => {
        if (cb.checked) excludedRecipients.set(r.email, r.name);
        else excludedRecipients.delete(r.email);
        renderExcludedList();
        updateRecipientCountPreview();
      };
      label.appendChild(cb);
      label.append(` ${r.name} (${r.area_name}${r.party ? ", " + r.party : ""})`);
      resultsDiv.appendChild(label);
    }
  }, 300);
});

function updateRecipientCountPreview() {
  let total = 0;
  if (includedRoles.size > 0) {
    // Befattning begränsar mottagarna till just dessa roller — räkna ihop
    // det istället för totalen per område (parti-exkludering ovanpå det
    // är en ungefärlig förhandsvisning, servern räknar exakt vid skicka).
    for (const r of allRoles) {
      if (selectedAreas.has(r.area_name) && includedRoles.has(r.role)) total += r.count;
    }
  } else {
    for (const a of allAreas) {
      if (selectedAreas.has(a.area_name)) total += a.count;
    }
  }
  let excludedByParty = 0;
  for (const p of allParties) {
    if (selectedAreas.has(p.area_name) && excludedParties.has(p.party)) excludedByParty += p.count;
  }
  const finalCount = Math.max(0, total - excludedByParty - excludedRecipients.size);
  document.getElementById("recipient-count-preview").textContent = t("msg_recipient_count_preview", { count: finalCount });
  return finalCount;
}

document.getElementById("letter-files").addEventListener("change", async (e) => {
  const container = document.getElementById("file-mode-list");
  const { renderFileModeList } = await import("/components/step-compose.js");
  renderFileModeList(container, e.target.files, { t });
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

document.getElementById("ai-draft-btn").addEventListener("click", async () => {
  const btn = document.getElementById("ai-draft-btn");
  const status = document.getElementById("ai-draft-status");
  const topic = document.getElementById("ai-draft-topic").value.trim();

  // Grov gissning av mottagartyp för ton, baserat på vilka områden som är
  // markerade — bara en hint, behöver inte vara exakt.
  const typeCounts = {};
  for (const a of allAreas) {
    if (selectedAreas.has(a.area_name)) typeCounts[a.area_type] = (typeCounts[a.area_type] ?? 0) + 1;
  }
  const areaType = Object.keys(typeCounts).sort((a, b) => typeCounts[b] - typeCounts[a])[0];

  btn.disabled = true;
  status.textContent = t("msg_ai_draft_loading");
  try {
    const result = await api("/api/draft-letter", {
      method: "POST",
      body: JSON.stringify({ topic: topic || undefined, areaType }),
    });
    document.getElementById("letter-subject").value = result.subject;
    document.getElementById("letter-body").value = result.htmlBody;
    document.getElementById("letter-body").dispatchEvent(new Event("input"));
    status.textContent = result.sources.length
      ? t("msg_ai_draft_done_with_sources", { count: result.sources.length })
      : t("msg_ai_draft_done");
  } catch (err) {
    status.textContent = err.message;
  } finally {
    btn.disabled = false;
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
        excludeParties: [...excludedParties],
        excludeEmails: [...excludedRecipients.keys()],
        includeRoles: [...includedRoles],
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
    if (j.status === "done" && j.letter_id) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "link-btn";
      btn.dataset.letterId = j.letter_id;
      btn.dataset.i18n = "btn_publish_letter";
      btn.textContent = t("btn_publish_letter");
      btn.style.marginLeft = "0.5rem";
      btn.addEventListener("click", async () => {
        try {
          await api(`/api/letters/${j.letter_id}/publish`, { method: "POST" });
          btn.textContent = t("btn_published");
          btn.disabled = true;
        } catch (e) {
          btn.textContent = e.message;
        }
      });
      li.appendChild(btn);
    }
    ul.appendChild(li);
  }
}

document.getElementById("totp-copy-secret-btn").addEventListener("click", async () => {
  const secret = document.getElementById("totp-secret").textContent;
  await navigator.clipboard.writeText(secret);
  const btn = document.getElementById("totp-copy-secret-btn");
  const original = btn.textContent;
  btn.textContent = t("btn_copied");
  setTimeout(() => { btn.textContent = original; }, 1500);
});

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
        context: {
          url: location.href,
          userAgent: navigator.userAgent,
          lang: navigator.language,
          step: currentStep,
          view: ["landing-view","wizard-view","settings-view","admin-view"].find(id => !document.getElementById(id)?.hidden) ?? "unknown",
          recentApiCalls: recentApiCalls.slice(),
        },
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
document.getElementById("donate-btn").addEventListener("click", () => document.getElementById("donate-dialog").showModal());
document.getElementById("donate-close").addEventListener("click", () => document.getElementById("donate-dialog").close());
document.querySelectorAll(".donate-qr-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    const img = document.getElementById(btn.dataset.target);
    if (!img) return;
    img.hidden = !img.hidden;
    btn.setAttribute("aria-pressed", String(!img.hidden));
    btn.textContent = img.hidden ? t("btn_show_qr") : t("btn_hide_qr");
  });
});
document.getElementById("faq-close").addEventListener("click", () => document.getElementById("faq-dialog").close());

// Landningssida → wizard (3 steg) → inställningar. Tre toppnivå-vyer inom
// #app-view, bara en synlig åt gången. Inställningar (mailkonto/2FA/API-
// nycklar/admin) är medvetet SKILDA från wizarden — de hör till kontot,
// inte till "skapa och skicka ett brev"-flödet.
let currentStep = 1;

let isAdminUser = false;

function hideAllAppViews() {
  document.getElementById("landing-view").hidden = true;
  document.getElementById("wizard-view").hidden = true;
  document.getElementById("settings-view").hidden = true;
  document.getElementById("admin-view").hidden = true;
  document.getElementById("letters-view").hidden = true;
}

async function showLandingView() {
  hideAllAppViews();
  document.getElementById("landing-view").hidden = false;
  document.getElementById("home-btn").hidden = true;
  document.getElementById("settings-btn").hidden = false;
  document.getElementById("admin-btn").hidden = !isAdminUser;
  history.replaceState(null, "", "#home");
  const { renderLanding } = await import("/components/step-landing.js");
  renderLanding(document.getElementById("landing-view"), { t, onStart: startWizard });
}

function startWizard() {
  hideAllAppViews();
  document.getElementById("wizard-view").hidden = false;
  document.getElementById("home-btn").hidden = false;
  document.getElementById("settings-btn").hidden = false;
  document.getElementById("admin-btn").hidden = !isAdminUser;
  history.replaceState(null, "", "#write");
  goToStep(1);
}

function showSettingsView() {
  hideAllAppViews();
  document.getElementById("settings-view").hidden = false;
  document.getElementById("home-btn").hidden = false;
  document.getElementById("settings-btn").hidden = true;
  document.getElementById("admin-btn").hidden = !isAdminUser;
  history.replaceState(null, "", "#settings");
}

function showAdminView() {
  hideAllAppViews();
  document.getElementById("admin-view").hidden = false;
  document.getElementById("home-btn").hidden = false;
  document.getElementById("settings-btn").hidden = false;
  document.getElementById("admin-btn").hidden = true;
  history.replaceState(null, "", "#admin");
  loadAdminPanel();
}

let lettersPage = 0;

function showLettersView() {
  hideAllAppViews();
  document.getElementById("letters-view").hidden = false;
  document.getElementById("home-btn").hidden = false;
  document.getElementById("settings-btn").hidden = false;
  document.getElementById("letters-btn").hidden = true;
  history.replaceState(null, "", "#letters");
  lettersPage = 0;
  document.getElementById("letters-list").innerHTML = "";
  loadPublicLetters();
}

async function loadPublicLetters() {
  const list = document.getElementById("letters-list");
  try {
    const { letters } = await api(`/api/public/letters?page=${lettersPage}`);
    if (letters.length === 0 && lettersPage === 0) {
      list.innerHTML = `<p class="hint" style="padding:1rem">${t("letters_empty")}</p>`;
      document.getElementById("letters-load-more").hidden = true;
      return;
    }
    for (const l of letters) {
      const card = document.createElement("div");
      card.className = "card letter-card";
      const badge = l.source === "campaign" ? t("letters_badge_campaign") : t("letters_badge_user");
      const date = new Date(l.published_at).toLocaleDateString(currentLocale());
      const area = l.area_name ? `<span class="letter-area">${escapeHtml(l.area_name)}</span>` : "";
      card.innerHTML = `
        <div class="letter-card-meta">
          <span class="letter-badge">${escapeHtml(badge)}</span>${area}
          <span class="letter-date">${escapeHtml(date)}</span>
        </div>
        <h3 class="letter-subject">${escapeHtml(l.subject)}</h3>
        <p class="letter-excerpt">${escapeHtml(l.excerpt)}…</p>
        <button type="button" class="link-btn letter-read-btn" data-id="${escapeHtml(l.id)}" data-i18n="letters_read_more">Läs hela</button>
      `;
      list.appendChild(card);
    }
    document.getElementById("letters-load-more").hidden = letters.length < 20;
    lettersPage++;
  } catch (e) {
    list.innerHTML += `<p class="hint" style="padding:1rem">${t("letters_error")}</p>`;
  }
}

document.getElementById("letters-list")?.addEventListener("click", async (e) => {
  const btn = e.target.closest(".letter-read-btn");
  if (!btn) return;
  const { subject, body } = await api(`/api/public/letters/${btn.dataset.id}`);
  const dialog = document.createElement("dialog");
  dialog.innerHTML = `
    <div style="max-width:640px;padding:1.5rem">
      <h2>${escapeHtml(subject)}</h2>
      <pre style="white-space:pre-wrap;font-family:inherit;line-height:1.6">${escapeHtml(body)}</pre>
      <button type="button" autofocus style="margin-top:1rem">${escapeHtml(t("btn_close"))}</button>
    </div>`;
  dialog.querySelector("button").addEventListener("click", () => { dialog.close(); dialog.remove(); });
  document.body.appendChild(dialog);
  dialog.showModal();
});

document.getElementById("letters-more-btn")?.addEventListener("click", loadPublicLetters);
document.getElementById("letters-btn")?.addEventListener("click", showLettersView);

function goToStep(n) {
  currentStep = n;
  for (let i = 1; i <= 3; i++) {
    document.getElementById(`wizard-step-${i}`).hidden = i !== n;
  }
  document.querySelectorAll(".wizard-step-dot").forEach((dot) => {
    dot.classList.toggle("active", Number(dot.dataset.step) === n);
  });
  if (n === 3) renderReviewStep();
}

async function renderReviewStep() {
  const recipientCount = updateRecipientCountPreview();

  const typesSet = new Set();
  for (const a of allAreas) {
    if (selectedAreas.has(a.area_name)) typesSet.add(a.area_type);
  }
  const typeLabels = [...typesSet].map((ty) => t(`area_type_${ty}`) ?? ty);

  const { renderReview } = await import("/components/step-review.js");
  renderReview(document.getElementById("review-summary"), {
    recipientCount,
    typeLabels,
    subject: document.getElementById("letter-subject").value,
    bodyHtml: document.getElementById("letter-body").value,
    t,
  });

  const credentials = await loadMailCredentials();
  document.getElementById("review-no-mail-warning").hidden = credentials.length > 0;
  document.getElementById("send-btn").disabled = credentials.length === 0;
}

document.getElementById("home-btn").addEventListener("click", showLandingView);
document.getElementById("settings-btn").addEventListener("click", showSettingsView);
document.getElementById("step1-next-btn").addEventListener("click", () => goToStep(2));
document.getElementById("step2-back-btn").addEventListener("click", () => goToStep(1));
document.getElementById("step2-next-btn").addEventListener("click", () => goToStep(3));
document.getElementById("step3-back-btn").addEventListener("click", () => goToStep(2));

// Stegindikatorerna är klickbara — låt användaren hoppa fritt mellan 1-3
// istället för att tvinga sekventiell Nästa/Tillbaka-navigering. Inget
// valideringskrav mellan stegen (samma data finns redan oavsett ordning).
document.querySelectorAll(".wizard-step-dot").forEach((dot) => {
  dot.addEventListener("click", () => goToStep(Number(dot.dataset.step)));
});

async function showApp(me) {
  document.getElementById("auth-view").hidden = true;
  document.getElementById("app-view").hidden = false;
  document.getElementById("logout-btn").hidden = false;
  if (!me) me = await api("/api/me");
  if (me.totpEnabled) {
    document.getElementById("totp-disabled-view").hidden = true;
    document.getElementById("totp-enabled-view").hidden = false;
  }
  isAdminUser = me.isAdmin;
  const tasks = [loadMailCredentials(), loadAreas(), loadSendJobs(), loadApiKeys(), loadOAuthIdentities(), updateCapPreview()];
  await Promise.allSettled(tasks);
  const hash = location.hash;
  if (hash === "#settings") showSettingsView();
  else if (hash === "#admin" && isAdminUser) showAdminView();
  else if (hash === "#write") startWizard();
  else showLandingView();
}

document.getElementById("admin-btn").addEventListener("click", showAdminView);

document.addEventListener("languagechange", () => {
  if (!document.getElementById("app-view").hidden) {
    loadMailCredentials();
    renderAreas();
    renderExcludedList();
    loadSendJobs();
    loadApiKeys();
    loadOAuthIdentities();
    if (!document.getElementById("admin-view").hidden) loadAdminPanel();
    if (!document.getElementById("landing-view").hidden) showLandingView();
    if (currentStep === 3 && !document.getElementById("wizard-view").hidden) renderReviewStep();
  }
});

(async function init() {
  const resetToken = new URLSearchParams(location.search).get("reset");
  if (resetToken) {
    document.getElementById("reset-password-card").hidden = false;
  }

  try {
    const me = await api("/api/me");
    if (me.loggedIn) {
      await showApp(me);
    } else {
      document.getElementById("auth-view").hidden = false;
    }
  } catch {
    document.getElementById("app-view").hidden = true;
    document.getElementById("logout-btn").hidden = true;
    document.getElementById("auth-view").hidden = false;
  }
})();

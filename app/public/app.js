const PROVIDER_HELP = {
  gmail: "Gmail kräver ett app-lösenord (kräver 2-stegsverifiering): myaccount.google.com/apppasswords",
  outlook: "Outlook/Microsoft 365 kräver ett app-lösenord: account.live.com/proofs/AppPassword",
  icloud: "iCloud kräver ett app-specifikt lösenord: appleid.apple.com → Säkerhet",
  generic: "Ange din leverantörs SMTP-server, port, användarnamn och lösenord.",
};

let pendingAccountId = null;
let selectedAreas = new Set();
let allAreas = [];

async function api(path, opts = {}) {
  const resp = await fetch(path, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers ?? {}) },
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error ?? "Något gick fel");
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
    document.getElementById("signup-msg").textContent = "Konto skapat — kolla din inkorg för verifieringskod.";
  } catch (err) {
    document.getElementById("signup-msg").textContent = err.message;
  }
});

document.getElementById("verify-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  try {
    await api("/api/verify", { method: "POST", body: JSON.stringify({ accountId: pendingAccountId, code: fd.get("code") }) });
    document.getElementById("verify-msg").textContent = "Verifierad! Du kan nu logga in.";
  } catch (err) {
    document.getElementById("verify-msg").textContent = err.message;
  }
});

document.getElementById("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  try {
    await api("/api/login", { method: "POST", body: JSON.stringify({ email: fd.get("email"), password: fd.get("password") }) });
    showApp();
  } catch (err) {
    document.getElementById("login-msg").textContent = err.message;
  }
});

document.getElementById("provider-select").addEventListener("change", (e) => {
  document.getElementById("generic-fields").hidden = e.target.value !== "generic";
  document.getElementById("provider-help").textContent = PROVIDER_HELP[e.target.value] ?? "";
});

document.getElementById("add-credential-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const msg = document.getElementById("credential-msg");
  msg.textContent = "Testar inloggning mot din mailleverantör...";
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
    msg.textContent = "Mailkonto kopplat!";
    e.target.reset();
    loadMailCredentials();
  } catch (err) {
    msg.textContent = "Misslyckades: " + err.message;
  }
});

async function loadMailCredentials() {
  const list = await api("/api/mail-credentials");
  const ul = document.getElementById("mail-credentials-list");
  ul.innerHTML = "";
  for (const c of list) {
    const li = document.createElement("li");
    li.textContent = `${c.from_address} (${c.provider}) `;
    const del = document.createElement("button");
    del.textContent = "Ta bort";
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

document.getElementById("send-btn").addEventListener("click", async () => {
  const msg = document.getElementById("send-msg");
  const credentials = await loadMailCredentials();
  if (credentials.length === 0) {
    msg.textContent = "Koppla ett mailkonto först.";
    return;
  }
  if (selectedAreas.size === 0) {
    msg.textContent = "Välj minst en kommun/region.";
    return;
  }
  const html = document.getElementById("letter-body").value;
  if (!html.trim()) {
    msg.textContent = "Skriv ett brev först.";
    return;
  }
  try {
    const result = await api("/api/send", {
      method: "POST",
      body: JSON.stringify({ letterHtml: html, mailCredentialId: credentials[0].id, areaNames: [...selectedAreas] }),
    });
    msg.textContent = `Skickar till ${result.totalRecipients} mottagare — se status nedan.`;
    loadSendJobs();
  } catch (err) {
    msg.textContent = "Misslyckades: " + err.message;
  }
});

async function loadSendJobs() {
  const jobs = await api("/api/send-jobs");
  const ul = document.getElementById("send-jobs-list");
  ul.innerHTML = "";
  for (const j of jobs) {
    const li = document.createElement("li");
    li.textContent = `${new Date(j.created_at).toLocaleString("sv-SE")} — ${j.sent_count}/${j.total_recipients} skickade, ${j.bounce_count} fel — status: ${j.status}`;
    ul.appendChild(li);
  }
}

document.getElementById("feedback-btn").addEventListener("click", () => document.getElementById("feedback-dialog").showModal());
document.getElementById("feedback-cancel").addEventListener("click", () => document.getElementById("feedback-dialog").close());
document.getElementById("feedback-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  await api("/api/feedback", { method: "POST", body: JSON.stringify({ message: fd.get("message"), context: { url: location.href } }) });
  document.getElementById("feedback-dialog").close();
  e.target.reset();
});

async function showApp() {
  document.getElementById("auth-view").hidden = true;
  document.getElementById("app-view").hidden = false;
  await Promise.all([loadMailCredentials(), loadAreas(), loadSendJobs()]);
}

(async function init() {
  const me = await api("/api/me");
  if (me.loggedIn) showApp();
})();

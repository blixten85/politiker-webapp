// Steg 0: landningsvy efter inloggning, innan wizarden startas.
// Rent presentationslager — ingen egen state, bara DOM-uppbyggnad + en
// callback. All faktisk data/state ägs av app.js.

export function renderLanding(container, { t, onStart }) {
  container.innerHTML = "";

  const hero = document.createElement("div");
  hero.className = "landing-hero";

  const h1 = document.createElement("h1");
  h1.textContent = t("landing_title");
  hero.appendChild(h1);

  const desc = document.createElement("p");
  desc.className = "landing-desc";
  desc.textContent = t("landing_desc");
  hero.appendChild(desc);

  const startBtn = document.createElement("button");
  startBtn.type = "button";
  startBtn.className = "btn-primary btn-large";
  startBtn.textContent = t("landing_cta");
  startBtn.addEventListener("click", onStart);
  hero.appendChild(startBtn);

  container.appendChild(hero);

  const steps = document.createElement("div");
  steps.className = "landing-steps";
  const stepsTitle = document.createElement("h2");
  stepsTitle.textContent = t("landing_how_title");
  steps.appendChild(stepsTitle);

  const list = document.createElement("ol");
  list.className = "landing-steps-list";
  for (const key of ["landing_step1", "landing_step2", "landing_step3"]) {
    const li = document.createElement("li");
    li.textContent = t(key);
    list.appendChild(li);
  }
  steps.appendChild(list);
  container.appendChild(steps);
}

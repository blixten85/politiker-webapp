// Steg 1: de 5 övergripande mottagarkorten (EU/Riksdag/Regering/Region/
// Kommun). Den detaljerade per-område-listan, befattningsfiltret,
// parti-/individuell exkludering ligger kvar i app.js (oförändrad,
// befintlig logik) inne i en "Avancerat"-sektion — bara dessa kort är nya.
//
// Rent presentationslager: tar emot redan summerad data + en toggle-
// callback, äger ingen egen state.

const TYPE_ORDER = ["eu", "riksdag", "regering", "region", "kommun"];

export function renderAreaTypeCards(container, { areasByType, selectedAreas, onToggleType, t }) {
  container.innerHTML = "";

  const grid = document.createElement("div");
  grid.className = "area-type-grid";

  const types = [...areasByType.keys()].sort(
    (a, b) => TYPE_ORDER.indexOf(a) - TYPE_ORDER.indexOf(b),
  );

  for (const areaType of types) {
    const areas = areasByType.get(areaType);
    const totalCount = areas.reduce((sum, a) => sum + a.count, 0);
    const allSelected = areas.every((a) => selectedAreas.has(a.area_name));
    const someSelected = !allSelected && areas.some((a) => selectedAreas.has(a.area_name));

    const card = document.createElement("button");
    card.type = "button";
    card.className = "area-type-card" + (allSelected ? " selected" : "") + (someSelected ? " partial" : "");

    const label = document.createElement("div");
    label.className = "area-type-card-label";
    label.textContent = t(`area_type_${areaType}`) ?? areaType;
    card.appendChild(label);

    const count = document.createElement("div");
    count.className = "area-type-card-count";
    count.textContent = t("area_type_card_count", { count: totalCount });
    card.appendChild(count);

    card.addEventListener("click", () => onToggleType(areaType, areas, !allSelected));
    grid.appendChild(card);
  }

  container.appendChild(grid);
}

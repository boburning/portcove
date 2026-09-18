import "../styles.css";
import "./scenarios.css";

if (!import.meta.env.DEV || "__TAURI_INTERNALS__" in window || "__TAURI__" in window) {
  throw new Error("Development scenarios require the ordinary development browser, not Tauri");
}

const { renderScenario, scenarios } = await import("./scenarios");
const select = document.querySelector<HTMLSelectElement>("#scenario");
const preview = document.querySelector<HTMLElement>("#scenario-preview");
const limitation = document.querySelector<HTMLElement>("#scenario-limitation");
if (!select || !preview || !limitation) throw new Error("Development scenario shell is incomplete");
preview.inert = true;
for (const scenario of scenarios) select.add(new Option(scenario.label, scenario.id));
const show = () => {
  const scenario = scenarios.find((candidate) => candidate.id === select.value);
  if (!scenario) throw new Error("Unknown development scenario selection");
  limitation.textContent = `${scenario.limitation} Not interaction, focus, controller, IPC, platform or packaged evidence.`;
  preview.innerHTML = renderScenario(scenario.id);
};
select.addEventListener("change", show);
show();

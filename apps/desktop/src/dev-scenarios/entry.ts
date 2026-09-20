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
const initialUrl = new URL(window.location.href);
const embedded = initialUrl.searchParams.get("embed") === "1";
if (embedded) document.body.classList.add("scenario-embed");
const selectedId = initialUrl.searchParams.get("scenario");
if (selectedId && scenarios.some((scenario) => scenario.id === selectedId))
  select.value = selectedId;
const show = () => {
  const scenario = scenarios.find((candidate) => candidate.id === select.value);
  if (!scenario) throw new Error("Unknown development scenario selection");
  limitation.textContent = `${scenario.limitation} Not interaction, focus, controller, IPC, platform or packaged evidence.`;
  if (!embedded && scenario.viewport === "narrow") {
    const frameUrl = new URL(window.location.href);
    frameUrl.searchParams.set("scenario", scenario.id);
    frameUrl.searchParams.set("embed", "1");
    const frame = document.createElement("iframe");
    frame.title = `${scenario.label} at the narrow reference viewport`;
    frame.src = frameUrl.toString();
    preview.replaceChildren(frame);
  } else {
    preview.innerHTML = renderScenario(scenario.id);
  }
  const url = new URL(window.location.href);
  url.searchParams.set("scenario", scenario.id);
  if (!embedded) url.searchParams.delete("embed");
  window.history.replaceState(null, "", url);
};
select.addEventListener("change", show);
show();

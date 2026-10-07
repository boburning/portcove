import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import App from "../../App";
import { AppErrorBoundary } from "../../ErrorBoundary";
import { desktopApi } from "../../api";
import { initializeLocalization, LocalizationProvider } from "../../localization";
import { initializeTheme } from "../../theme";
import { journeyFrom, journeys, type Journey } from "./scenarios";
import { installInteractiveTransport, recoveryKey } from "./transport";

let stop: (() => void) | undefined;
export function stopInteractiveScenarios() {
  stop?.();
  stop = undefined;
}
export function startInteractiveScenarios() {
  if (!import.meta.env.DEV || "__TAURI_INTERNALS__" in window || "__TAURI__" in window)
    throw new Error("Interactive fixtures require an ordinary development browser");
  const select = document.querySelector<HTMLSelectElement>("#scenario");
  const preview = document.querySelector<HTMLElement>("#scenario-preview");
  const limitation = document.querySelector<HTMLElement>("#scenario-limitation");
  if (!select || !preview || !limitation)
    throw new Error("Development scenario shell is incomplete");
  const url = new URL(window.location.href);
  const initial = journeyFrom(url.searchParams.get("journey"));
  select.replaceChildren();
  for (const journey of journeys) select.add(new Option(journey.label, journey.id));
  select.value = initial;
  preview.inert = false;
  preview.classList.remove("scenario-preview");
  preview.style.minHeight = "100vh";
  limitation.textContent =
    "Interactive renderer fixtures using the actual App and desktopApi. No Core execution, native IPC, game files, or production service. Unsupported actions are refused. During preparation: Alt+Shift+Enter completes the fixture; Alt+Shift+F injects failure.";
  const controls = document.createElement("div");
  const refusal = document.createElement("p");
  refusal.setAttribute("role", "alert");
  const reset = document.createElement("button");
  reset.type = "button";
  reset.textContent = "Reset journey";
  const complete = document.createElement("button");
  complete.type = "button";
  complete.textContent = "Complete fixture preparation";
  const fail = document.createElement("button");
  fail.type = "button";
  fail.textContent = "Fail fixture preparation";
  controls.append(reset, complete, fail, refusal);
  limitation.after(controls);
  let root: Root | undefined;
  let transport: ReturnType<typeof installInteractiveTransport> | undefined;
  const mount = (journey: Journey, resetState: boolean) => {
    if (root) flushSync(() => root?.unmount());
    transport?.dispose();
    if (resetState) sessionStorage.removeItem(recoveryKey);
    refusal.textContent = "";
    complete.hidden = fail.hidden = journey !== "setup";
    transport = installInteractiveTransport(journey, (message) => {
      refusal.textContent = message;
    });
    initializeTheme();
    initializeLocalization(["en"]);
    root = createRoot(preview);
    root.render(
      <React.StrictMode>
        <LocalizationProvider api={desktopApi}>
          <AppErrorBoundary
            report={(error, info) => {
              void desktopApi.reportFrontendError(error.message, info.componentStack ?? "");
            }}
          >
            <App />
          </AppErrorBoundary>
        </LocalizationProvider>
      </React.StrictMode>,
    );
    const current = new URL(window.location.href);
    current.searchParams.set("mode", "interactive");
    current.searchParams.set("journey", journey);
    current.searchParams.delete("scenario");
    current.searchParams.delete("embed");
    window.history.replaceState(null, "", current);
  };
  const selected = () => journeyFrom(select.value);
  const change = () => mount(selected(), true);
  const finish = () => {
    try {
      transport?.complete();
    } catch {
      /* Refusal is visible in the fixture toolbar. */
    }
  };
  const failPreparation = () => {
    try {
      transport?.fail();
    } catch {
      /* Refusal is visible in the fixture toolbar. */
    }
  };
  const fixtureKey = (event: KeyboardEvent) => {
    if (!event.altKey || !event.shiftKey || selected() !== "setup") return;
    if (event.key === "Enter") {
      event.preventDefault();
      finish();
    } else if (event.key.toLowerCase() === "f") {
      event.preventDefault();
      failPreparation();
    }
  };
  document.addEventListener("keydown", fixtureKey, true);
  select.addEventListener("change", change);
  reset.addEventListener("click", change);
  complete.addEventListener("click", finish);
  fail.addEventListener("click", failPreparation);
  stop = () => {
    document.removeEventListener("keydown", fixtureKey, true);
    select.removeEventListener("change", change);
    flushSync(() => root?.unmount());
    transport?.dispose();
    controls.remove();
  };
  mount(initial, false);
}

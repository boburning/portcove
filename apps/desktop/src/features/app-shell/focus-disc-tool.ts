import { focusAndReveal } from "../../focus";

export function focusDiscTool(toolId?: string) {
  const heading = document.getElementById("disc-tools-heading");
  const row = toolId
    ? [...document.querySelectorAll<HTMLElement>("[data-host-tool-id]")].find(
        (candidate) => candidate.dataset.hostToolId === toolId,
      )
    : undefined;
  const action = row?.querySelector<HTMLElement>("button:not(:disabled)");
  focusAndReveal(action ?? row ?? heading);
}

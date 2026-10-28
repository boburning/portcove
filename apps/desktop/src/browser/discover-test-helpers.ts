import { expect } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

export function discoverGroupForPort(portId: string): HTMLElement {
  const group = [...document.querySelectorAll<HTMLElement>("[data-discover-port-ids]")].find(
    (entry) => (JSON.parse(entry.dataset.discoverPortIds!) as string[]).includes(portId),
  );
  if (!group) throw new Error(`No visible Discover group contains ${portId}`);
  return group;
}

/** Follow the actual single-port or comparison flow without choosing by a shared game title. */
export async function openDiscoverPort(portId: string) {
  const group = discoverGroupForPort(portId);
  const matching = JSON.parse(group.dataset.discoverMatchingPortIds!) as string[];
  const direct = matching.length === 1 && matching[0] === portId;
  const trigger =
    direct || matching.length > 1
      ? group.querySelector<HTMLButtonElement>(".discover-game-identity")!
      : [...group.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
          button.textContent?.includes("Compare all"),
        )!;
  await userEvent.click(trigger);
  if (!direct) {
    await expect.element(page.getByRole("dialog")).toBeVisible();
    const exact = document.querySelector<HTMLButtonElement>(
      `button[data-discover-port-id="${CSS.escape(portId)}"]`,
    );
    if (!exact) throw new Error(`No comparison action names exact port ${portId}`);
    await userEvent.click(exact);
  }
}

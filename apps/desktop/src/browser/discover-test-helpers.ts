import { act } from "react";
import { mountCollectionDestination } from "../collection-navigation";
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
  const primary = group.dataset.discoverPrimaryPortId;
  const direct = primary ? primary === portId : matching.length === 1 && matching[0] === portId;
  const trigger =
    direct || (!primary && matching.length > 1)
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

/** Mount the accepted logical game before inspecting its current DOM. */
async function mountPort(portId: string) {
  const workspace = document.querySelector<HTMLElement>("[data-focus-region=workspace], main");
  if (!workspace) throw new Error("No browsing workspace");
  let pending!: Promise<boolean>;
  await act(async () => {
    pending = mountCollectionDestination(workspace, { portId }, () => true);
  });
  let settled = false;
  void pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await expect
    .poll(async () => {
      await act(async () => {
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
      });
      return settled;
    })
    .toBe(true);
  expect(await pending).toBe(true);
}

export async function mountDiscoverPort(portId: string) {
  await mountPort(portId);
  return discoverGroupForPort(portId);
}

export async function mountLibraryPort(portId: string) {
  await mountPort(portId);
  const group = [...document.querySelectorAll<HTMLElement>("[data-library-port-ids]")].find(
    (entry) => (JSON.parse(entry.dataset.libraryPortIds!) as string[]).includes(portId),
  );
  if (!group) throw new Error(`No mounted Library group contains ${portId}`);
  return group;
}

export async function inspectLibraryGroups(
  expected: readonly (readonly string[])[],
  inspect: (card: HTMLElement, position: number) => void | Promise<void> = () => {},
  matching: readonly (readonly string[])[] = expected,
) {
  const visited = new Set<number>();
  for (let index = 0; index < expected.length; index++) {
    if (visited.has(index)) continue;
    await mountLibraryPort(expected[index]![0]!);
    const cards = [...document.querySelectorAll<HTMLElement>("[data-library-port-ids]")];
    if (expected.length >= 100) expect(cards.length).toBeLessThan(expected.length);
    for (const card of cards) {
      const position = Number(card.getAttribute("aria-posinset")) - 1;
      expect(card.getAttribute("aria-setsize")).toBe(String(expected.length));
      expect(JSON.parse(card.dataset.libraryPortIds!)).toEqual(expected[position]);
      expect(JSON.parse(card.dataset.libraryMatchingPortIds!)).toEqual(matching[position]);
      if (!visited.has(position)) {
        await inspect(card, position);
        visited.add(position);
      }
    }
  }
  expect([...visited].sort((left, right) => left - right)).toEqual(
    expected.map((_, index) => index),
  );
}

/** Inspect every logical game in accepted order without requiring simultaneous DOM. */
export async function inspectDiscoverGroups(
  expected: readonly (readonly string[])[],
  inspect: (card: HTMLElement, position: number) => void | Promise<void> = () => {},
) {
  const visited = new Set<number>();
  for (let next = 0; next < expected.length; next++) {
    if (visited.has(next)) continue;
    await mountDiscoverPort(expected[next]![0]!);
    const cards = [...document.querySelectorAll<HTMLElement>("[data-discover-port-ids]")];
    expect(cards.length).toBeLessThan(
      expected.length >= 100 ? expected.length : expected.length + 1,
    );
    for (const card of cards) {
      if (!card.isConnected) continue;
      const position = Number(card.getAttribute("aria-posinset")) - 1;
      expect(card.getAttribute("aria-setsize")).toBe(String(expected.length));
      expect(JSON.parse(card.dataset.discoverPortIds!)).toEqual(expected[position]);
      if (!visited.has(position)) {
        await inspect(card, position);
        visited.add(position);
      }
    }
  }
  expect([...visited].sort((left, right) => left - right)).toEqual(
    expected.map((_, index) => index),
  );
}

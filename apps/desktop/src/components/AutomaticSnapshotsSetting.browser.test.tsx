import { controlledAct as act } from "../../test/controlled-react-act";
import { render as renderComponent, cleanup, type RenderResult } from "vitest-browser-react";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { AutomaticSnapshotsSetting } from "./AutomaticSnapshotsSetting";

let root: RenderResult;
let container: HTMLDivElement;
beforeEach(async () => {
  container = document.createElement("div");
  document.body.append(container);
  root = await renderComponent(null, { container: document.body.appendChild(container) });
});
afterEach(async () => {
  await cleanup();
  container.remove();
  vi.restoreAllMocks();
});

const checkbox = () => document.body.querySelector<HTMLElement>("[data-slot=checkbox]");
async function show(
  load: (generation: number) => Promise<boolean>,
  save: (enabled: boolean, generation: number) => Promise<boolean>,
  generation = 3,
) {
  await act(async () => {
    await root.rerender(
      <AutomaticSnapshotsSetting generation={generation} load={load} save={save} />,
    );
  });
}

it("shows what Core stores for this library and writes the player's choice back", async () => {
  const load = vi.fn().mockResolvedValue(true);
  const save = vi.fn().mockResolvedValue(false);
  await show(load, save);
  expect(load).toHaveBeenCalledWith(3);
  expect(checkbox()?.getAttribute("aria-checked")).toBe("true");
  await act(async () => checkbox()?.click());
  expect(save).toHaveBeenCalledWith(false, 3);
  expect(checkbox()?.getAttribute("aria-checked")).toBe("false");
});

it("shows the value Core reports back, not the value that was requested", async () => {
  const load = vi.fn().mockResolvedValue(false);
  const save = vi.fn().mockResolvedValue(false);
  await show(load, save);
  await act(async () => checkbox()?.click());
  expect(save).toHaveBeenCalledWith(true, 3);
  expect(checkbox()?.getAttribute("aria-checked")).toBe("false");
});

it("disables the control until Core has answered and reports a failed read or save", async () => {
  const never = () => new Promise<boolean>(() => undefined);
  await show(never, vi.fn());
  expect(checkbox()?.hasAttribute("data-disabled")).toBe(true);

  await show(vi.fn().mockRejectedValue(new Error("down")), vi.fn(), 4);
  expect(document.body.querySelector("[role=alert]")).not.toBeNull();

  const load = vi.fn().mockResolvedValue(true);
  const save = vi.fn().mockRejectedValue(new Error("locked"));
  await show(load, save, 5);
  await act(async () => checkbox()?.click());
  expect(document.body.querySelector("[role=alert]")).not.toBeNull();
  expect(checkbox()?.getAttribute("aria-checked")).toBe("true");
});

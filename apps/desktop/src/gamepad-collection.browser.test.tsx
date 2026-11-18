import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { registerCollectionNavigation } from "./collection-navigation";
import { useGamepadNavigation } from "./gamepad";

it("consumes one directional action while a logical neighbor is mounting", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const rectangles = vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockImplementation(function (this: HTMLElement) {
      return new DOMRect(0, Number(this.dataset.position ?? 0), 100, 30);
    });
  const reveal = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
  function Fixture() {
    useGamepadNavigation(() => {});
    return (
      <main data-focus-region="workspace">
        <section data-virtual-collection="catalog" data-focus-group>
          <div data-collection-row="0">
            <button data-position="0">Origin</button>
          </div>
          <div data-collection-row="1">
            <button data-position="100">Neighbor</button>
          </div>
          <div data-collection-row="2">
            <button data-position="200">Following</button>
          </div>
        </section>
      </main>
    );
  }
  let unregister = () => {};
  try {
    await act(async () => root.render(<Fixture />));
    const buttons = [...host.querySelectorAll("button")];
    const origin = buttons[0]!;
    let complete!: (value: boolean) => void;
    const mounted = new Promise<boolean>((resolve) => {
      complete = resolve;
    });
    const prepareMove = vi.fn(() => mounted);
    unregister = registerCollectionNavigation(host.querySelector("section")!, {
      mount: () => mounted,
      prepareMove,
    });
    await act(async () => {
      origin.focus();
      origin.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
      );
      origin.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowDown",
          repeat: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(prepareMove).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(origin);
    await act(async () => complete(true));
    expect(document.activeElement).toBe(buttons[1]);
    expect(reveal).toHaveBeenCalledTimes(1);
  } finally {
    unregister();
    await act(async () => root.unmount());
    host.remove();
    rectangles.mockRestore();
    reveal.mockRestore();
    vi.unstubAllGlobals();
  }
});

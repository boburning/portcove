// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDialogFocus } from "./dialog";

let container: HTMLDivElement, opener: HTMLButtonElement, root: Root;
const scroll = vi.fn();
const close = vi.fn();

function Dialog({ loaded = false, disabled = false }: { loaded?: boolean; disabled?: boolean }) {
  const ref = useDialogFocus(close);
  return <section ref={ref} role="dialog" aria-modal="true" aria-label="Fixture">
    <button>Close</button><button disabled={disabled}>Choose local image</button>
    <div aria-hidden="true">{loaded && <img alt="" src="data:image/png;base64,AA==" />}</div>
    <p role="status">{loaded ? "Image loaded" : "Loading image"}</p>
  </section>;
}

async function render(loaded = false, disabled = false) {
  await act(async () => root.render(<Dialog loaded={loaded} disabled={disabled} />));
  await act(async () => { await vi.runOnlyPendingTimersAsync(); });
}

beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => window.setTimeout(() => callback(0), 0));
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(id => window.clearTimeout(id));
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(() => [new DOMRect(0, 0, 100, 30)] as unknown as DOMRectList);
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scroll });
  opener = document.createElement("button"); document.body.append(opener); opener.focus();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  scroll.mockClear(); close.mockClear();
});

afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); opener.remove();
  delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});

describe("dialog focus during asynchronous presentation", () => {
  it("preserves valid focus and user scrolling when an image and status arrive", async () => {
    await render();
    const selected = container.querySelectorAll("button")[1]; selected.focus(); scroll.mockClear();
    await render(true);
    expect(document.activeElement).toBe(selected);
    expect(scroll).not.toHaveBeenCalled();
  });

  it("recovers a disabled control and retains keyboard trapping and Escape", async () => {
    await render();
    container.querySelectorAll("button")[1].focus();
    await render(true, true);
    expect(document.activeElement).toBe(container.querySelector("button"));
    const dialog = container.querySelector("section")!;
    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    dialog.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(container.querySelector("button"));
    dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(close).toHaveBeenCalledTimes(1);
    await act(async () => root.render(null));
    expect(document.activeElement).toBe(opener);
  });
});

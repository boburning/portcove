import { captureParityState } from "../../test/parity-capture";
import { useState } from "react";
import { DirectionProvider } from "@base-ui/react/direction-provider";
import { Boxes, Library } from "lucide-react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { CommandPalette, type PaletteCommand } from "../components/CommandPalette";
import "../styles/index.css";

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
});

function commandList(first: () => void, second: () => void): PaletteCommand[] {
  return [
    {
      id: "library",
      label: "Open library",
      description: "Installed ports",
      icon: Library,
      action: first,
    },
    {
      id: "catalog",
      label: "Open catalog",
      description: "Browse ports",
      icon: Boxes,
      action: second,
    },
  ];
}

it("keeps composition input inert and resumes normal selection through real close/reopen", async () => {
  const first = vi.fn();
  const second = vi.fn();
  const commands = commandList(first, second);
  function Fixture() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button onClick={() => setOpen(true)}>Open commands</button>
        <CommandPalette open={open} commands={commands} close={() => setOpen(false)} />
      </>
    );
  }
  flushSync(() =>
    root.render(
      <DirectionProvider direction="ltr">
        <Fixture />
      </DirectionProvider>,
    ),
  );
  await userEvent.click(page.getByRole("button", { name: "Open commands" }));
  const input = document.querySelector<HTMLInputElement>('[role="combobox"]')!;
  await expect.poll(() => document.activeElement === input).toBe(true);
  await captureParityState("command-palette-focused");
  input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  for (const key of ["ArrowDown", "ArrowUp", "Enter"]) {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    input.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(input.getAttribute("aria-activedescendant")).toBe("command-library");
  }
  expect(first).not.toHaveBeenCalled();
  expect(second).not.toHaveBeenCalled();
  input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 229, bubbles: true }));
  expect(first).not.toHaveBeenCalled();
  await userEvent.keyboard("{ArrowDown}{Enter}");
  expect(first).not.toHaveBeenCalled();
  expect(second).toHaveBeenCalledOnce();
  await expect
    .element(page.getByRole("dialog", { name: "Portcove commands" }))
    .not.toBeInTheDocument();
  await userEvent.click(page.getByRole("button", { name: "Open commands" }));
  await expect.poll(() => document.activeElement?.getAttribute("role")).toBe("combobox");
  await userEvent.keyboard("{Enter}");
  expect(first).toHaveBeenCalledOnce();
  expect(second).toHaveBeenCalledOnce();
});

it("holds repeated Enter on search and focused options and consumes a deferred-close dispatch once", async () => {
  const first = vi.fn();
  const second = vi.fn();
  const close = vi.fn();
  flushSync(() =>
    root.render(
      <DirectionProvider direction="ltr">
        <CommandPalette open commands={commandList(first, second)} close={close} />
      </DirectionProvider>,
    ),
  );
  const input = document.querySelector<HTMLInputElement>('[role="combobox"]')!;
  await expect.poll(() => document.activeElement === input).toBe(true);
  const repeat = (target: Element) => {
    const event = new KeyboardEvent("keydown", {
      key: "Enter",
      repeat: true,
      bubbles: true,
      cancelable: true,
    });
    target.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  };
  repeat(input);
  const option = document.querySelector<HTMLButtonElement>("#command-library")!;
  option.focus();
  repeat(option);
  expect(close).not.toHaveBeenCalled();
  await userEvent.keyboard("{Enter}");
  expect(first).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
  await userEvent.click(page.getByRole("option", { name: "Open catalog Browse ports" }));
  input.focus();
  await userEvent.keyboard("{Enter}");
  expect(first).toHaveBeenCalledOnce();
  expect(second).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledOnce();
});

it("shows a typed query verbatim in the no-match message in the current language", async () => {
  const { initializeLocalization } = await import("../localization");
  const localization = initializeLocalization(["en-US"]);
  flushSync(() =>
    root.render(
      <DirectionProvider direction="ltr">
        <CommandPalette open commands={commandList(vi.fn(), vi.fn())} close={vi.fn()} />
      </DirectionProvider>,
    ),
  );
  const input = await vi.waitFor(() => {
    const element = document.querySelector<HTMLInputElement>('input[role="combobox"]');
    expect(element).not.toBeNull();
    return element!;
  });
  // A `{{…}}` sequence typed by the player must never be treated as interpolation.
  await userEvent.type(input, "zz {{{{count}}");
  const status = () => document.querySelector('[role="status"]')?.textContent ?? "";
  await expect.poll(status).toBe("No command matches “zz {{count}}”.");
  try {
    await localization.changeLanguage("ar-XB");
    await expect.poll(status).toBe("لا يوجد أمر يطابق “zz {{count}}”.");
    expect(input.getAttribute("aria-label")).toBe("البحث في الأوامر");
  } finally {
    await localization.changeLanguage("en");
  }
  await expect.poll(status).toBe("No command matches “zz {{count}}”.");
});

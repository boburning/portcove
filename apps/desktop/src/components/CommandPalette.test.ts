// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Boxes, Library } from "lucide-react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { CommandPalette, filterCommands, type PaletteCommand } from "./CommandPalette";

const commands: PaletteCommand[] = [
  {
    id: "library",
    label: "Open library",
    description: "Installed ports",
    keywords: "collection",
    icon: Library,
    action: vi.fn(),
  },
  {
    id: "catalog",
    label: "Open port catalog",
    description: "Browse supported ports",
    keywords: "discover",
    icon: Boxes,
    action: vi.fn(),
  },
];

describe("command palette", () => {
  it("has an exact dialog name and labelled search control in the rendered DOM", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    HTMLElement.prototype.scrollIntoView = vi.fn();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () =>
        root.render(createElement(CommandPalette, { open: true, commands, close: vi.fn() })),
      );
      const dialog = document.body.querySelector('[role="dialog"]');
      expect(dialog?.getAttribute("aria-labelledby")).toBe("command-palette-title");
      expect(dialog?.querySelector("#command-palette-title")?.textContent).toBe(
        "Portcove commands",
      );
      expect(dialog?.querySelector('input[aria-label="Search commands"]')).not.toBeNull();
      expect(host.contains(dialog)).toBe(false);
    } finally {
      await act(async () => root.unmount());
      host.remove();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  });

  it("matches labels, descriptions, and keywords with every search term", () => {
    expect(filterCommands(commands, "installed collection").map((command) => command.id)).toEqual([
      "library",
    ]);
    expect(filterCommands(commands, "browse port").map((command) => command.id)).toEqual([
      "catalog",
    ]);
    expect(filterCommands(commands, "missing")).toEqual([]);
  });

  it("announces an empty command set without an empty listbox or active option", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    HTMLElement.prototype.scrollIntoView = vi.fn();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () =>
        root.render(
          createElement(CommandPalette, {
            open: true,
            commands: [],
            close: vi.fn(),
          }),
        ),
      );
      const search = document.body.querySelector('[role="combobox"]');
      expect(search?.getAttribute("aria-expanded")).toBe("false");
      expect(document.body.querySelector('[role="status"]')?.textContent).toContain(
        "No commands are available.",
      );
      expect(document.body.querySelector('[role="listbox"]')).toBeNull();
      expect(search?.hasAttribute("aria-controls")).toBe(false);
      expect(search?.hasAttribute("aria-activedescendant")).toBe(false);
    } finally {
      await act(async () => root.unmount());
      host.remove();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  });
});

describe("command search transitions", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    HTMLElement.prototype.scrollIntoView = vi.fn();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("keeps an empty search inert and restores keyboard selection when matches return", async () => {
    const action = vi.fn();
    const close = vi.fn();
    await act(async () =>
      root.render(
        createElement(CommandPalette, {
          open: true,
          commands: [{ ...commands[0], action }],
          close,
        }),
      ),
    );
    const search = document.body.querySelector("input")!;
    const change = async (value: string) =>
      act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
          search,
          value,
        );
        search.dispatchEvent(new Event("input", { bubbles: true }));
      });
    const key = async (value: string) =>
      act(async () => {
        search.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: value,
            bubbles: true,
            cancelable: true,
          }),
        );
      });
    await change("owned-no-matching-command");
    expect(document.body.querySelector('[role="status"]')?.textContent).toContain(
      "No command matches",
    );
    expect(document.body.querySelector('[role="listbox"]')).toBeNull();
    expect(search.getAttribute("aria-expanded")).toBe("false");
    expect(search.hasAttribute("aria-controls")).toBe(false);
    await key("ArrowDown");
    await key("Enter");
    expect(action).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(search.hasAttribute("aria-activedescendant")).toBe(false);
    await change("library");
    expect(search.getAttribute("aria-expanded")).toBe("true");
    expect(search.getAttribute("aria-activedescendant")).toBe("command-library");
    expect(document.body.querySelector('[role="option"]')?.getAttribute("aria-selected")).toBe(
      "true",
    );
    await key("Enter");
    expect(action).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it("recovers search focus when an asynchronous command update removes the focused option", async () => {
    await act(async () =>
      root.render(createElement(CommandPalette, { open: true, commands, close: vi.fn() })),
    );
    const search = document.body.querySelector<HTMLInputElement>(
      'input[aria-label="Search commands"]',
    )!;
    const focusedOption = document.body.querySelector<HTMLButtonElement>('[role="option"]')!;
    focusedOption.focus();
    expect(document.activeElement).toBe(focusedOption);
    await act(async () =>
      root.render(createElement(CommandPalette, { open: true, commands: [], close: vi.fn() })),
    );
    await act(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => resolve());
        }),
    );
    expect(document.activeElement).toBe(search);
  });
});

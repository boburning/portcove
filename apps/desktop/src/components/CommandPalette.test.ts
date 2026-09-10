// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Boxes, Library } from "lucide-react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { CommandPalette, filterCommands, type PaletteCommand } from "./CommandPalette";

const commands: PaletteCommand[] = [
  { id: "library", label: "Open library", description: "Installed ports", keywords: "collection", icon: Library, action: vi.fn() },
  { id: "catalog", label: "Open port catalog", description: "Browse supported ports", keywords: "discover", icon: Boxes, action: vi.fn() },
];

describe("command palette", () => {
  it("has an exact dialog name and labelled search control in the rendered DOM", () => {
    const html = renderToStaticMarkup(createElement(CommandPalette, { open: true, commands, close: vi.fn() }));
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-labelledby="command-palette-title"');
    expect(html).toContain('<h2 class="sr-only" id="command-palette-title">Portcove commands</h2>');
    expect(html).toContain('aria-label="Search commands"');
  });

  it("matches labels, descriptions, and keywords with every search term", () => {
    expect(filterCommands(commands, "installed collection").map(command => command.id)).toEqual(["library"]);
    expect(filterCommands(commands, "browse port").map(command => command.id)).toEqual(["catalog"]);
    expect(filterCommands(commands, "missing")).toEqual([]);
  });

  it("announces an empty command set without an empty listbox or active option", () => {
    const html = renderToStaticMarkup(createElement(CommandPalette, { open: true, commands: [], close: vi.fn() }));
    expect(html).toContain('role="combobox"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('role="status">No commands are available.');
    expect(html).not.toContain('role="listbox"');
    expect(html).not.toContain("aria-controls");
    expect(html).not.toContain("aria-activedescendant");
  });
});

describe("command search transitions", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    HTMLElement.prototype.scrollIntoView = vi.fn();
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  });

  it("keeps an empty search inert and restores keyboard selection when matches return", async () => {
    const action = vi.fn(); const close = vi.fn();
    await act(async () => root.render(createElement(CommandPalette, { open: true, commands: [{ ...commands[0], action }], close })));
    const search = host.querySelector("input")!;
    const change = async (value: string) => act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, value);
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const key = async (value: string) => act(async () => {
      search.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }));
    });
    await change("owned-no-matching-command");
    expect(host.querySelector('[role="status"]')?.textContent).toContain("No command matches");
    expect(host.querySelector('[role="listbox"]')).toBeNull();
    expect(search.getAttribute("aria-expanded")).toBe("false");
    expect(search.hasAttribute("aria-controls")).toBe(false);
    await key("ArrowDown"); await key("Enter");
    expect(action).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled();
    expect(search.hasAttribute("aria-activedescendant")).toBe(false);
    await change("library");
    expect(search.getAttribute("aria-expanded")).toBe("true");
    expect(search.getAttribute("aria-activedescendant")).toBe("command-library");
    expect(host.querySelector('[role="option"]')?.getAttribute("aria-selected")).toBe("true");
    await key("Enter");
    expect(action).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce();
  });
});

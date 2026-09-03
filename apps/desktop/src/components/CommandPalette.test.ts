import { describe, expect, it, vi } from "vitest";
import { Boxes, Library } from "lucide-react";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
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
});

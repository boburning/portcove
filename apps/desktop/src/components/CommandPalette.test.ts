import { expect, it, vi } from "vite-plus/test";
import { Boxes, Library } from "lucide-react";
import { filterCommands, type PaletteCommand } from "./CommandPalette";
const commands: [PaletteCommand, PaletteCommand] = [
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
    label: "Open Find games",
    description: "Browse supported ports",
    keywords: "discover",
    icon: Boxes,
    action: vi.fn(),
  },
];

it("matches labels, descriptions, and keywords with every search term", () => {
  expect(filterCommands(commands, "installed collection").map((command) => command.id)).toEqual([
    "library",
  ]);
  expect(filterCommands(commands, "browse port").map((command) => command.id)).toEqual(["catalog"]);
  expect(filterCommands(commands, "missing")).toEqual([]);
});

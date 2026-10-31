import { expect, it, vi } from "vite-plus/test";
import { Boxes, Library } from "lucide-react";
import { contiguousCommandGroups, filterCommands, type PaletteCommand } from "./CommandPalette";
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

it("keeps repeated presentation groups contiguous without reordering commands", () => {
  const registry = [
    { ...commands[0], group: "Navigation" },
    { ...commands[1], group: "Library actions" },
    { ...commands[0], id: "settings", group: "Navigation" },
  ];
  const groups = contiguousCommandGroups(registry);
  expect(groups.map((group) => group.label)).toEqual([
    "Navigation",
    "Library actions",
    "Navigation",
  ]);
  expect(groups.flatMap((group) => group.commands)).toEqual(registry);
});

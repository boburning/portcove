import { expect, it } from "vite-plus/test";
import { portDefinition } from "../../test-fixtures";
import { groupCatalog } from "./original-game";
import {
  collectionAnchorAligned,
  discoverDestinationIndex,
  discoverRows,
  resolvedGridColumns,
} from "./virtual-discover-model";

const ports = Array.from({ length: 17 }, (_, index) => ({
  ...portDefinition(),
  id: `port-${index}`,
}));
const groups = groupCatalog(ports);

it("groups complete visual rows without widening the final partial row", () => {
  const rows = discoverRows(groups, 4);
  expect(rows.map(({ groups }) => groups.length)).toEqual([4, 4, 4, 4, 1]);
  expect(rows.flatMap(({ groups }) => groups)).toEqual(groups);
  expect(discoverRows(groups, 1)).toHaveLength(17);
});

it("retains structural keys through new data objects and changes keys on actual regrouping", () => {
  const before = discoverRows(groups, 4);
  expect(
    discoverRows(
      groups.map((group) => ({ ...group })),
      4,
    ).map(({ key }) => key),
  ).toEqual(before.map(({ key }) => key));
  expect(discoverRows(groups, 3)[0]?.key).not.toBe(before[0]?.key);
});

it("resolves exact origin, implementation and group identities against the accepted model", () => {
  expect(discoverDestinationIndex(groups, { originKey: "catalog:card:port-14:details" })).toBe(14);
  expect(discoverDestinationIndex(groups, { groupKey: groups[9]!.id })).toBe(9);
  expect(discoverDestinationIndex(groups, { portId: "port-3" })).toBe(3);
  expect(discoverDestinationIndex(groups.slice(0, 2), { portId: "port-14" })).toBe(-1);
  expect(discoverDestinationIndex(groups, { originKey: "catalog:card:port-140:details" })).toBe(-1);
});

it("uses resolved CSS tracks as the column authority", () => {
  expect(resolvedGridColumns("220px 220px 220px 220px")).toBe(4);
  expect(resolvedGridColumns("157.25px 157.25px")).toBe(2);
  expect(resolvedGridColumns("none")).toBe(1);
});

it("resolves Library identity, menu and alternative origins without prefix collisions", () => {
  expect(discoverDestinationIndex(groups, { originKey: "library:card:port-14:play" })).toBe(14);
  expect(discoverDestinationIndex(groups, { originKey: "library:card:port-140:play" })).toBe(-1);
  for (const control of ["card", "card-more", "alternative"]) {
    expect(discoverDestinationIndex(groups, { originKey: `library:${control}:port-14` })).toBe(14);
    expect(discoverDestinationIndex(groups, { originKey: `library:${control}:port-140` })).toBe(-1);
    expect(
      discoverDestinationIndex(groups.slice(0, 2), { originKey: `library:${control}:port-14` }),
    ).toBe(-1);
  }
});

it("accepts the fractional upper scroll edge observed at 200% in Windows", () => {
  expect(collectionAnchorAligned(2, 115.5, 116)).toBe(true);
  expect(collectionAnchorAligned(2, 114.75, 116)).toBe(false);
  expect(collectionAnchorAligned(0.75, 115, 116)).toBe(false);
  expect(collectionAnchorAligned(0.25, 50, 116)).toBe(true);
  expect(collectionAnchorAligned(-2, 0, 116)).toBe(true);
});

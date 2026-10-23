import { collectionArtwork } from "./collection-artwork.ts";

/** Shared comparison-only content. Never catalog data or artwork-provider mappings. */
export const comparisonEntries = Array.from({ length: 12 }, (_, index) => ({
  id: `comparison-${index}`,
  title:
    index < 2
      ? "Harbor Adventure"
      : index === 2
        ? "The Very Long Voyage Beyond the Northern Sea — Complete Edition / Édition complète"
        : ["Orchard Quest", "Summit Racer", "Moonlit Harbor", "The Last Station"][index % 4]!,
  port:
    index === 0
      ? "Harbor desktop port"
      : index === 1
        ? "Harbor modern port"
        : `Collection port ${index + 1}`,
  variant: index === 1 ? "Modern renderer" : null,
  state: index === 4 ? ("missing" as const) : ("ready" as const),
  version: "1.2",
  artwork:
    index === 4
      ? null
      : {
          png: collectionArtwork[index % 3]!,
          width: [120, 180, 120][index % 3]!,
          height: [180, 100, 120][index % 3]!,
        },
}));

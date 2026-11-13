import {
  annotateCatalogAuthoring,
  annotateCatalogGuideCopy,
  annotateDiscoveryPlatforms,
} from "./catalog-guide-copy-impact.mts";
import { annotateNextest } from "./nextest-equivalence.mts";
import type { NextestChange } from "./nextest-equivalence.mts";

export function annotateChanges<Change extends NextestChange>(
  changes: Change[],
  readBefore: (file: string) => string,
  readAfter: (file: string) => string,
) {
  return annotateDiscoveryPlatforms(
    annotateCatalogGuideCopy(
      annotateCatalogAuthoring(
        annotateNextest(changes, readBefore, readAfter),
        readBefore,
        readAfter,
      ),
      readBefore,
      readAfter,
    ),
    readBefore,
    readAfter,
  );
}

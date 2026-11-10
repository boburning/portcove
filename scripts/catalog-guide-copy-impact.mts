import {
  isCatalogAuthoringProof,
  isDiscoveryPlatformProof,
  isGuideCopyProof,
} from "./validation-plan.mts";
import type {
  CatalogAuthoringProof,
  DiscoveryPlatformProof,
  GuideCopyProof,
} from "./validation-plan.mts";
import { lstatSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  checkedAuthoredPort,
  parseCatalogSource,
  projectAuthoredPort,
} from "./catalog-authoring.mts";
import { isRecord } from "./runtime-values.mts";

export const catalogGuideCopyMaxBytes = 8 * 1024 * 1024;

export function decodeGuideCopyBlob(blob: unknown) {
  if (!Buffer.isBuffer(blob) || blob.length > catalogGuideCopyMaxBytes)
    throw new Error("Guide copy proof requires bounded bytes");
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(blob);
}

export function readGuideCopyBlob(pathname: string) {
  const info = lstatSync(pathname);
  if (!info.isFile() || info.size > catalogGuideCopyMaxBytes)
    throw new Error("Catalog guide proof needs a bounded regular checkout file");
  return decodeGuideCopyBlob(readFileSync(pathname));
}

const root = "crates/portcove-core/catalog/";
const aggregates = new Map([
  [`${root}catalog.json`, "ports"],
  [`${root}listings.json`, "listings"],
]);
const authoredPath = /^crates\/portcove-core\/catalog\/ports\/([a-z0-9][a-z0-9-]*)\.json$/u;

interface GuideCopyChange {
  status: string;
  oldPath?: string | null;
  newPath?: string | null;
  oldMode?: string | null;
  newMode?: string | null;
  guide_copy?: GuideCopyProof;
}

function findTitle(changes: readonly GuideCopyChange[]) {
  if (changes.length !== aggregates.size + 1) return null;
  const files = new Set<string>();
  let title: string | undefined;
  for (const change of changes) {
    const file = change.newPath;
    if (
      !file ||
      change.oldPath !== file ||
      change.status !== "M" ||
      change.oldMode !== "100644" ||
      change.newMode !== change.oldMode ||
      files.has(file)
    )
      return null;
    files.add(file);
    if (aggregates.has(file)) continue;
    if (title) return null;
    title = authoredPath.exec(file)?.[1];
    if (!title) return null;
  }
  return title ? { id: title, files } : null;
}

function references(document: unknown, file: string, id: string) {
  if (!isRecord(document)) return null;
  const aggregate = aggregates.get(file);
  let listing: unknown;
  if (!aggregate) {
    listing = document.listing;
    if (!isRecord(listing) || listing.id !== id) return null;
  } else {
    const entries = document[aggregate];
    if (!Array.isArray(entries)) return null;
    const matches = entries.filter((entry) => isRecord(entry) && entry.id === id);
    if (matches.length !== 1) return null;
    const entry: unknown = matches[0];
    if (!isRecord(entry)) return null;
    listing = aggregate === "ports" ? entry.presentation : entry;
  }
  if (!isRecord(listing) || !isRecord(listing.manual_setup)) return null;
  const result = listing.manual_setup.references;
  return Array.isArray(result) ? result : null;
}

// Compare the authored record and every generated projection. A parser error,
// shape change, or independently changed projection keeps normal validation.
export function proveCatalogGuideCopy(
  changes: readonly GuideCopyChange[],
  readBefore: (file: string) => string,
  readAfter: (file: string) => string,
): Map<string, GuideCopyProof> | null {
  const scope = findTitle(changes);
  if (!scope) return null;
  let expected: [number, string, string][] | undefined;
  const proof = new Map<string, GuideCopyProof>();
  try {
    for (const file of scope.files) {
      const before = readBefore(file);
      const after = readAfter(file);
      const limit = aggregates.has(file) ? catalogGuideCopyMaxBytes : 512 * 1024;
      if (Buffer.byteLength(before) > limit || Buffer.byteLength(after) > limit) return null;
      const oldDocument = parseCatalogSource(before);
      const newDocument = parseCatalogSource(after);
      if (!hasExactIntegers(before) || !hasExactIntegers(after)) return null;
      const oldReferences = references(oldDocument, file, scope.id);
      const newReferences = references(newDocument, file, scope.id);
      if (!oldReferences || !newReferences || oldReferences.length !== newReferences.length)
        return null;
      const edits: [number, string, string][] = [];
      for (const [index, item] of newReferences.entries()) {
        const previous: unknown = oldReferences[index];
        if (!isRecord(item) || !isRecord(previous)) return null;
        if (typeof item.instruction !== "string" || typeof previous.instruction !== "string")
          return null;
        if (item.instruction === previous.instruction) continue;
        edits.push([index, previous.instruction, item.instruction]);
        item.instruction = previous.instruction;
      }
      if (!edits.length || !isDeepStrictEqual(oldDocument, newDocument)) return null;
      if (expected && !isDeepStrictEqual(expected, edits)) return null;
      expected = edits;
      proof.set(file, {
        kind: "catalog-guide-reference-copy-v1",
        before: hashText(before),
        after: hashText(after),
      });
    }
  } catch {
    return null;
  }
  return proof;
}

// Keep the broad path for JSON number spellings that JS can round or alias.
function hasExactIntegers(text: string) {
  for (const [token] of text.matchAll(
    /"(?:[^"\\]|\\[\s\S])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/gu,
  )) {
    if (token.startsWith('"')) continue;
    const value = Number(token);
    if (!Number.isSafeInteger(value) || String(value) !== token) return false;
  }
  return true;
}

function hashText(text: string) {
  return createHash("sha256").update(text).digest("hex");
}

export function annotateCatalogGuideCopy<Change extends GuideCopyChange>(
  changes: Change[],
  readBefore: (file: string) => string,
  readAfter: (file: string) => string,
): (Change & { guide_copy?: GuideCopyProof })[] {
  const proof = proveCatalogGuideCopy(changes, readBefore, readAfter);
  if (!proof) return changes;
  return changes.map((change) => {
    const guide_copy = proof.get(change.newPath ?? "");
    return guide_copy ? { ...change, guide_copy } : change;
  });
}

export function hasCatalogGuideCopy(
  changes: readonly GuideCopyChange[],
  readCheckout: (file: string) => string,
) {
  if (!findTitle(changes)) return false;
  try {
    return changes.every(
      ({ newPath, guide_copy }) =>
        !!newPath &&
        isGuideCopyProof(guide_copy) &&
        hashText(readCheckout(newPath)) === guide_copy.after,
    );
  } catch {
    return false;
  }
}

// A raw title record is normally a broad input. Prove only a conversion
// to or from a maintained layout marker, preserving every other authored fact.
interface AuthoringChange extends GuideCopyChange {
  catalog_authoring?: CatalogAuthoringProof;
}

const listingsFile = `${root}listings.json`;
const operationalFile = `${root}catalog.json`;

interface DiscoveryPlatformChange extends GuideCopyChange {
  discovery_platforms?: DiscoveryPlatformProof;
}

export function isDiscoveryEvidencePath(file: string) {
  return /^docs\/qualification\/[a-z0-9][a-z0-9-]*-\d{4}-\d{2}-\d{2}\.md$/u.test(file);
}

function discoveryPlatformFiles(changes: readonly DiscoveryPlatformChange[]) {
  const files = new Map<string, string>();
  const seen = new Set<string>();
  for (const change of changes) {
    const file = change.newPath;
    if (!file || seen.has(file) || change.newMode !== "100644" || change.oldPath !== file)
      return null;
    seen.add(file);
    if (
      isDiscoveryEvidencePath(file) &&
      ((change.status === "M" && change.oldMode === "100644") ||
        (["A", "?"].includes(change.status) && change.oldMode === "000000"))
    )
      continue;
    if (change.status !== "M" || change.oldMode !== change.newMode) return null;
    if (file === listingsFile) {
      files.set(file, "");
    } else {
      const id = authoringTitle(change);
      if (!id) return null;
      files.set(file, id);
    }
  }
  return files.size > 1 && files.has(listingsFile) ? files : null;
}

function discoveryPlatformDelta(before: Record<string, unknown>, after: Record<string, unknown>) {
  const { platforms: previous = [], download_asset_hints: oldHints = {}, ...oldFacts } = before;
  const { platforms: next, download_asset_hints: newHints, ...newFacts } = after;
  if (
    !isDeepStrictEqual(oldFacts, newFacts) ||
    before.availability !== "packages" ||
    !Array.isArray(previous) ||
    !Array.isArray(next) ||
    !isRecord(oldHints) ||
    !isRecord(newHints) ||
    new Set(next).size !== next.length ||
    !isDeepStrictEqual(previous, next.slice(0, previous.length))
  )
    return null;
  const added: unknown[] = next.slice(previous.length);
  if (!added.length) return null;
  const hints: Record<string, unknown> = {};
  for (const platform of added) {
    if (typeof platform !== "string") return null;
    const values = newHints[platform];
    if (
      Object.hasOwn(oldHints, platform) ||
      !Array.isArray(values) ||
      !values.length ||
      values.some((value) => typeof value !== "string" || !value.trim())
    )
      return null;
    hints[platform] = values;
  }
  return isDeepStrictEqual(newHints, { ...oldHints, ...hints }) ? { added, hints } : null;
}

export function annotateDiscoveryPlatforms<Change extends DiscoveryPlatformChange>(
  changes: Change[],
  readBefore: (file: string) => string,
  readAfter: (file: string) => string,
): (Change & { discovery_platforms?: DiscoveryPlatformProof })[] {
  const files = discoveryPlatformFiles(changes);
  if (!files) return changes;
  try {
    const operational = readBefore(operationalFile);
    if (operational !== readAfter(operationalFile)) return changes;
    const hash = hashText(operational);
    const proofs = new Map<string, DiscoveryPlatformProof>();
    const expected = new Map<string, ReturnType<typeof discoveryPlatformDelta>>();
    const read = (file: string, limit: number) => {
      const before = readBefore(file);
      const after = readAfter(file);
      if (
        [before, after].some((text) => Buffer.byteLength(text) > limit || !hasExactIntegers(text))
      )
        throw new Error("Unsupported catalog discovery bytes");
      proofs.set(file, {
        kind: "catalog-discovery-platforms-v1",
        before: hashText(before),
        after: hashText(after),
        operational: hash,
      });
      return [parseCatalogSource(before), parseCatalogSource(after)];
    };
    for (const [file, id] of files) {
      if (!id) continue;
      const [before, after] = read(file, 512 * 1024);
      const oldRecord = checkedAuthoredPort(before, id);
      const newRecord = checkedAuthoredPort(after, id);
      if (projectAuthoredPort(oldRecord) || projectAuthoredPort(newRecord)) return changes;
      const { listing: oldListing, ...oldRecordFacts } = oldRecord;
      const { listing: newListing, ...newRecordFacts } = newRecord;
      const delta = discoveryPlatformDelta(oldListing, newListing);
      if (!delta || !isDeepStrictEqual(oldRecordFacts, newRecordFacts)) return changes;
      expected.set(id, delta);
    }
    const [before, after] = read(listingsFile, catalogGuideCopyMaxBytes);
    if (!isRecord(before) || !isRecord(after)) return changes;
    const { listings: oldRows, ...oldDirectoryFacts } = before;
    const { listings: newRows, ...newDirectoryFacts } = after;
    if (
      !Array.isArray(oldRows) ||
      !Array.isArray(newRows) ||
      oldRows.length !== newRows.length ||
      !isDeepStrictEqual(oldDirectoryFacts, newDirectoryFacts)
    )
      return changes;
    for (const [index, row] of oldRows.entries()) {
      const next: unknown = newRows[index];
      if (isDeepStrictEqual(row, next)) continue;
      if (!isRecord(row) || !isRecord(next) || typeof row.id !== "string") return changes;
      if (
        !expected.has(row.id) ||
        !isDeepStrictEqual(discoveryPlatformDelta(row, next), expected.get(row.id))
      )
        return changes;
      expected.delete(row.id);
    }
    if (expected.size) return changes;
    return changes.map((change) => {
      const proof = proofs.get(change.newPath ?? "");
      return proof ? { ...change, discovery_platforms: proof } : change;
    });
  } catch {
    return changes;
  }
}

export function hasDiscoveryPlatformProof(
  changes: readonly DiscoveryPlatformChange[],
  readCheckout: (file: string) => string,
) {
  const files = discoveryPlatformFiles(changes);
  if (!files) return false;
  try {
    const operational = hashText(readCheckout(operationalFile));
    return changes.every((change) => {
      const file = change.newPath!;
      if (!files.has(file)) return change.discovery_platforms === undefined;
      const proof = change.discovery_platforms;
      return (
        isDiscoveryPlatformProof(proof) &&
        proof.operational === operational &&
        hashText(readCheckout(file)) === proof.after
      );
    });
  } catch {
    return false;
  }
}

function authoringTitle(change: AuthoringChange) {
  if (
    change.status !== "M" ||
    change.oldPath !== change.newPath ||
    change.oldMode !== "100644" ||
    change.newMode !== change.oldMode
  )
    return undefined;
  const id = authoredPath.exec(change.newPath ?? "")?.[1];
  // The Rust suite also reads this raw authored file directly.
  return id === "shipwright" ? undefined : id;
}

export function annotateCatalogAuthoring<Change extends AuthoringChange>(
  changes: Change[],
  readBefore: (file: string) => string,
  readAfter: (file: string) => string,
): (Change & { catalog_authoring?: CatalogAuthoringProof })[] {
  if (!changes.length || changes.some((change) => !authoringTitle(change))) return changes;
  try {
    const annotated = changes.map((change) => {
      const id = authoringTitle(change)!;
      const file = change.newPath!;
      const before = readBefore(file);
      const after = readAfter(file);
      if (
        [before, after].some(
          (blob) => Buffer.byteLength(blob) > 512 * 1024 || !hasExactIntegers(blob),
        )
      )
        throw new Error("Unsupported authored title bytes");
      const oldRecord = checkedAuthoredPort(parseCatalogSource(before), id);
      const newRecord = checkedAuthoredPort(parseCatalogSource(after), id);
      const {
        integration: _oldIntegration,
        psx_managed_windows_v1: oldPsx,
        gba_staged_archive_v1: oldGba,
        ...oldFacts
      } = oldRecord;
      const {
        integration: _newIntegration,
        psx_managed_windows_v1: newPsx,
        gba_staged_archive_v1: newGba,
        ...newFacts
      } = newRecord;
      const oldProjection = oldPsx ?? oldGba;
      const newProjection = newPsx ?? newGba;
      if (
        (oldProjection === undefined) === (newProjection === undefined) ||
        !isDeepStrictEqual(oldFacts, newFacts) ||
        JSON.stringify(projectAuthoredPort(oldRecord)) !==
          JSON.stringify(projectAuthoredPort(newRecord))
      )
        throw new Error("Authored title projection changed");
      return {
        ...change,
        catalog_authoring: {
          kind: "catalog-authoring-equivalence-v1" as const,
          before: hashText(before),
          after: hashText(after),
        },
      };
    });
    return annotated;
  } catch {
    return changes;
  }
}

export function hasCatalogAuthoringEquivalence(
  changes: readonly AuthoringChange[],
  readCheckout: (file: string) => string,
) {
  if (!changes.length || new Set(changes.map((change) => change.newPath)).size !== changes.length)
    return false;
  try {
    return changes.every(
      (change) =>
        authoringTitle(change) &&
        isCatalogAuthoringProof(change.catalog_authoring) &&
        hashText(readCheckout(change.newPath!)) === change.catalog_authoring.after,
    );
  } catch {
    return false;
  }
}

import { expect, it } from "vite-plus/test";
import { readFileSync } from "node:fs";
import {
  implementationMetadata,
  implementationMethodKinds,
  readImplementationMetadata,
} from "./implementation-metadata";
import { evaluateCatalogQuery } from "./catalog-query";
import { portDefinition } from "../../test-fixtures";
import type { CatalogEntry } from "./catalog-entry";

function realEntry(id: string): CatalogEntry {
  const authored = JSON.parse(
    readFileSync(
      new URL(`../../../../../crates/portcove-core/catalog/ports/${id}.json`, import.meta.url),
      "utf8",
    ),
  );
  return {
    ...portDefinition(),
    ...authored.listing,
    listing: authored.listing,
    presentation: {
      ...portDefinition().presentation,
      implementation: authored.listing.implementation,
    },
  };
}
it("explains real alternative methods and dependencies without conflating original and target systems", () => {
  const sourcePort = realEntry("2ship2harkinian");
  const recomp = realEntry("zelda64-recomp");
  expect(implementationMethodKinds(sourcePort)).toEqual(["source-port"]);
  expect(implementationMethodKinds(recomp)).toEqual(["static-recompilation"]);
  expect(
    implementationMetadata(recomp)?.dependencies.find(
      (dependency) => dependency.kind === "toolchain",
    )?.name,
  ).toEqual("N64: Recompiled");
  expect(recomp.listing?.original_game?.source_editions[0]?.system).toEqual("nintendo-64");
  expect(
    implementationMetadata(sourcePort)?.dependencies.find(
      (dependency) => dependency.kind === "source-preparation",
    )?.name,
  ).toEqual("ZAPDTR");
  const ports = [sourcePort, recomp];
  expect(
    evaluateCatalogQuery(ports, {
      version: 1,
      implementationMethods: ["static-recompilation"],
    }).ports.map((port) => port.id),
  ).toEqual(["zelda64-recomp"]);
});
it("keeps absent, malformed and future optional metadata unavailable without hiding ordinary entries", () => {
  for (const metadata of [
    undefined,
    null,
    "bad",
    { format_version: 999, methods: [], dependencies: [] },
    {
      format_version: 1,
      methods: [],
      dependencies: [{ kind: "runtime", name: "Bad", project_url: "javascript:alert(1)" }],
    },
  ]) {
    expect(readImplementationMetadata(metadata)).toBeUndefined();
    const port = {
      ...portDefinition(),
      presentation: { ...portDefinition().presentation!, implementation: metadata },
    };
    expect(evaluateCatalogQuery([port], { version: 1 }).ports).toEqual([port]);
  }
  expect(
    readImplementationMetadata({
      format_version: 1,
      methods: [{ kind: "future-method", evidence_urls: ["https://example.com"] }],
      dependencies: [],
    }),
  ).toBeUndefined();
});
it("represents a shared runtime independently of the original game and preserves uncertain relationships", () => {
  const runtime = {
    kind: "runtime",
    project_url: "https://www.scummvm.org",
    name: "ScummVM",
    confidence: "confirmed",
    version_scope: "Documentation example only",
    evidence_urls: ["https://www.scummvm.org/faq/"],
  };
  for (const confidence of ["confirmed", "inferred", "contradicted"]) {
    const metadata = readImplementationMetadata({
      format_version: 1,
      methods: [
        { kind: "engine-reimplementation", evidence_urls: ["https://www.scummvm.org/faq/"] },
      ],
      dependencies: [{ ...runtime, confidence }],
    });
    expect(metadata?.dependencies[0]?.confidence).toEqual(confidence);
    expect(metadata?.methods[0]?.kind).toEqual("engine-reimplementation");
  }
});

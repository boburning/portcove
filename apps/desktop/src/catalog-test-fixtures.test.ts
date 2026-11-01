import { afterEach, expect, it, vi } from "vite-plus/test";
import catalog from "../../../crates/portcove-core/catalog/catalog.json";
import {
  authoredPortFixture,
  currentCatalogPort,
  serializedPortFixture,
  authoredSourceCatalogFixture,
  currentSourceCatalog,
} from "./catalog-test-fixtures";
import { portDefinition } from "./test-fixtures";

afterEach(() => {
  vi.doUnmock("../../../crates/portcove-core/catalog/catalog.json");
});

it("validates a complete typed generic builder without changing its values", () => {
  const fixture = portDefinition();
  expect(serializedPortFixture(fixture)).toBe(fixture);
});

it.each(["id", "release"])("refuses a missing mandatory serialized fixture field: %s", (field) => {
  const fixture: Record<string, unknown> = { ...portDefinition() };
  delete fixture[field];
  expect(() => serializedPortFixture(fixture)).toThrow(`required property '${field}'`);
});

it("refuses invalid nested provider values instead of hiding them with a type cast", () => {
  const base = portDefinition();
  expect(() =>
    serializedPortFixture({ ...base, release: { ...base.release, provider: "unknown-provider" } }),
  ).toThrow("allowed values");
});

it.each([
  "id",
  "name",
  "summary",
  "project_url",
  "support_tier",
  "channels",
  "platforms",
  "adapter",
  "release",
])("does not invent a missing mandatory authored catalog fact: %s", (field) => {
  const fixture: Record<string, unknown> = { ...portDefinition() };
  delete fixture[field];
  expect(() => authoredPortFixture(fixture)).toThrow(field);
});

it("validates intentional current catalog fixtures against the complete serialized contract", () => {
  for (const authored of catalog.ports) {
    const fixture = currentCatalogPort(authored.id);
    expect(fixture.id).toBe(authored.id);
    expect(fixture.name).toBe(authored.name);
    expect(fixture.release.repository).toBe(
      "repository" in authored.release ? authored.release.repository : "",
    );
  }
  expect(() => currentCatalogPort("missing-fixture-port")).toThrow("Missing embedded catalog");
});

it("loads generic component fixtures without reading the live catalog", async () => {
  vi.resetModules();
  vi.doMock("../../../crates/portcove-core/catalog/catalog.json", () => {
    throw new Error("Generic fixture attempted to read the live catalog");
  });
  const { port } = await import("./components/rendered-test-fixtures");
  expect(port.id).toBe("sample");
  expect(port.name).toBe("Sample Port");
  expect(port.presentation?.source_requirements[0]?.profile_id).toBe("sample-rom");
});

it("validates intentional source catalog fixtures without inventing missing claims", () => {
  const fixture = currentSourceCatalog();
  expect(fixture.identities).toEqual(catalog.source_catalog.identities);
  expect(fixture.contracts).toEqual(catalog.source_catalog.contracts);
  expect(fixture.qualification).toEqual(catalog.source_catalog.qualification);
  for (const field of ["identities", "contracts", "qualification", "validators", "evidence"]) {
    const incomplete: Record<string, unknown> = { ...catalog.source_catalog };
    delete incomplete[field];
    expect(() => authoredSourceCatalogFixture(incomplete)).toThrow(field);
  }
  const evidence = catalog.source_catalog.evidence.map((entry) => ({
    ...entry,
    role: "invented-role",
  }));
  expect(() => authoredSourceCatalogFixture({ ...catalog.source_catalog, evidence })).toThrow(
    "allowed values",
  );
});

it("validates Core decimal settings without accepting nonnumeric or nonfinite defaults", () => {
  const settings = structuredClone(
    currentCatalogPort("diddy-kong-racing-golden-balloon").game_settings,
  );
  if (!settings) throw new Error("Missing settings contract fixture");
  const file = settings.files[0];
  const setting = file?.settings[0];
  if (!file || !setting) throw new Error("Missing settings entry fixture");
  setting.value = {
    kind: "number",
    minimum: 0.75,
    maximum: 2,
    step: 0.05,
    default: 1,
  };
  const fixture = { ...portDefinition(), game_settings: settings };
  expect(serializedPortFixture(fixture)).toBe(fixture);
  for (const value of ["1", Number.NaN, Number.POSITIVE_INFINITY]) {
    const invalid: unknown = {
      ...fixture,
      game_settings: {
        ...settings,
        files: [
          {
            ...file,
            settings: [
              {
                ...setting,
                value: { kind: "number", minimum: 0.75, maximum: 2, step: 0.05, default: value },
              },
            ],
          },
        ],
      },
    };
    expect(() => serializedPortFixture(invalid)).toThrow("Invalid serialized port fixture");
  }
});

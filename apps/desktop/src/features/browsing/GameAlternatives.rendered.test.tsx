import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vite-plus/test";
import type { PortStatus } from "../../types";
import type { CatalogEntry } from "./catalog-entry";
import { ImplementationFacts } from "./GameAlternatives";

const port = {
  id: "p",
  name: "Port",
  summary: "Summary",
  platforms: [],
  presentation: { source_requirements: [{ label: "Disc {{x}}" }] },
} as unknown as CatalogEntry;
const status = { active: { version: "1.2.3" } } as unknown as PortStatus;

it("translates implementation fact labels and keeps exact values verbatim", async () => {
  const { initializeLocalization } = await import("../../localization");
  const localization = initializeLocalization(["en-US"]);
  const facts = () => renderToStaticMarkup(<ImplementationFacts port={port} status={status} />);
  expect(facts()).toContain("Runs on: Not recorded");
  expect(facts()).toContain("Original files: <bdi>Disc {{x}}</bdi>");
  expect(facts()).toContain("Managed installation · <bdi>1.2.3</bdi>");
  try {
    await localization.changeLanguage("ar-XB");
    expect(facts()).toContain("يعمل على: غير مسجل");
    expect(facts()).toContain("الملفات الأصلية: <bdi>Disc {{x}}</bdi>");
    expect(facts()).toContain("تثبيت مُدار · <bdi>1.2.3</bdi>");
  } finally {
    await localization.changeLanguage("en");
  }
});

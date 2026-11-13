import { afterEach, beforeEach, expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react";
import receipt from "../../../../crates/portcove-core/tests/fixtures/protection-copy.json";
import { portStatus } from "../test-fixtures";
import type { BackupInventory } from "../types";
import { ProtectionSummary } from "./ProtectionSummary";

type Protection = NonNullable<BackupInventory["protection"]>;
const snapshot = (): Protection => ({
  port_id: "sample",
  catalog: {
    definition_sha256: "a".repeat(64),
    saves_and_settings: null,
    persistent_paths: [],
    persistent_file_patterns: [],
  },
  managed_data: { path: "C:/library/user/sample", state: "present" },
  installations: [],
  latest_completed_backup: null,
  exclusions: receipt.exclusions,
  problem: null,
});
let previousViewport: { width: number; height: number };
beforeEach(() => {
  previousViewport = { width: window.innerWidth, height: window.innerHeight };
});
afterEach(async () => {
  await cleanup();
  await page.viewport(previousViewport.width, previousViewport.height);
});

it("renders service-authored exclusions visibly without calling candidate files a completed backup", async () => {
  await page.viewport(414, 896);
  const protection = snapshot();
  const status = portStatus();
  status.active = { id: "legacy" } as NonNullable<typeof status.active>;
  protection.installations = [
    {
      install_id: "legacy",
      version: "older",
      install_root: "C:/older",
      role: "active",
      update_owner: "portcove",
      retained: null,
      effective: null,
      collection: "unavailable",
      collection_root: null,
      collection_candidates: [],
      exclusions: [],
      problem: receipt.legacy_problem,
    },
  ];
  await render(
    <ProtectionSummary
      portId="sample"
      status={status}
      protection={protection}
      inventoryState="healthy"
      readState={{ status: "current", hasInventory: true }}
    />,
  );
  for (const text of receipt.exclusions)
    await expect.element(page.getByText(text, { exact: true })).toBeVisible();
  await expect
    .element(page.getByText("No completed backup recorded.", { exact: true }))
    .toBeVisible();
  const details = page.getByText("Backup check details", { exact: true });
  details.element().focus();
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByText(receipt.legacy_problem, { exact: true })).toBeVisible();
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
});

it.each(["pending", "failed"] as const)(
  "keeps %s information stale, including a known completed backup",
  async (state) => {
    const protection = snapshot();
    protection.latest_completed_backup = {
      id: "known",
      port_id: "sample",
      path: "C:/backup",
      created_at: 42,
      file_count: 2,
      size: 30,
      sha256: "b".repeat(64),
    };
    await render(
      <ProtectionSummary
        portId="sample"
        status={portStatus()}
        protection={protection}
        inventoryState="healthy"
        readState={{ status: state, hasInventory: true }}
      />,
    );
    await expect
      .element(page.getByText("Last loaded backup information", { exact: true }))
      .toBeVisible();
    await expect.element(page.getByText(/Last known completed backup:/)).toBeVisible();
    expect(document.body.textContent).not.toContain("Latest completed backup:");
    expect(document.body.textContent).not.toContain("No completed backup recorded.");
  },
);

it("keeps external folders excluded while listing files only as possible future backup contents", async () => {
  const protection = snapshot();
  const status = portStatus();
  status.external_runtime = { id: "external" } as NonNullable<typeof status.external_runtime>;
  protection.installations = [
    {
      install_id: "external",
      version: "external",
      install_root: "C:/external",
      role: "external",
      update_owner: "upstream_or_user",
      retained: null,
      effective: null,
      collection: "external_not_collected",
      collection_root: null,
      collection_candidates: [],
      exclusions: [receipt.external_exclusion],
      problem: null,
    },
  ];
  await render(
    <ProtectionSummary
      portId="sample"
      status={status}
      protection={protection}
      inventoryState="healthy"
      readState={{ status: "current", hasInventory: true }}
    />,
  );
  await expect.element(page.getByText(receipt.external_exclusion, { exact: true })).toBeVisible();
  await expect
    .element(page.getByText("Updates handled by: the game’s launcher or you.", { exact: true }))
    .toBeVisible();
  expect(document.body.textContent).not.toContain("Protected");
});

import { afterEach, expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react";
import type { PortStatus } from "../types";
import { CarriedFilesSummary } from "./CarriedFilesSummary";
import { initializeLocalization } from "../localization";
import "../styles/index.css";

afterEach(async () => {
  await cleanup();
  await initializeLocalization().changeLanguage("en");
});

function record(): NonNullable<PortStatus["carried_files"]> {
  return {
    from_install_id: "from",
    to_install_id: "to",
    from_version: "1.0",
    to_version: "2.0",
    from_path: "/games/earlier {{value}}",
    to_path: "/games/current",
    outcome: {
      carried: [],
      removed: [],
      kept_separately: ["notes/ملف {{count}}.txt"],
      source_unreadable: [],
      new_version_ships_file: [],
      insufficient_space: false,
      source_modified: false,
    },
  };
}

it("distinguishes complete counts from bounded examples and keeps exact paths as data", async () => {
  const value = record();
  value.outcome.counts = {
    carried: 0,
    removed: 0,
    kept_separately: 100,
    source_unreadable: 0,
    new_version_ships_file: 0,
  };
  await render(<CarriedFilesSummary record={value} />);
  await expect
    .element(
      page.getByText("Some files differed between versions. Each version kept its own copy."),
    )
    .toBeVisible();
  await page.getByText("Review the recorded file outcome").click();
  await expect.element(page.getByText("Recorded file count: 100", { exact: true })).toBeVisible();
  await expect.element(page.getByText("Only recorded path examples are listed.")).toBeVisible();
  await expect.element(page.getByText("notes/ملف {{count}}.txt", { exact: true })).toBeVisible();
  await expect.element(page.getByText("/games/earlier {{value}}", { exact: true })).toBeVisible();
  expect(
    page.getByText("notes/ملف {{count}}.txt", { exact: true }).element().getAttribute("dir"),
  ).toBe("ltr");
  expect(document.querySelectorAll("button")).toHaveLength(0);
});

it("does not invent a legacy total or coordinates for an unrecorded earlier version", async () => {
  const value = record();
  value.from_path = null;
  value.from_version = null;
  await render(<CarriedFilesSummary record={value} />);
  await page.getByText("Review the recorded file outcome").click();
  await expect.element(page.getByText("The complete file count was not recorded.")).toBeVisible();
  await expect
    .element(page.getByText("Folder is no longer recorded", { exact: true }))
    .toBeVisible();
  await expect
    .element(
      page.getByText(
        "The earlier version is no longer recorded. Its files have not been rechecked.",
      ),
    )
    .toBeVisible();
  await expect
    .element(page.getByText("Recorded file count: 1", { exact: true }))
    .not.toBeInTheDocument();
});

it("shows the recorded space outcome without blocking actions", async () => {
  const value = record();
  value.outcome.kept_separately = [];
  value.outcome.insufficient_space = true;
  value.outcome.not_carried_count = 3;
  value.outcome.required_bytes = 2_048;
  value.outcome.available_bytes = 1_024;
  await render(<CarriedFilesSummary record={value} />);
  await expect
    .element(
      page.getByText(
        "Files were left with the earlier version because there was not enough free space.",
      ),
    )
    .toBeVisible();
  await page.getByText("Review the recorded file outcome").click();
  await expect.element(page.getByText("2.0 KiB", { exact: true })).toBeVisible();
  await expect.element(page.getByText("Recorded file count: 3", { exact: true })).toBeVisible();
  await expect.element(page.getByText("1.0 KiB", { exact: true })).toBeVisible();
  expect(document.querySelectorAll('[role="alert"],button')).toHaveLength(0);
});

it("keeps a small successful copy in details without a notice", async () => {
  const value = record();
  value.outcome.kept_separately = [];
  value.outcome.carried = ["extra.ini"];
  value.outcome.carried_bytes = 20;
  value.outcome.counts = {
    carried: 1,
    removed: 0,
    kept_separately: 0,
    source_unreadable: 0,
    new_version_ships_file: 0,
  };
  await render(<CarriedFilesSummary record={value} />);
  await expect
    .element(page.getByRole("heading", { name: "Files kept during the version switch" }))
    .not.toBeInTheDocument();
  await page.getByText("Review the recorded file outcome").click();
  await expect.element(page.getByText("Recorded file count: 1", { exact: true })).toBeVisible();
});
it("explains a changed installation without claiming a carry or another integrity check", async () => {
  const value = record();
  value.outcome.kept_separately = [];
  value.outcome.source_modified = true;
  await render(<CarriedFilesSummary record={value} />);
  await expect
    .element(
      page.getByText(
        "Files were left with the earlier version because its installation had changed.",
      ),
    )
    .toBeVisible();
  expect(document.querySelectorAll('[role="alert"],button')).toHaveLength(0);
});

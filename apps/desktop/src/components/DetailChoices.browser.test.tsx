import { afterEach, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react";
import { SetupStatement, UpdateNoticePreferences, type DetailOrganization } from "./DetailChoices";
import { installRecord, updateCenterFixtures } from "./rendered-test-fixtures";
import { portStatus } from "../test-fixtures";
import type { LibraryOrganization, PortStatus } from "../types";

afterEach(cleanup);

function choices(snapshot: Partial<LibraryOrganization> = {}): DetailOrganization {
  return {
    snapshot: {
      revision: 1,
      followed_port_ids: [],
      followed_release_acknowledgments: {},
      collections: {},
      hidden_port_ids: [],
      saved_game_ids: [],
      update_notices: {},
      setup_confirmations: [],
      ...snapshot,
    },
    busy: false,
    failure: undefined,
    commit: vi.fn().mockResolvedValue(true),
    refresh: vi.fn().mockResolvedValue(true),
  };
}

it("records a user statement only for the selected installation and never supplies launch authority", async () => {
  const organization = choices();
  const status = { ...portStatus(), active: installRecord() };
  const root = await render(
    <SetupStatement portId="sample" status={status} organization={organization} />,
  );
  const statement = page.getByRole("checkbox");
  await statement.click();
  expect(organization.commit).toHaveBeenCalledExactlyOnceWith({
    kind: "set_setup_confirmation",
    confirmation: { port_id: "sample", context: { kind: "managed", installation_id: "1" } },
    confirmed: true,
  });
  await expect.element(page.getByText(/does not check game files/)).toBeVisible();
  await root.rerender(
    <SetupStatement portId="different-port" status={status} organization={organization} />,
  );
  await expect.element(page.getByRole("checkbox")).not.toBeInTheDocument();
});

it("does not reuse a setup statement after a managed installation is replaced", async () => {
  const organization = choices({
    setup_confirmations: [
      { port_id: "sample", context: { kind: "managed", installation_id: "previous" } },
    ],
  });
  await render(
    <SetupStatement
      portId="sample"
      status={{ ...portStatus(), active: installRecord() }}
      organization={organization}
    />,
  );
  await expect.element(page.getByRole("checkbox")).not.toBeChecked();
});

it("skips an exact checked artifact while leaving the saved notice policy independent", async () => {
  const organization = choices();
  const { priorResult } = updateCenterFixtures();
  const status: PortStatus = {
    ...portStatus(),
    active: installRecord(),
    last_update_check: { checked_at: 1, check: priorResult },
  };
  await render(
    <UpdateNoticePreferences portId="sample" status={status} organization={organization} />,
  );
  await expect
    .element(page.getByText(/only affect notices for this port in this library/))
    .toBeVisible();
  await page.getByRole("button", { name: "Skip this version: 2.0", exact: true }).click();
  expect(organization.commit).toHaveBeenLastCalledWith({
    kind: "set_update_notice",
    port_id: "sample",
    choice: { paused: false, skipped_release: { version: "2.0", artifact_sha256: "a".repeat(64) } },
  });
  await page.getByRole("button", { name: "Pause update notices", exact: true }).click();
  expect(organization.commit).toHaveBeenLastCalledWith({
    kind: "set_update_notice",
    port_id: "sample",
    choice: { paused: true, skipped_release: null },
  });
});

it("does not offer skipping an unverified artifact or saving unreadable choices", async () => {
  const organization = { ...choices(), snapshot: undefined, failure: "read" as const };
  await render(
    <UpdateNoticePreferences portId="sample" status={portStatus()} organization={organization} />,
  );
  await expect
    .element(page.getByRole("button", { name: /Skip this version/ }))
    .not.toBeInTheDocument();
  await expect
    .element(page.getByRole("button", { name: "Pause update notices", exact: true }))
    .toBeDisabled();
  await page.getByRole("button", { name: "Refresh choices", exact: true }).click();
  expect(organization.refresh).toHaveBeenCalledExactlyOnceWith();
  expect(organization.commit).not.toHaveBeenCalled();
});

import { afterEach, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react";
import { DetailPanel } from "../../components/DetailPanel";
import { actions as detailActions, installRecord } from "../../components/rendered-test-fixtures";
import { failureReport, portDefinition, portStatus } from "../../test-fixtures";
import type { ExactReleaseReview, PortStatus } from "../../types";
import type { ExactReleaseActions } from "./ExactReleasePreference";
import "../../styles/index.css";

afterEach(cleanup);

const port = { ...portDefinition(), id: "exact-release-fixture" };
const reviewed: ExactReleaseReview = {
  selection: {
    port_id: port.id,
    channel: "stable",
    platform: "windows-x86-64",
    version: "v1.2.0",
    filename: "game-windows-x64.zip",
    size: 200,
    sha256: "a".repeat(64),
    identity: {
      provider: "github",
      repository_id: 3,
      release_id: 5,
      asset_id: 8,
      commit_sha1: "a".repeat(40),
    },
  },
  review_sha256: "b".repeat(64),
};

function installedStatus(): PortStatus {
  return { ...portStatus(), port_id: port.id, active: installRecord({ port_id: port.id }) };
}

function capabilities(overrides: Partial<ExactReleaseActions> = {}): ExactReleaseActions {
  return {
    available: vi.fn().mockResolvedValue(true),
    review: vi.fn().mockResolvedValue(reviewed),
    pin: vi.fn().mockResolvedValue({ ...installedStatus(), exact_release: reviewed.selection }),
    follow: vi.fn().mockResolvedValue(installedStatus()),
    ...overrides,
  };
}

async function openVersions(status: PortStatus, exactRelease: ExactReleaseActions) {
  const view = await render(
    <DetailPanel
      port={port}
      status={status}
      sourcePath=""
      setSourcePath={vi.fn()}
      actions={{ ...detailActions, exactRelease }}
      libraryGeneration={18}
    />,
  );
  await page.getByRole("tab", { name: "Versions & updates", exact: true }).click();
  return view;
}

const chooser = () => page.getByRole("button", { name: "Choose exact release", exact: true });
const field = () => page.getByRole("textbox", { name: "Release tag or version", exact: true });
const pinButton = () => page.getByRole("button", { name: "Pin this release", exact: true });

it("reviews and saves a pin, then displays it from the reopened library state", async () => {
  const actions = capabilities();
  const view = await openVersions(installedStatus(), actions);
  await chooser().click();
  await field().fill(reviewed.selection.version);
  await page.getByRole("button", { name: "Review release", exact: true }).click();
  await expect.element(page.getByText(/game-windows-x64\.zip/)).toBeVisible();
  await pinButton().click();
  expect(actions.pin).toHaveBeenCalledExactlyOnceWith(reviewed);
  expect(actions.follow).not.toHaveBeenCalled();
  await view.unmount();

  await openVersions({ ...installedStatus(), exact_release: reviewed.selection }, actions);
  await expect.element(page.getByText("Pinned to v1.2.0.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Follow channel", exact: true }).click();
  expect(actions.follow).toHaveBeenCalledTimes(1);
});

it("ignores a cancelled reply and requires a fresh review after a stale confirmation", async () => {
  let completeReview: (value: ExactReleaseReview) => void = () => {};
  const delay = new Promise<ExactReleaseReview>((resolve) => {
    completeReview = resolve;
  });
  const review = vi.fn().mockReturnValueOnce(delay).mockResolvedValue(reviewed);
  const pin = vi.fn().mockResolvedValue(undefined);
  const actions = capabilities({ review, pin });
  await openVersions(installedStatus(), actions);

  await chooser().click();
  await field().fill(reviewed.selection.version);
  await page.getByRole("button", { name: "Review release", exact: true }).click();
  await page.getByRole("button", { name: "Cancel release review", exact: true }).click();
  await expect.element(chooser()).toHaveFocus();
  completeReview(reviewed);
  await delay;
  expect(actions.pin).not.toHaveBeenCalled();
  await chooser().click();
  await expect.element(pinButton()).not.toBeInTheDocument();
  await page.getByRole("button", { name: "Review release", exact: true }).click();
  await pinButton().click();
  await expect
    .element(page.getByText("Portcove couldn’t confirm the pin. Review the release again."))
    .toBeVisible();
  await expect.element(pinButton()).not.toBeInTheDocument();
  expect(actions.follow).not.toHaveBeenCalled();
});

it("hides an ineligible chooser while allowing an existing pin to be cleared", async () => {
  const available = vi.fn().mockResolvedValue(false);
  const actions = capabilities({ available });
  await openVersions({ ...installedStatus(), exact_release: reviewed.selection }, actions);
  await expect.element(page.getByText("Pinned to v1.2.0.", { exact: true })).toBeVisible();
  await expect.element(chooser()).not.toBeInTheDocument();
  await page.getByRole("button", { name: "Follow channel", exact: true }).click();
  expect(actions.follow).toHaveBeenCalledTimes(1);
  expect(actions.review).not.toHaveBeenCalled();
});

function exactReleaseFailure(key: string, summary: string, technical: string) {
  const error = failureReport();
  error.code = "unsupported";
  error.message = technical;
  error.presentation = {
    ...error.presentation,
    presentation_key: key,
    summary,
    technical_message: technical,
  };
  return error;
}

it("shows Core's reason when a held release is refused at review", async () => {
  const summary =
    "Portcove can't pin this release because it is held. This package is known to corrupt saves. Choose a different release or keep following the channel.";
  const review = vi
    .fn()
    .mockRejectedValue(exactReleaseFailure("exact_release_held", summary, "held artifact"));
  await openVersions(installedStatus(), capabilities({ review }));
  await chooser().click();
  await field().fill(reviewed.selection.version);
  await page.getByRole("button", { name: "Review release", exact: true }).click();
  await expect.element(page.getByText(summary, { exact: true })).toBeVisible();
  await expect
    .element(page.getByText("Portcove couldn’t review this release. Check the tag and try again."))
    .not.toBeInTheDocument();
  await expect.element(pinButton()).not.toBeInTheDocument();
});

it("keeps the task's fallback for a failure Core does not explain and attaches its details", async () => {
  const review = vi.fn().mockRejectedValue(failureReport());
  await openVersions(installedStatus(), capabilities({ review }));
  await chooser().click();
  await field().fill("v9.9.9");
  await page.getByRole("button", { name: "Review release", exact: true }).click();
  await expect
    .element(page.getByText("Portcove couldn’t review this release. Check the tag and try again."))
    .toBeVisible();
  await expect
    .element(page.getByText("The required game files could not be accepted or prepared."))
    .not.toBeInTheDocument();
});

it("shows Core's reason when a pin confirmation is refused", async () => {
  const summary =
    "The release or this game's saved settings changed after the review. Review the release again before pinning it.";
  const pin = vi
    .fn()
    .mockRejectedValue(exactReleaseFailure("exact_release_review_changed", summary, "stale"));
  await openVersions(installedStatus(), capabilities({ pin }));
  await chooser().click();
  await field().fill(reviewed.selection.version);
  await page.getByRole("button", { name: "Review release", exact: true }).click();
  await expect
    .element(
      page.getByText(
        "Future installs and update checks use this release, even when the channel offers a newer one.",
      ),
    )
    .toBeVisible();
  await pinButton().click();
  await expect.element(page.getByText(summary, { exact: true })).toBeVisible();
});

it("explains a held pin and offers Follow channel to clear it", async () => {
  const available = vi.fn().mockResolvedValue(false);
  const actions = capabilities({ available });
  await openVersions(
    {
      ...installedStatus(),
      exact_release_hold: { reason: "unreadable", detail: "expected value at line 1" },
    },
    actions,
  );
  await expect
    .element(
      page.getByText(
        "Portcove can’t read the saved release pin, so it won’t check for or install updates for this game. Choose Follow channel to clear it.",
      ),
    )
    .toBeVisible();
  await expect.element(page.getByText("expected value at line 1")).not.toBeInTheDocument();
  await expect.element(chooser()).not.toBeInTheDocument();
  await page.getByRole("button", { name: "Follow channel", exact: true }).click();
  expect(actions.follow).toHaveBeenCalledTimes(1);
});

import "../styles/index.css";
import { requireCompleteCaptureTarget } from "../../test/capture-target";
import { fixtureValue } from "../test-fixtures";
import { captureParityState } from "../../test/parity-capture";
import { controlledAct as act } from "../../test/controlled-react-act";
import { render as renderComponent, cleanup, type RenderResult } from "vitest-browser-react";

import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { desktopApi } from "../api";
import { canOpenExternalRegistration } from "../features/operations/invocation-state";
import { OperationPresentationProvider } from "../features/operations/operation-presentation";
import { useOperationState } from "../features/operations/use-operation-state";
import { StatusLayer } from "./Chrome";
import { currentCatalogPort } from "../catalog-test-fixtures";
import { pickInstallFolder, pickHostToolExecutable } from "../file-picker";
import { failureReport, portDefinition, portStatus } from "../test-fixtures";
import type {
  ExternalRuntimeRecord,
  PendingSetupRecord,
  PortDefinition,
  PortListing,
  PortListingStatus,
} from "../types";
// Source-bound proposed metadata exercises retained presentation independently
// of live catalog adoption. See #2926 for the remaining production rollout.
import proposals from "../../../../crates/portcove-core/tests/fixtures/installation-rollout-proposals-20261025.json";
import listingsDirectory from "../../../../crates/portcove-core/catalog/listings.json";
import {
  AuthoredPreparationGuidance,
  ExternalRuntimeControl,
  UserSelectedRuntimeControl,
} from "./ExternalRuntime";

// The real directory is a 1,441-entry JSON literal. Inferring its shape yields a union
// that becomes unusably large as optional listing fields vary (the first-listed date is
// present on some listings and absent on others), so name only what this test reads.
type ListingGuide = NonNullable<NonNullable<PortDefinition["presentation"]>["manual_setup"]>;
const listings = listingsDirectory as unknown as {
  listings: { id: string; manual_setup?: ListingGuide }[];
};
import { catalogEntries } from "../features/browsing/catalog-entry";
import { SetupLaunchDraftsProvider } from "../features/browsing/setup-launch-drafts";
import { ActionReviewFailure } from "./ActionReviewFailure";
import { DetailLayout } from "./DetailLayout";
import { SelfServiceSetup } from "./SelfServiceSetup";

vi.mock("../file-picker", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../file-picker")>()),
  pickInstallFolder: vi.fn(),
  pickHostToolExecutable: vi.fn(),
  pickArtworkPath: vi.fn(),
}));

const port = {
  ...portDefinition(),
  release: { ...portDefinition().release, provider: "user-prepared" as const },
  presentation: {
    installation_method: "user-prepared-runtime" as const,
    source_requirements: [],
    saves_and_settings: "external-user-owned" as const,
    manual_preparation: "Create an empty portable.txt beside the executable.",
  },
};
const record: ExternalRuntimeRecord = {
  id: "external-1",
  port_id: port.id,
  path: "C:\\Player\\WaveRace",
  executable: "C:\\Player\\WaveRace\\game.exe",
  version: "1.0.2",
  platform: "windows-x86-64",
  archive_sha256: "a".repeat(64),
  immutable_tree_sha256: "b".repeat(64),
  registered_at: 1,
};
let root: RenderResult;
let host: HTMLDivElement;
let originalDocumentDirection: string | null;

beforeEach(async () => {
  originalDocumentDirection = document.documentElement.getAttribute("dir");
  host = document.createElement("div");
  document.body.append(host);
  root = await renderComponent(null, { container: document.body.appendChild(host) });
});
afterEach(async () => {
  await cleanup();
  host.remove();
  if (originalDocumentDirection === null) document.documentElement.removeAttribute("dir");
  else document.documentElement.setAttribute("dir", originalDocumentDirection);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function click(label: string) {
  const buttons = [...document.body.querySelectorAll("button")];
  const matching = (item: HTMLButtonElement) => item.textContent?.trim() === label;
  const button =
    buttons.find((item) => item.closest('[data-slot="dialog-content"]') && matching(item)) ??
    buttons.find(matching);
  expect(button).toBeDefined();
  await act(async () => button?.click());
}

it("shows recorded setup alongside one shared external-maintenance refusal", async () => {
  const status = {
    ...portStatus(),
    external_runtime: {
      ...record,
      user_selected: { arguments: [] },
      setup_download: {
        release_id: 200,
        asset_id: 201,
        release_tag: "v1.0.2",
        filename: "wave-race-windows-x64.zip",
        download_sha256: "c".repeat(64),
      },
    },
  };
  const reason =
    "Current action availability is unavailable. Refresh the workspace to check again.";
  await root.rerender(
    <UserSelectedRuntimeControl
      port={port}
      status={status}
      generation={7}
      busy={false}
      listingStatus={{
        port_id: port.id,
        status,
        actions: [
          { action: "relink-existing", allowed: false, reason },
          { action: "remove-registration", allowed: false, reason },
        ],
      }}
    />,
  );
  await expect
    .element(page.getByRole("button", { name: "Edit launch details…", exact: true }))
    .toBeDisabled();
  await expect
    .element(page.getByRole("button", { name: "Remove registration", exact: true }))
    .toBeDisabled();
  expect(page.getByText(reason, { exact: true }).elements()).toHaveLength(1);
  await expect
    .element(page.getByText("Last recorded setup download", { exact: true }))
    .toBeVisible();
  await expect.element(page.getByText("wave-race-windows-x64.zip", { exact: true })).toBeVisible();
  await expect.element(page.getByText("Release v1.0.2", { exact: true })).toBeVisible();
});

it("retains external launch drafts across detail tabs and reviews the same target and generation", async () => {
  const executable = "C:/Player/External/game.exe";
  vi.mocked(pickHostToolExecutable).mockResolvedValue(executable);
  const preview = vi
    .spyOn(desktopApi, "previewUserSelectedRuntime")
    .mockRejectedValue(new Error("Fixture review reached"));
  const apply = vi.spyOn(desktopApi, "registerUserSelectedRuntime");
  const status = portStatus();
  await root.rerender(
    <DetailLayout
      port={port}
      initialSection="files"
      readiness="Setup required"
      installation="Not installed"
      action={() => null}
      close={vi.fn()}
    >
      {() => ({
        overview: null,
        files: (
          <UserSelectedRuntimeControl
            port={port}
            status={status}
            listingStatus={{
              port_id: port.id,
              status,
              actions: [{ action: "attach-existing", allowed: true }],
            }}
            generation={7}
            busy={false}
          />
        ),
        saves: null,
        versions: null,
      })}
    </DetailLayout>,
  );
  await click("Choose game executable…");
  await page
    .getByRole("textbox", { name: "Start in folder", exact: true })
    .fill("C:/Player/Retained directory");
  await page.getByRole("tab", { name: "Versions & updates", exact: true }).click();
  await page.getByRole("tab", { name: "Game files", exact: true }).click();
  await expect
    .element(page.getByRole("textbox", { name: "Start in folder", exact: true }))
    .toHaveValue("C:/Player/Retained directory");
  await click("Review launch details");
  expect(preview).toHaveBeenCalledExactlyOnceWith(
    port.id,
    executable,
    "C:/Player/Retained directory",
    [],
    7,
  );
  expect(document.body.textContent).toContain("Fixture review reached");
  expect(apply).not.toHaveBeenCalled();
});

it("retains external launch inputs after a failed review and reopening the detail", async () => {
  const executable = "C:/Player/External/game.exe";
  const directory = "C:/Player/Retained directory";
  const argumentLines = "--fullscreen\n\nC:/My Games/Level one";
  const preview = vi
    .spyOn(desktopApi, "previewUserSelectedRuntime")
    .mockRejectedValue(new Error("Folder changed before review"));
  const register = vi.spyOn(desktopApi, "registerUserSelectedRuntime");
  vi.mocked(pickHostToolExecutable).mockResolvedValue(executable);
  const status = portStatus();
  const pending: PendingSetupRecord = {
    id: "downloaded-draft-transition",
    reason: null,
    port_id: port.id,
    listing: { ...(proposals.listings[0] as PortListing), id: port.id },
    path: "C:/Player/Downloaded game",
    state: "downloaded",
    downloaded_at: "2026-11-20T00:00:00Z",
    archive_sha256: "a".repeat(64),
    artifact: {
      release_id: 1,
      asset_id: 2,
      release_tag: "v1",
      name: "game.zip",
      size: 1024,
      release_url: "https://example.com/v1",
      download_url: "https://example.com/game.zip",
      can_extract: true,
      sha256: null,
    },
  };
  const discover = vi.spyOn(desktopApi, "discoverSetupLaunchTargets").mockResolvedValue({
    port_id: port.id,
    pending_id: pending.id,
    candidates: [],
    complete: true,
    entries_checked: 0,
    explanation: "No suggested program",
    recommended_executable: null,
  });
  const view = (
    generation: number,
    details = true,
    initialDirectory?: string,
    pendingSetup?: PendingSetupRecord,
  ) => (
    <SetupLaunchDraftsProvider key={generation}>
      {details ? (
        <UserSelectedRuntimeControl
          port={pendingSetup ? { ...port, pendingSetup } : port}
          status={status}
          listingStatus={{
            port_id: port.id,
            status,
            actions: [{ action: "attach-existing", allowed: true }],
          }}
          generation={generation}
          libraryRoot="C:/Portcove"
          initialDirectory={initialDirectory}
          busy={false}
        />
      ) : (
        <h1>Library</h1>
      )}
    </SetupLaunchDraftsProvider>
  );
  const startFolder = page.getByRole("textbox", { name: "Start in folder", exact: true });
  const launchOptions = page.getByRole("textbox", { name: /^Launch options/ });
  const openArguments = () => page.getByText("Advanced launch options", { exact: true }).click();
  const expectedArguments = ["--fullscreen", "", "C:/My Games/Level one"];

  await root.rerender(view(7));
  await click("Choose game executable…");
  await startFolder.fill(directory);
  await openArguments();
  await launchOptions.fill(argumentLines);
  await click("Review launch details");
  await expect
    .element(page.getByText("Folder changed before review", { exact: true }))
    .toBeVisible();
  await click("Cancel");

  await root.rerender(view(7, false));
  await expect.element(page.getByRole("heading", { name: "Library", exact: true })).toBeVisible();
  await root.rerender(view(7));
  await expect.element(startFolder).toHaveValue(directory);
  await openArguments();
  await expect.element(launchOptions).toHaveValue(argumentLines);
  expect(preview).toHaveBeenCalledOnce();
  await click("Review launch details");
  expect(preview.mock.calls).toEqual([
    [port.id, executable, directory, expectedArguments, 7],
    [port.id, executable, directory, expectedArguments, 7],
  ]);
  expect(register).not.toHaveBeenCalled();
  await click("Cancel");

  await root.rerender(view(7, true, "C:/A different target"));
  await expect.element(startFolder).toHaveValue("C:/A different target");
  await root.rerender(view(7));
  await expect.element(startFolder).toHaveValue("");

  await click("Choose game executable…");
  await startFolder.fill(directory);
  await root.rerender(view(7, true, pending.path, pending));
  await expect.poll(() => discover.mock.calls).toEqual([[port.id, pending.id, 7]]);
  await root.rerender(view(7));
  await expect.element(startFolder).toHaveValue("");

  await click("Choose game executable…");
  await startFolder.fill(directory);
  await root.rerender(view(8));
  await expect.element(startFolder).toHaveValue("");
  expect(preview).toHaveBeenCalledTimes(2);
});

it("keeps the registered result after leaving and offers Open only for confirmed readback", async () => {
  const registered = {
    ...record,
    archive_sha256: "",
    immutable_tree_sha256: "",
    user_selected: { arguments: [] },
  };
  vi.mocked(pickHostToolExecutable).mockResolvedValue(record.executable);
  vi.spyOn(desktopApi, "previewUserSelectedRuntime").mockResolvedValue({
    port_id: registered.port_id,
    version: registered.version,
    path: registered.path,
    executable: registered.executable,
    archive_sha256: registered.archive_sha256,
    immutable_tree_sha256: registered.immutable_tree_sha256,
    immutable_file_count: 0,
    user_selected: registered.user_selected,
    preview_sha256: "register-review",
  });
  const register = vi
    .spyOn(desktopApi, "registerUserSelectedRuntime")
    .mockResolvedValue(registered);
  const launch = vi.spyOn(desktopApi, "launch");
  const open = vi.fn<(portId: string) => void>();
  const staleLaunch = vi.fn(async () => true);
  const refresh = vi.fn().mockRejectedValue(new Error("Could not refresh the library"));
  const status = portStatus();
  function Workspace({
    revision,
    showEditor,
    current,
  }: {
    revision: number;
    showEditor: boolean;
    current?: ExternalRuntimeRecord;
  }) {
    const operations = useOperationState({
      refresh,
      workspaceReadRevision: revision,
      startedWorkspaceReadRevision: () => 1,
      libraryGeneration: 7,
    });
    return (
      <OperationPresentationProvider
        generation={7}
        pending={operations.pendingOperations}
        unreadExternalPorts={operations.unreadExternalPorts}
        perform={operations.perform}
      >
        <StatusLayer
          invocations={operations.invocations}
          clearError={() => undefined}
          dismissInvocation={operations.dismissInvocation}
          openExternalGame={(result) =>
            canOpenExternalRegistration(
              result,
              { ...status, external_runtime: current ?? null },
              7,
              showEditor ? port.id : undefined,
              operations.unreadExternalPorts,
            )
              ? () => open(result.context.target.id)
              : undefined
          }
        />
        <button
          onClick={() =>
            void operations.perform("launch", staleLaunch, {
              context: {
                action: "Launch",
                operation: "launch",
                target: { kind: "port", id: port.id, label: port.name },
                libraryGeneration: 7,
                exclusionScope: "target",
              },
            })
          }
        >
          Launch from prior view
        </button>
        {showEditor ? (
          <UserSelectedRuntimeControl
            port={port}
            status={status}
            listingStatus={{
              port_id: port.id,
              status,
              actions: [{ action: "attach-existing", allowed: true }],
            }}
            generation={7}
            busy={Boolean(operations.busy)}
            onChanged={refresh}
          />
        ) : (
          <h1>Library</h1>
        )}
      </OperationPresentationProvider>
    );
  }

  await root.rerender(<Workspace revision={1} showEditor />);
  await click("Choose game executable…");
  await click("Review launch details");
  await click("Use this installation");
  expect(refresh).toHaveBeenCalledOnce();
  await expect
    .element(page.getByText("Could not refresh the library", { exact: false }))
    .toBeVisible();
  await expect
    .element(
      page.getByText(
        "Launch details saved. Waiting for the library to confirm the current registration.",
      ),
    )
    .toBeVisible();
  const result = page.getByText("Saved external launch details for", { exact: false });
  await expect.element(result).toBeVisible();

  const openGame = page.getByRole("button", { name: "Open game", exact: true });
  await root.rerender(<Workspace revision={1} showEditor={false} current={registered} />);
  await expect.element(result).toBeVisible();
  await expect.element(openGame).not.toBeInTheDocument();
  await click("Launch from prior view");
  expect(staleLaunch).not.toHaveBeenCalled();

  const replacement = { ...registered, user_selected: { arguments: ["--replacement"] } };
  await root.rerender(<Workspace revision={2} showEditor={false} current={replacement} />);
  await expect.element(openGame).not.toBeInTheDocument();

  const newDownload = {
    ...registered,
    setup_download: {
      release_id: 200,
      asset_id: 201,
      release_tag: "v2",
      filename: "replacement.zip",
      download_sha256: "c".repeat(64),
    },
  };
  await root.rerender(<Workspace revision={3} showEditor={false} current={newDownload} />);
  await expect.element(openGame).not.toBeInTheDocument();

  await root.rerender(<Workspace revision={4} showEditor={false} current={registered} />);
  await openGame.click();
  expect(open).toHaveBeenCalledExactlyOnceWith(port.id);
  expect(register).toHaveBeenCalledExactlyOnceWith(
    port.id,
    registered.executable,
    registered.path,
    [],
    "register-review",
    7,
  );
  expect(launch).not.toHaveBeenCalled();
});

it("registers a listing-only identity only when Core offers the action", async () => {
  const entry = catalogEntries(
    undefined,
    {
      format_version: 1,
      listings: [
        {
          id: "listing-only",
          name: "Listing Only",
          summary: "An upstream project.",
          project_url: "https://example.com/project",
          platforms: [],
          availability: "unknown",
        },
      ],
    },
    [],
    [],
  )[0]!;
  const status = { ...portStatus(), port_id: entry.id };
  await root.rerender(
    <UserSelectedRuntimeControl port={entry} status={status} generation={7} busy={false} />,
  );
  await expect
    .element(page.getByRole("button", { name: "Choose game executable…" }))
    .toBeDisabled();
  expect(pickHostToolExecutable).not.toHaveBeenCalled();
  const listingStatus: PortListingStatus = {
    port_id: entry.id,
    status,
    actions: [{ action: "attach-existing", allowed: true }],
  };
  await root.rerender(
    <UserSelectedRuntimeControl
      port={entry}
      status={status}
      listingStatus={listingStatus}
      generation={7}
      busy={false}
      initialDirectory={"C:\\Player\\Downloaded game"}
    />,
  );
  await expect.element(page.getByRole("button", { name: "Choose game executable…" })).toBeEnabled();
  await expect
    .element(page.getByRole("textbox", { name: "Start in folder" }))
    .toHaveValue("C:\\Player\\Downloaded game");
  expect(entry.release).toBeUndefined();
  await root.rerender(
    <UserSelectedRuntimeControl
      port={entry}
      status={status}
      listingStatus={{
        ...listingStatus,
        actions: [...listingStatus.actions, ...listingStatus.actions],
      }}
      generation={7}
      busy={false}
    />,
  );
  await expect
    .element(page.getByRole("button", { name: "Choose game executable…" }))
    .toBeDisabled();
});

it.each([
  {
    label: "ordinary arguments",
    arguments: ["--fullscreen"],
    editorSelector: "textarea",
    editorValue: "--fullscreen",
    editorCapture: "external-existing-launch-arguments-ordinary",
  },
  {
    label: "empty and multiline arguments",
    arguments: ["--profile", "", "first\nsecond"],
    editorSelector: "pre",
    editorValue: JSON.stringify(["--profile", "", "first\nsecond"], null, 2),
    editorCapture: "external-existing-launch-arguments-structured",
  },
])(
  "edits selected paths while preserving $label through relink",
  async ({ arguments: savedArguments, editorSelector, editorValue, editorCapture }) => {
    const savedDirectory = String.raw`\\?\C:\Player\External runtime installations\نسخة محفوظة\Original game folder`;
    const selected = {
      ...record,
      path: savedDirectory,
      executable: `${savedDirectory}\\game.exe`,
      user_selected: { arguments: savedArguments },
    };
    const status = { ...portStatus(), external_runtime: selected };
    const listingStatus: PortListingStatus = {
      port_id: port.id,
      status,
      actions: [
        { action: "relink-existing", allowed: true },
        { action: "remove-registration", allowed: true },
      ],
    };
    const executable = "C:\\Player\\New folder\\game.exe";
    vi.mocked(pickHostToolExecutable).mockResolvedValue(executable);
    const preview = vi.spyOn(desktopApi, "previewUserSelectedRuntimeRelink").mockResolvedValue({
      port_id: port.id,
      registration_id: record.id,
      external_files_will_be_preserved: true,
      previous_path: selected.path,
      preview_sha256: "edit-review",
      proposed: {
        port_id: port.id,
        executable,
        path: "C:\\Player\\New folder",
        version: "user-managed",
        archive_sha256: "",
        immutable_tree_sha256: "",
        immutable_file_count: 0,
        preview_sha256: "proposed",
        user_selected: selected.user_selected,
        shared_preferences: null,
      },
    });
    const apply = vi
      .spyOn(desktopApi, "relinkUserSelectedRuntime")
      .mockResolvedValue({ ...selected, executable });
    const remove = vi.spyOn(desktopApi, "removeExternalRuntime");
    const register = vi.spyOn(desktopApi, "registerUserSelectedRuntime");
    const changed = vi.fn();
    await root.rerender(
      <UserSelectedRuntimeControl
        port={port}
        status={status}
        listingStatus={listingStatus}
        generation={7}
        busy={false}
        onChanged={changed}
      />,
    );
    document.documentElement.dir = "rtl";
    host.dir = "rtl";
    for (const path of [selected.executable, selected.path]) {
      const target = externalPathWithin(host, path, "retained launch path");
      expectCompleteExternalPath(target, "retained launch path", path);
    }
    await captureParityState(
      savedArguments.length === 1
        ? "external-existing-launch-paths-ordinary"
        : "external-existing-launch-paths-structured",
    );
    await click("Edit launch details…");
    await click("Choose game executable…");
    const keepsExactArguments = savedArguments.some(
      (argument) => argument === "" || /[\r\n]/.test(argument),
    );
    await page.getByText("Advanced launch options", { exact: true }).click();
    expect(document.body.textContent?.includes("They will be kept exactly")).toBe(
      keepsExactArguments,
    );
    expect(document.querySelector("textarea") === null).toBe(keepsExactArguments);
    const argumentEditors = host.querySelectorAll<HTMLElement>(editorSelector);
    expect(argumentEditors).toHaveLength(1);
    const argumentEditor = fixtureValue(argumentEditors[0], "exact saved argument editor");
    expectLtrArgumentValue(argumentEditor, editorValue);
    argumentEditor.scrollIntoView({ block: "center" });
    await expect.element(argumentEditor).toBeVisible();
    const editorBounds = argumentEditor.getBoundingClientRect();
    requireCompleteCaptureTarget(
      {
        target: editorCapture,
        target_count: argumentEditors.length,
        visible: argumentEditor.checkVisibility(),
        rect: {
          x: editorBounds.x,
          y: editorBounds.y,
          width: editorBounds.width,
          height: editorBounds.height,
        },
        viewport: { width: innerWidth, height: innerHeight },
      },
      editorCapture,
    );
    await captureParityState(editorCapture);
    await click("Review launch details");
    const argumentReview = page.getByRole("dialog").element();
    expect(getComputedStyle(argumentReview).direction).toBe("rtl");
    expectReviewedArguments(argumentReview, savedArguments);
    expect(preview).toHaveBeenCalledExactlyOnceWith(
      port.id,
      executable,
      "C:\\Player\\New folder",
      savedArguments,
      7,
    );
    expect(apply).not.toHaveBeenCalled();
    expect(document.body.textContent?.includes("Empty argument")).toBe(savedArguments.includes(""));
    await click("Save launch details");
    expect(apply).toHaveBeenCalledExactlyOnceWith(
      port.id,
      executable,
      "C:\\Player\\New folder",
      savedArguments,
      "edit-review",
      7,
    );
    expect(remove).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
    expect(changed).toHaveBeenCalledOnce();
  },
);

it("reviews explicit user launch details without accepted-package or file-management claims", async () => {
  const selectedPort = {
    ...port,
    release: {
      ...port.release,
      user_prepared: {
        "windows-x86-64": {
          trust: "user-selected" as const,
          version: "user-managed",
          archive_name: "",
          archive_size: 0,
          archive_sha256: "",
          immutable_tree_sha256: "",
          executable: "",
          mutable_paths: [],
          source_argument_extension: null,
          library_user_data: false,
        },
      },
    },
  };
  const directory = String.raw`\\?\C:\Player\External runtime installations\משחק מקורי\Own prepared game`;
  const executable = `${directory}\\launcher.exe`;
  vi.mocked(pickHostToolExecutable).mockResolvedValue(executable);
  const preview = vi.spyOn(desktopApi, "previewUserSelectedRuntime").mockResolvedValue({
    port_id: record.port_id,
    executable,
    path: directory,
    version: "user-managed",
    archive_sha256: "",
    immutable_tree_sha256: "",
    immutable_file_count: 0,
    user_selected: { arguments: ["--data", "C:\\Original files"] },
    preview_sha256: "selected-review",
    shared_preferences: null,
  });
  const apply = vi.spyOn(desktopApi, "registerUserSelectedRuntime").mockResolvedValue({
    ...record,
    executable,
    path: directory,
    user_selected: { arguments: ["--data", "C:\\Original files"] },
  });
  const oldPreview = vi.spyOn(desktopApi, "previewExternalRuntime");
  const changed = vi.fn();
  await root.rerender(
    <ExternalRuntimeControl
      port={selectedPort}
      status={portStatus()}
      generation={7}
      busy={false}
      onChanged={changed}
    />,
  );
  await expect
    .element(page.getByText("Create an empty portable.txt beside the executable.", { exact: true }))
    .toBeVisible();
  expect(document.body.textContent).not.toContain("Archive SHA-256");
  await click("Choose game executable…");
  await page.getByText("Advanced launch options", { exact: true }).click();
  await page
    .getByRole("textbox", {
      name: "Launch options (advanced) (one per line, optional)",
      exact: true,
    })
    .fill("--data\nC:\\Original files");
  document.documentElement.dir = "rtl";
  host.dir = "rtl";
  const argumentEditor = page.getByRole("textbox", {
    name: "Launch options (advanced) (one per line, optional)",
    exact: true,
  });
  expectLtrArgumentValue(argumentEditor.element(), "--data\nC:\\Original files");
  const selectedProgram = externalPathWithin(host, executable, "selected Game program");
  selectedProgram.scrollIntoView({ block: "center" });
  expectCompleteExternalPath(selectedProgram, "selected Game program", executable);
  await expect
    .element(page.getByRole("textbox", { name: "Start in folder", exact: true }))
    .toHaveAttribute("dir", "ltr");
  await captureParityState("external-selected-runtime-exact-program");
  await click("Review launch details");
  expect(preview).toHaveBeenCalledExactlyOnceWith(
    port.id,
    executable,
    directory,
    ["--data", "C:\\Original files"],
    7,
  );
  expect(document.body.textContent).toContain(
    "Portcove has not authenticated it as an official package",
  );
  expect(document.body.textContent).toContain(
    "You’ll handle setup and updates yourself, or through the game’s own launcher.",
  );
  expect(document.body.textContent).not.toContain("Checked files");
  const review = page.getByRole("dialog").element();
  expect(getComputedStyle(review).direction).toBe("rtl");
  expectReviewedArguments(review, ["--data", "C:\\Original files"]);
  for (const path of [executable, directory]) {
    const target = externalPathWithin(review, path, "reviewed launch path");
    target.scrollIntoView({ block: "center" });
    expectCompleteExternalPath(target, "reviewed launch path", path);
  }
  expect(
    [...review.querySelectorAll("code")].every((code) => !code.classList.contains("path-value")),
  ).toBe(true);
  await captureParityState("external-selected-runtime-exact-review");
  expect(apply).not.toHaveBeenCalled();
  expect(oldPreview).not.toHaveBeenCalled();
  await click("Use this installation");
  expect(apply).toHaveBeenCalledExactlyOnceWith(
    port.id,
    executable,
    directory,
    ["--data", "C:\\Original files"],
    "selected-review",
    7,
  );
  expect(changed).toHaveBeenCalledOnce();
});

it("reviews the resolved Mac bundle program and preserves an explicitly selected start folder", async () => {
  const directory = "/Games";
  const bundle = `${directory}/OpenLoco.app`;
  const programDirectory = `${bundle}/Contents/MacOS`;
  const executable = `${programDirectory}/OpenLoco`;
  const entry = {
    ...port,
    definition: {
      ...port,
      executable_hints: { "macos-aarch64": ["OpenLoco.app/Contents/MacOS/OpenLoco"] },
    },
  };
  vi.mocked(pickHostToolExecutable).mockResolvedValue(bundle);
  const preview = vi.spyOn(desktopApi, "previewUserSelectedRuntime").mockResolvedValue({
    port_id: entry.id,
    executable,
    path: directory,
    version: "user-managed",
    archive_sha256: "",
    immutable_tree_sha256: "",
    immutable_file_count: 0,
    user_selected: { arguments: [] },
    preview_sha256: "bundle-review",
    shared_preferences: null,
  });
  await root.rerender(
    <UserSelectedRuntimeControl
      port={entry}
      devicePlatform="macos-aarch64"
      status={portStatus()}
      generation={7}
      busy={false}
    />,
  );
  await click("Choose game executable…");
  const startFolder = page.getByRole("textbox", { name: "Start in folder", exact: true });
  await expect.element(startFolder).toHaveValue(programDirectory);
  await startFolder.fill(directory);
  await click("Review launch details");
  await expect.element(page.getByText(executable, { exact: true })).toBeVisible();
  expect(preview).toHaveBeenCalledExactlyOnceWith(entry.id, bundle, directory, [], 7);
});

it.each(["current", "older"] as const)(
  "shows the Second Hunt startup warning before setup with the %s directory",
  async (directory) => {
    const entry = listings.listings.find(
      (candidate) => candidate.id === "bountyhunterkanden-secondhunt",
    )!;
    const guide = entry.manual_setup!;
    await root.rerender(
      <AuthoredPreparationGuidance
        port={{ ...port, id: entry.id }}
        setup={{
          manual_setup: {
            ...guide,
            help_url: guide.help_url ?? null,
            warnings: directory === "current" ? guide.warnings : [],
          },
        }}
      />,
    );
    const warning = page.getByText(/Before opening Second Hunt v0\.4\.2-beta/);
    const firstAction = page.getByRole("heading", { name: "Set up Second Hunt" });
    await expect.element(warning).toBeVisible();
    await expect.element(warning).toMatchTextContent(/ending in \.old or \.old followed by digits/);
    await expect.element(warning).toMatchTextContent(/including portable saves/);
    expect(
      warning.element().compareDocumentPosition(firstAction.element()) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  },
);

it("keeps the Second Hunt caution visible before Play for an attached copy", async () => {
  const listing = listings.listings.find(
    (candidate) => candidate.id === "bountyhunterkanden-secondhunt",
  )!;
  const status = {
    ...portStatus(),
    port_id: listing.id,
    external_runtime: { ...record, port_id: listing.id },
  };
  const perform = vi.fn(async () => undefined);
  await root.rerender(
    <SelfServiceSetup
      entry={{
        ...port,
        id: listing.id,
        listingStatus: {
          port_id: listing.id,
          status,
          actions: [{ action: "launch", allowed: true }],
        },
      }}
      status={status}
      generation={7}
      perform={perform}
      onChanged={vi.fn()}
    />,
  );
  const warning = page.getByText(/Before opening Second Hunt v0\.4\.2-beta/);
  const play = page.getByRole("button", { name: "Play", exact: true });
  await expect.element(warning).toBeVisible();
  await expect.element(play).toBeEnabled();
  expect(
    warning.element().compareDocumentPosition(play.element()) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(perform).not.toHaveBeenCalled();
});

it.each(["ghostship", "starship"])(
  "shows %s’s actual prepared-installation guide beside executable selection",
  async (id) => {
    const selectedPort = currentCatalogPort(id);
    const status = { ...portStatus(), port_id: id };
    await root.rerender(
      <UserSelectedRuntimeControl
        port={selectedPort}
        status={status}
        listingStatus={{
          port_id: id,
          status,
          actions: [{ action: "attach-existing", allowed: true }],
        }}
        generation={7}
        busy={false}
      />,
    );
    for (const step of selectedPort.presentation!.manual_setup!.steps) {
      await expect.element(page.getByText(step.instruction, { exact: true })).toBeVisible();
    }
    for (const warning of selectedPort.presentation!.manual_setup!.warnings) {
      await expect.element(page.getByText(warning, { exact: true })).toBeVisible();
    }
    await expect
      .element(page.getByRole("button", { name: "Choose game executable…" }))
      .toBeEnabled();
    await expect
      .element(page.getByRole("link", { name: "Detailed preparation guide" }))
      .toHaveAttribute("href", selectedPort.presentation!.manual_setup!.help_url!);
    await expect.element(page.getByLabelText("Start in folder")).toBeVisible();
  },
);

it("shows authored setup warnings and instructions for a user-managed installation", async () => {
  const selectedPort = {
    ...port,
    release: {
      ...port.release,
      user_prepared: {
        "windows-x86-64": {
          trust: "user-selected" as const,
          version: "user-managed",
          archive_name: "",
          archive_size: 0,
          archive_sha256: "",
          immutable_tree_sha256: "",
          executable: "",
          mutable_paths: [],
          source_argument_extension: null,
          library_user_data: false,
        },
      },
    },
    presentation: {
      ...port.presentation,
      manual_setup: {
        warnings: ["Preserve the upstream setup's existing save folder."],
        steps: [
          {
            title: "Complete upstream setup",
            instruction: "Point the upstream launcher at your own original game files.",
          },
        ],
        help_url: "https://example.com/upstream-setup",
      },
    },
  };
  await root.rerender(
    <ExternalRuntimeControl
      port={selectedPort}
      status={portStatus()}
      generation={7}
      busy={false}
    />,
  );
  await expect
    .element(page.getByText("Preserve the upstream setup's existing save folder.", { exact: true }))
    .toBeVisible();
  await expect
    .element(
      page.getByText("Point the upstream launcher at your own original game files.", {
        exact: true,
      }),
    )
    .toBeVisible();
  await expect
    .element(page.getByRole("link", { name: "Detailed preparation guide" }))
    .toHaveAttribute("href", "https://example.com/upstream-setup");
  expect(document.body.textContent).toContain("Compatibility and technical notes");
  expect(document.body.textContent).not.toContain("Archive SHA-256");
  expect(document.body.textContent).not.toContain("Checked files");
});

it("preserves retained accepted-package controls after the current definition changes trust", async () => {
  const selectedPort = {
    ...port,
    release: {
      ...port.release,
      user_prepared: {
        "windows-x86-64": {
          trust: "user-selected" as const,
          version: "user-managed",
          archive_name: "",
          archive_size: 0,
          archive_sha256: "",
          immutable_tree_sha256: "",
          executable: "",
          mutable_paths: [],
          source_argument_extension: null,
        },
      },
    },
  };
  await root.rerender(
    <ExternalRuntimeControl
      port={selectedPort}
      status={{ ...portStatus(), external_runtime: record }}
      generation={7}
      busy={false}
    />,
  );
  await expect.element(page.getByRole("button", { name: "Change game folder…" })).toBeVisible();
  expect(document.body.textContent).toContain(`Portcove uses version ${record.version} in place`);
  expect(document.body.textContent).not.toContain("Portcove has not authenticated");
});

it("changes a retained external folder after its current catalog route becomes managed", async () => {
  const replacement = "C:\\Player\\Moved game";
  vi.mocked(pickInstallFolder).mockResolvedValue(replacement);
  const proposed = {
    port_id: record.port_id,
    version: record.version,
    archive_sha256: record.archive_sha256,
    immutable_tree_sha256: record.immutable_tree_sha256,
    path: replacement,
    executable: `${replacement}\\game.exe`,
    immutable_file_count: 17,
    preview_sha256: "inner-folder-check",
  };
  const preview = vi.spyOn(desktopApi, "previewExternalRuntimeRelink").mockResolvedValue({
    port_id: port.id,
    registration_id: record.id,
    previous_path: record.path,
    proposed,
    external_files_will_be_preserved: true,
    preview_sha256: "retained-record-and-folder",
  });
  const apply = vi
    .spyOn(desktopApi, "relinkExternalRuntime")
    .mockResolvedValue({ ...record, path: replacement, executable: proposed.executable });
  const register = vi.spyOn(desktopApi, "registerExternalRuntime");
  const remove = vi.spyOn(desktopApi, "removeExternalRuntime");
  const changed = vi.fn();
  await root.rerender(
    <ExternalRuntimeControl
      port={portDefinition()}
      status={{ ...portStatus(), external_runtime: record }}
      generation={9}
      busy={false}
      onChanged={changed}
    />,
  );
  await click("Change game folder…");
  expect(preview).toHaveBeenCalledExactlyOnceWith(port.id, replacement, 9);
  expect(document.body.textContent).toContain(record.path);
  expect(document.body.textContent).toContain(replacement);
  expect(apply).not.toHaveBeenCalled();
  await click("Change folder");
  expect(apply).toHaveBeenCalledExactlyOnceWith(
    port.id,
    replacement,
    "retained-record-and-folder",
    9,
  );
  expect(register).not.toHaveBeenCalled();
  expect(remove).not.toHaveBeenCalled();
  expect(changed).toHaveBeenCalledOnce();
});

it("keeps folder repair context after native consent cancellation and permits retry", async () => {
  vi.mocked(pickInstallFolder).mockResolvedValue("C:\\Moved");
  vi.spyOn(desktopApi, "previewExternalRuntimeRelink").mockResolvedValue({
    port_id: port.id,
    registration_id: record.id,
    previous_path: record.path,
    proposed: {
      port_id: record.port_id,
      version: record.version,
      archive_sha256: record.archive_sha256,
      immutable_tree_sha256: record.immutable_tree_sha256,
      path: "C:\\Moved",
      executable: "C:\\Moved\\game.exe",
      immutable_file_count: 17,
      preview_sha256: "inner",
    },
    external_files_will_be_preserved: true,
    preview_sha256: "outer",
  });
  const apply = vi.spyOn(desktopApi, "relinkExternalRuntime").mockResolvedValue(null);
  const changed = vi.fn();
  await root.rerender(
    <ExternalRuntimeControl
      port={port}
      status={{ ...portStatus(), external_runtime: record }}
      generation={8}
      busy={false}
      onChanged={changed}
    />,
  );
  await click("Change game folder…");
  await click("Change folder");
  expect(changed).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("C:\\Moved");
  await captureParityState("external-repair-consent-declined-fixture");
  await click("Change folder");
  expect(apply).toHaveBeenCalledTimes(2);
  expect(pickInstallFolder).toHaveBeenCalledOnce();
});

it("retains a reviewed folder after native cancellation and retries without choosing it again", async () => {
  vi.mocked(pickInstallFolder).mockResolvedValue(record.path);
  const preview = vi.spyOn(desktopApi, "previewExternalRuntime").mockResolvedValue({
    port_id: port.id,
    path: record.path,
    executable: record.executable,
    version: record.version,
    archive_sha256: record.archive_sha256,
    immutable_tree_sha256: record.immutable_tree_sha256,
    immutable_file_count: 17,
    preview_sha256: "reviewed-external",
  });
  const register = vi
    .spyOn(desktopApi, "registerExternalRuntime")
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce(record);
  const changed = vi.fn();
  await root.rerender(
    <ExternalRuntimeControl
      port={port}
      status={portStatus()}
      generation={7}
      busy={false}
      onChanged={changed}
    />,
  );
  await click("Choose game folder");
  await click("Use this installation");
  expect(changed).not.toHaveBeenCalled();
  expect(document.body.querySelector('[data-slot="dialog-content"]')?.textContent).toContain(
    record.path,
  );
  expect(document.body.textContent).not.toContain("Portcove couldn't use this installation");
  await captureParityState("external-registration-consent-declined-fixture");
  await click("Use this installation");
  expect(register).toHaveBeenCalledTimes(2);
  expect(register).toHaveBeenLastCalledWith(port.id, record.path, "reviewed-external", 7);
  expect(preview).toHaveBeenCalledOnce();
  expect(pickInstallFolder).toHaveBeenCalledOnce();
  expect(changed).toHaveBeenCalledOnce();
  expect(document.body.querySelector('[data-slot="dialog-content"]')).toBeNull();
});

it("shows authored steps and essential warnings while preserving detailed notes behind disclosure", async () => {
  const open = vi.spyOn(desktopApi, "openExternalUrl").mockResolvedValue(undefined);
  const register = vi.spyOn(desktopApi, "registerExternalRuntime");
  const requiredProgram = "bin/fixture-player.exe";
  const archiveDigest = "c".repeat(64);
  const guided = {
    ...port,
    release: {
      ...port.release,
      user_prepared: {
        "windows-x86-64": {
          version: record.version,
          archive_name: "owned-runtime.zip",
          archive_size: 0,
          archive_sha256: archiveDigest,
          immutable_tree_sha256: record.immutable_tree_sha256,
          executable: requiredProgram,
          mutable_paths: [],
          source_argument_extension: null,
        },
      },
    },
    presentation: {
      ...port.presentation,
      manual_preparation: "Exact compatibility, ownership and developer-option notes.",
      manual_setup: {
        steps: [
          { title: "Prepare a working copy", instruction: "Keep your original unchanged." },
          { title: "Review the folder", instruction: "Choose the prepared folder below." },
        ],
        warnings: ["Preserve the existing pilot; do not overwrite it."],
        references: [
          {
            title: "Inspected build save paths",
            instruction: "The inspected version writes profile/save.bin.",
          },
        ],
        help_url: "https://example.com/guide",
      },
    },
  };
  await root.rerender(
    <ExternalRuntimeControl port={guided} status={portStatus()} generation={9} busy={false} />,
  );
  const section = host.querySelector('[aria-label="Prepare this port"]')!;
  expect(section.querySelectorAll("ol > li")).toHaveLength(2);
  expect(section.textContent).toContain("You need your own original game files");
  const warning = section.querySelector("aside")!;
  expect(warning.textContent).toContain("Preserve the existing pilot");
  expect(warning.closest("details")).toBeNull();
  const notes = [...section.querySelectorAll("details")].find((element) =>
    element.textContent?.includes("developer-option notes"),
  );
  expect(notes?.open).toBe(false);
  const help = section.querySelector<HTMLAnchorElement>("a")!;
  const steps = document.querySelector("ol");
  expect(steps?.textContent).not.toContain("Inspected build save paths");
  await expect
    .element(page.getByText("The inspected version writes profile/save.bin."))
    .not.toBeVisible();
  const reference = page.getByText("Save locations and version notes", { exact: true });
  reference.element().focus();
  await page.getByText("Save locations and version notes", { exact: true }).click();
  await expect
    .element(page.getByText("The inspected version writes profile/save.bin."))
    .toBeVisible();
  expect(help.textContent).toBe("Detailed preparation guide");
  await act(async () => help.click());
  expect(open).toHaveBeenCalledExactlyOnceWith("https://example.com/guide");
  const program = externalPathWithin(section, requiredProgram, "required relative program");
  program.scrollIntoView({ block: "center" });
  expectCompleteExternalPath(program, "required relative program", requiredProgram);
  const digest = fixtureValue(
    [...section.querySelectorAll("code")].find((code) => code.textContent === archiveDigest),
    "archive hash",
  );
  expect(digest.getAttribute("dir")).toBeNull();
  expect(digest.classList.contains("path-value")).toBe(false);
  await captureParityState("external-relative-program-requirement");
  expect(register).not.toHaveBeenCalled();
  expect(pickInstallFolder).not.toHaveBeenCalled();
});

it.each(["native-portable", "staged-source-portable"] as const)(
  "keeps managed-copy promises out of the %s external-registration guide",
  async (adapter) => {
    const guided: PortDefinition = {
      ...port,
      adapter,
      release: { ...port.release, provider: "github" },
      presentation: {
        ...port.presentation,
        manual_preparation: "Portcove replaces and backs up the managed copy.",
        manual_setup: {
          steps: [
            {
              title: "Choose original files",
              instruction: "The game asks for your original files on first Play.",
            },
            {
              title: "Choose controls",
              instruction: "Use the game’s menus to choose your controls.",
            },
          ],
          warnings: [],
          help_url: "https://example.com/setup",
        },
      },
    };
    const register = vi.spyOn(desktopApi, "registerUserSelectedRuntime");
    await root.rerender(
      <UserSelectedRuntimeControl
        port={guided}
        status={portStatus()}
        generation={9}
        busy={false}
      />,
    );
    expect(host.textContent).toContain("The game asks for your original files on first Play.");
    expect(host.textContent).toContain("You or upstream provide runtime updates.");
    expect(host.textContent).not.toContain("Portcove replaces and backs up");
    expect(host.textContent).toContain("Use the game’s menus to choose your controls.");
    expect(register).not.toHaveBeenCalled();
  },
);

it.each(["colin-mcrae-rally-2-opencmr2", "alistert-openjazz", "citrongames-dora64"])(
  "keeps retained %s setup truthful after the definition and listing disappear",
  async (id) => {
    const listing = proposals.listings.find((candidate) => candidate.id === id) as PortListing;
    const pending: PendingSetupRecord = {
      id: "retained-download",
      reason: null,
      port_id: id,
      listing,
      path: "C:/Downloads/game",
      state: "downloaded",
      downloaded_at: "2026-10-24T00:00:00Z",
      archive_sha256: "a".repeat(64),
      artifact: {
        release_id: 1,
        asset_id: 2,
        release_tag: "v1",
        name: "game.zip",
        size: 1024,
        release_url: "https://example.com/v1",
        download_url: "https://example.com/game.zip",
        can_extract: true,
        sha256: null,
      },
    };
    const entry = catalogEntries(undefined, undefined, [], [pending])[0]!;
    expect(entry.definition).toBeUndefined();
    expect(entry.adapter).toBeUndefined();
    await root.rerender(
      <UserSelectedRuntimeControl port={entry} status={portStatus()} generation={9} busy={false} />,
    );
    expect(host.textContent).toContain(listing.manual_setup!.steps[0]!.instruction);
    expect(host.textContent).not.toContain("Portcove retains");
    expect(host.textContent).not.toContain("declared for compatible");
    expect(host.textContent).not.toContain("is carried between compatible versions");
    expect(host.textContent).toContain("You or upstream provide runtime updates.");
  },
);

it.each([
  [
    "colin-mcrae-rally-2-opencmr2",
    "The supported original files can stay in their existing folder.",
  ],
  [
    "alistert-openjazz",
    "For external registration, use Change launch details to add game-data as a launch argument",
  ],
])("keeps the frozen proposed %s external setup handoff actionable", async (id, instruction) => {
  const authored = proposals.ports.find(
    (candidate) => candidate.id === id,
  ) as unknown as PortDefinition;
  expect(authored).toBeDefined();
  await root.rerender(
    <UserSelectedRuntimeControl
      port={authored}
      status={portStatus()}
      generation={9}
      busy={false}
    />,
  );
  expect(document.body.textContent).toContain(instruction);
  expect(document.body.textContent).not.toContain("is carried between compatible versions");
  expect(document.body.textContent).not.toContain("Portcove retains");
});

function expectExternalMetadataLayout(metadata: Element) {
  const labels = [...metadata.querySelectorAll("small")];
  expect(labels.map((label) => label.textContent)).toEqual([
    "Version",
    "Checked files",
    "Folder",
    "Game program",
  ]);
  const facts = labels.map((label) =>
    fixtureValue(label.parentElement, `${label.textContent} metadata fact`).getBoundingClientRect(),
  );
  const version = fixtureValue(facts[0], "Version fact");
  const checked = fixtureValue(facts[1], "Checked files fact");
  const folder = fixtureValue(facts[2], "Folder fact");
  const program = fixtureValue(facts[3], "Game program fact");
  const bounds = metadata.getBoundingClientRect();
  expect(version.width).toBeGreaterThan(0);
  expect(Math.abs(version.top - checked.top)).toBeLessThanOrEqual(1);
  expect(Math.abs(version.width - checked.width)).toBeLessThanOrEqual(1);
  expect(checked.left).toBeGreaterThan(version.right);
  expect(folder.top).toBeGreaterThan(version.bottom);
  expect(program.top).toBeGreaterThan(folder.bottom);
  for (const path of [folder, program]) {
    expect(Math.abs(path.left - bounds.left)).toBeLessThanOrEqual(1);
    expect(Math.abs(path.right - bounds.right)).toBeLessThanOrEqual(1);
    expect(path.width).toBeGreaterThan(version.width * 2);
  }
  // Short facts must not stretch to match these deliberately long paths.
  expect(version.height).toBeLessThan(folder.height);
  expect(checked.height).toBeLessThan(program.height);
}

function expectLtrArgumentValue(target: Element, expected: string) {
  const actual = target instanceof HTMLTextAreaElement ? target.value : target.textContent;
  expect(actual).toBe(expected);
  expect(target.getAttribute("dir")).toBe("ltr");
  expect(getComputedStyle(target).direction).toBe("ltr");
}

function expectReviewedArguments(review: Element, arguments_: readonly string[]) {
  const values = [...review.querySelectorAll<HTMLElement>("dd code")];
  const nonempty = arguments_.filter((argument) => argument !== "");
  expect(values.map((code) => code.textContent)).toEqual(nonempty);
  for (const [index, value] of values.entries()) {
    expectLtrArgumentValue(value, fixtureValue(nonempty[index], "exact reviewed argument"));
  }
  const emptyPlaceholders = [...review.querySelectorAll("dd span")].filter(
    (span) => span.textContent === "Empty argument",
  );
  expect(emptyPlaceholders).toHaveLength(arguments_.filter((argument) => argument === "").length);
}

function externalPathWithin(container: Element, path: string, label: string) {
  return fixtureValue(
    [...container.querySelectorAll("code, dd")].find((element) => element.textContent === path),
    label,
  );
}

function expectCompleteExternalPath(target: Element, label: string, path: string) {
  expect(target.textContent).toBe(path);
  expect(target.getAttribute("dir")).toBe("ltr");
  expect(getComputedStyle(target).direction).toBe("ltr");
  const text = fixtureValue(target.firstChild, `${label} path text`);
  const firstLine = document.createRange();
  firstLine.setStart(text, 0);
  firstLine.setEnd(text, 12);
  // The extended Windows prefix must share its first line with the actual drive/path.
  expect(firstLine.getClientRects()).toHaveLength(1);
  const range = document.createRange();
  range.selectNodeContents(target);
  const container = fixtureValue(
    target.parentElement,
    `${label} path owner`,
  ).getBoundingClientRect();
  for (const line of range.getClientRects()) {
    expect(line.left).toBeGreaterThanOrEqual(container.left - 1);
    expect(line.right).toBeLessThanOrEqual(container.right + 1);
    requireCompleteCaptureTarget(
      {
        target: label,
        target_count: 1,
        visible: true,
        rect: { x: line.x, y: line.y, width: line.width, height: line.height },
        viewport: { width: innerWidth, height: innerHeight },
      },
      label,
    );
  }
}

it.each(
  (["dark", "light"] as const).flatMap((theme) => [
    { theme, width: 1028, height: 750 },
    { theme, width: 430, height: 896 },
  ]),
)(
  "keeps exact external review paths together in $theme at $width",
  async ({ theme, width, height }) => {
    const oldTheme = document.documentElement.dataset.theme;
    const oldViewport = { width: innerWidth, height: innerHeight };
    const path = String.raw`\\?\D:\a\portcove\portcove\work\native-product-workflows-external-runtime-review\desktop-verify\2026-11-18T21-56-52-463Z-Fxdn5N\native\player-owned-runtime`;
    const executable = `${path}\\game.exe`;
    const selected = { ...record, path, executable };
    const entry = { ...port, name: "Portcove External Runtime Fixture" };
    vi.mocked(pickInstallFolder).mockResolvedValue(path);
    const preview = vi.spyOn(desktopApi, "previewExternalRuntime").mockResolvedValue({
      port_id: entry.id,
      path,
      executable,
      version: selected.version,
      archive_sha256: selected.archive_sha256,
      immutable_tree_sha256: selected.immutable_tree_sha256,
      immutable_file_count: 17,
      preview_sha256: "reviewed-exact-paths",
    });
    const register = vi.spyOn(desktopApi, "registerExternalRuntime").mockResolvedValue(selected);
    const changed = vi.fn();
    try {
      await page.viewport(width, height);
      document.documentElement.dataset.theme = theme;
      await root.rerender(
        <ExternalRuntimeControl
          port={entry}
          status={portStatus()}
          generation={7}
          busy={false}
          onChanged={changed}
        />,
      );
      await page.getByRole("button", { name: "Choose game folder", exact: true }).click();
      const dialog = page.getByRole("dialog");
      await expect.element(dialog).toBeVisible();
      await expect.element(page.getByRole("button", { name: "Cancel", exact: true })).toHaveFocus();
      await document.fonts.ready;
      const metadata = fixtureValue(
        document.querySelector('[aria-label="External runtime review"]'),
        "actual external review metadata",
      );
      expectExternalMetadataLayout(metadata);
      const pathFor = (label: string) => {
        const heading = fixtureValue(
          [...metadata.querySelectorAll("small")].find((small) => small.textContent === label),
          label,
        );
        return fixtureValue(heading.parentElement?.querySelector("code"), `${label} exact path`);
      };
      expectCompleteExternalPath(pathFor("Folder"), "Folder", path);
      expectCompleteExternalPath(pathFor("Game program"), "Game program", executable);
      expect(metadata.textContent).toContain(selected.version);
      expect(metadata.textContent).toContain("Checked files17");
      await expect
        .element(
          page.getByText(
            "Portcove will save this location and check the required files before each launch. It will not copy, update, back up, or delete the external folder.",
            { exact: true },
          ),
        )
        .toBeVisible();
      const primary = page.getByRole("button", { name: "Use this installation", exact: true });
      const cancel = page.getByRole("button", { name: "Cancel", exact: true });
      for (const control of [cancel, primary]) {
        await expect.element(control).toBeEnabled();
        const bounds = control.element().getBoundingClientRect();
        requireCompleteCaptureTarget(
          {
            target: "external review action",
            target_count: 1,
            visible: true,
            rect: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
            viewport: { width: innerWidth, height: innerHeight },
          },
          "external review action",
        );
      }
      expect(dialog.element().scrollWidth).toBeLessThanOrEqual(dialog.element().clientWidth);
      expect(preview).toHaveBeenCalledExactlyOnceWith(entry.id, path, 7);
      expect(register).not.toHaveBeenCalled();
      expect(changed).not.toHaveBeenCalled();
      await captureParityState("external-registration-exact-paths");
      await userEvent.keyboard("{Tab}");
      await expect.element(primary).toHaveFocus();
      await userEvent.keyboard("{Enter}");
      expect(register).toHaveBeenCalledExactlyOnceWith(entry.id, path, "reviewed-exact-paths", 7);
      expect(changed).toHaveBeenCalledOnce();
    } finally {
      await root.rerender(null);
      if (oldTheme === undefined) delete document.documentElement.dataset.theme;
      else document.documentElement.dataset.theme = oldTheme;
      await page.viewport(oldViewport.width, oldViewport.height);
    }
  },
);

it.each(["dark", "light"] as const)(
  "keeps long previous and replacement paths in the compact %s relink review",
  async (theme) => {
    const oldTheme = document.documentElement.dataset.theme;
    const oldViewport = { width: innerWidth, height: innerHeight };
    const previousPath = String.raw`\\?\C:\Player\External runtime installations\Original release folder\Saved portable game files\Current version`;
    const replacement = String.raw`\\?\D:\Player\External runtime installations\Moved portable game files\Checked replacement release folder\Current version`;
    const existing = { ...record, path: previousPath, executable: `${previousPath}\\game.exe` };
    const entry = { ...portDefinition(), name: "Portcove External Runtime Fixture" };
    const proposed = {
      port_id: entry.id,
      path: replacement,
      executable: `${replacement}\\game.exe`,
      version: record.version,
      archive_sha256: record.archive_sha256,
      immutable_tree_sha256: record.immutable_tree_sha256,
      immutable_file_count: 17,
      preview_sha256: "inner-relink-paths",
    };
    vi.mocked(pickInstallFolder).mockResolvedValue(replacement);
    const preview = vi.spyOn(desktopApi, "previewExternalRuntimeRelink").mockResolvedValue({
      port_id: entry.id,
      registration_id: existing.id,
      previous_path: previousPath,
      proposed,
      external_files_will_be_preserved: true,
      preview_sha256: "outer-relink-paths",
    });
    const apply = vi
      .spyOn(desktopApi, "relinkExternalRuntime")
      .mockResolvedValue({ ...existing, path: replacement, executable: proposed.executable });
    const register = vi
      .spyOn(desktopApi, "registerExternalRuntime")
      .mockRejectedValue(new Error("Unexpected new registration"));
    const remove = vi
      .spyOn(desktopApi, "removeExternalRuntime")
      .mockRejectedValue(new Error("Unexpected removal"));
    const ordinaryPreview = vi
      .spyOn(desktopApi, "previewExternalRuntime")
      .mockRejectedValue(new Error("Unexpected registration preview"));
    const changed = vi.fn();
    const complete = (target: Element, label: string) => {
      const bounds = target.getBoundingClientRect();
      requireCompleteCaptureTarget(
        {
          target: label,
          target_count: 1,
          visible: true,
          rect: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
          viewport: { width: innerWidth, height: innerHeight },
        },
        label,
      );
    };
    try {
      await page.viewport(430, 896);
      document.documentElement.dataset.theme = theme;
      await root.rerender(
        <ExternalRuntimeControl
          port={entry}
          status={{ ...portStatus(), external_runtime: existing }}
          generation={9}
          busy={false}
          onChanged={changed}
        />,
      );
      const registeredPath = externalPathWithin(host, previousPath, "registered Folder");
      expectCompleteExternalPath(registeredPath, "registered Folder", previousPath);
      await captureParityState("external-registered-exact-path");
      await page.getByRole("button", { name: "Change game folder…", exact: true }).click();
      const dialog = page.getByRole("dialog");
      await expect.element(dialog).toBeVisible();
      const cancel = page.getByRole("button", { name: "Cancel", exact: true });
      await expect.element(cancel).toHaveFocus();
      await document.fonts.ready;
      const previous = fixtureValue(
        [...dialog.element().querySelectorAll("code")].find(
          (code) => code.textContent === previousPath,
        ),
        "Previous folder path",
      );
      const previousContext = fixtureValue(previous.parentElement, "Previous folder consequence");
      previousContext.scrollIntoView({ block: "center" });
      expectCompleteExternalPath(previous, "Previous folder", previousPath);
      expect([...previousContext.children].map((child) => child.textContent)).toEqual([
        "Previous folder:",
        previousPath,
        "Its files stay where they are.",
      ]);
      complete(previousContext, "whole Previous folder consequence");
      const consent = page.getByText(
        "Portcove will save this location and check the required files before each launch. It will not copy, update, back up, or delete the external folder.",
        { exact: true },
      );
      await expect.element(consent).toBeVisible();
      complete(consent.element(), "whole external ownership disclosure");
      expect(apply).not.toHaveBeenCalled();
      expect(changed).not.toHaveBeenCalled();
      await captureParityState("external-relink-previous-folder");

      const primary = page.getByRole("button", { name: "Change folder", exact: true });
      primary.element().scrollIntoView({ block: "end" });
      const metadata = fixtureValue(
        dialog.element().querySelector('[aria-label="External runtime review"]'),
        "replacement review metadata",
      );
      expectExternalMetadataLayout(metadata);
      const codes = [...metadata.querySelectorAll("code")];
      expect(codes).toHaveLength(2);
      expectCompleteExternalPath(
        fixtureValue(
          codes.find((code) => code.textContent === replacement),
          "replacement Folder",
        ),
        "Folder",
        replacement,
      );
      expectCompleteExternalPath(
        fixtureValue(
          codes.find((code) => code.textContent === proposed.executable),
          "replacement Game program",
        ),
        "Game program",
        proposed.executable,
      );
      for (const control of [cancel, primary]) {
        await expect.element(control).toBeEnabled();
        complete(control.element(), "whole relink review action");
      }
      expect(dialog.element().scrollWidth).toBeLessThanOrEqual(dialog.element().clientWidth);
      expect(preview).toHaveBeenCalledExactlyOnceWith(entry.id, replacement, 9);
      expect(apply).not.toHaveBeenCalled();
      expect(ordinaryPreview).not.toHaveBeenCalled();
      expect(register).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
      await captureParityState("external-relink-replacement-footer");
      await expect.element(cancel).toHaveFocus();
      await userEvent.keyboard("{Tab}");
      await expect.element(primary).toHaveFocus();
      await userEvent.keyboard("{Enter}");
      expect(apply).toHaveBeenCalledExactlyOnceWith(entry.id, replacement, "outer-relink-paths", 9);
      expect(changed).toHaveBeenCalledOnce();
      expect(ordinaryPreview).not.toHaveBeenCalled();
      expect(register).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
    } finally {
      await root.rerender(null);
      if (oldTheme === undefined) delete document.documentElement.dataset.theme;
      else document.documentElement.dataset.theme = oldTheme;
      await page.viewport(oldViewport.width, oldViewport.height);
    }
  },
);

it("reviews an exact player-owned folder before registering it", async () => {
  vi.mocked(pickInstallFolder).mockResolvedValue(record.path);
  const preview = vi.spyOn(desktopApi, "previewExternalRuntime").mockResolvedValue({
    port_id: port.id,
    path: record.path,
    executable: record.executable,
    version: record.version,
    archive_sha256: record.archive_sha256,
    immutable_tree_sha256: record.immutable_tree_sha256,
    immutable_file_count: 17,
    preview_sha256: "reviewed-external",
  });
  const register = vi.spyOn(desktopApi, "registerExternalRuntime").mockResolvedValue(record);
  const changed = vi.fn();
  await root.rerender(
    <ExternalRuntimeControl
      port={port}
      status={portStatus()}
      generation={7}
      busy={false}
      onChanged={changed}
    />,
  );
  await click("Choose game folder");
  expect(document.body.textContent).toContain("Create an empty portable.txt");
  expect(preview).toHaveBeenCalledExactlyOnceWith(port.id, record.path, 7);
  expect(document.body.textContent).toContain(record.executable);
  expect(register).not.toHaveBeenCalled();
  await captureParityState("external-registration-reviewed-fixture");
  await click("Use this installation");
  expect(register).toHaveBeenCalledExactlyOnceWith(port.id, record.path, "reviewed-external", 7);
  expect(changed).toHaveBeenCalledOnce();
});

it("removes only the external registration through the separate reviewed action", async () => {
  const retainedPath = String.raw`\\?\C:\Player\External runtime installations\نسخة محفوظة\Original game files`;
  const retained = { ...record, path: retainedPath, executable: `${retainedPath}\\game.exe` };
  vi.spyOn(desktopApi, "previewExternalRemoval").mockResolvedValue({
    port_id: port.id,
    path: retained.path,
    version: record.version,
    external_files_will_be_preserved: true,
    preview_sha256: "reviewed-removal",
  });
  const remove = vi.spyOn(desktopApi, "removeExternalRuntime").mockResolvedValue(retained);
  const managedUninstall = vi.spyOn(desktopApi, "remove");
  const changed = vi.fn();
  await root.rerender(
    <ExternalRuntimeControl
      port={port}
      status={{ ...portStatus(), external_runtime: retained }}
      generation={7}
      busy={false}
      onChanged={changed}
    />,
  );
  host.dir = "rtl";
  const registeredPath = externalPathWithin(host, retainedPath, "retained removal Folder");
  expectCompleteExternalPath(registeredPath, "retained removal Folder", retainedPath);
  await captureParityState("external-registered-removal-path");
  await click("Stop using this installation");
  expect(document.body.textContent).toContain("The files stay where they are, including");
  const path = externalPathWithin(
    page.getByRole("dialog").element(),
    retainedPath,
    "preserved removal Folder",
  );
  expectCompleteExternalPath(path, "preserved removal Folder", retainedPath);
  await captureParityState("external-removal-reviewed-fixture");
  await click("Stop using this installation");
  expect(remove).toHaveBeenCalledExactlyOnceWith(port.id, "reviewed-removal", 7);
  expect(managedUninstall).not.toHaveBeenCalled();
  expect(changed).toHaveBeenCalledOnce();
});

it("explains a held external registration before opening a folder picker", async () => {
  const picker = vi.mocked(pickInstallFolder);
  await root.rerender(
    <ExternalRuntimeControl
      port={port}
      status={{
        ...portStatus(),
        port_actions: [
          {
            action: "register_external",
            availability: "held",
            reason: "definition_ineligible",
            definition: { outcome: "hold", reason: "publisher_revoked" },
          },
        ],
      }}
      generation={7}
      busy={false}
    />,
  );
  expect(document.body.textContent).toContain(
    "Setup is on hold. The catalog publisher was revoked.",
  );
  expect(document.body.querySelector("button")?.disabled).toBe(true);
  expect(picker).not.toHaveBeenCalled();
});

it("does not invent a cause for an unknown external route hold", async () => {
  await root.rerender(
    <ExternalRuntimeControl
      port={port}
      status={{
        ...portStatus(),
        port_actions: [
          {
            action: "register_external",
            availability: "held",
            reason: "definition_ineligible",
            definition: { outcome: "hold", reason: "future_reason" as never },
          },
        ],
      }}
      generation={7}
      busy={false}
    />,
  );
  expect(document.body.textContent).toContain(
    "Can't check setup right now. View details for current requirements.",
  );
  expect(document.body.textContent).not.toContain("future_reason");
  await captureParityState("external-unknown-route-held-fixture");
});

const otherPort = { ...port, id: "another-external-port", name: "Another game" };

it.each([
  ["missing status", undefined],
  ["partial actions", [{ action: "install", availability: "allowed", reason: "available" }]],
  [
    "duplicate actions",
    [
      { action: "register_external", availability: "waiting", reason: "review_required" },
      { action: "register_external", availability: "not_offered", reason: "unsupported_platform" },
    ],
  ],
  [
    "unknown availability",
    [{ action: "register_external", availability: "future", reason: "review_required" }],
  ],
  [
    "contradictory definition",
    [
      {
        action: "register_external",
        availability: "waiting",
        reason: "review_required",
        definition: { outcome: "hold", reason: "publisher_revoked" },
      },
    ],
  ],
] as const)("does not open the picker for %s", async (name, actions) => {
  const picker = vi.mocked(pickInstallFolder);
  const preview = vi.spyOn(desktopApi, "previewExternalRuntime");
  await root.rerender(
    <ExternalRuntimeControl
      port={port}
      status={
        name === "missing status" ? undefined : { ...portStatus(), port_actions: actions as never }
      }
      generation={7}
      busy={false}
    />,
  );
  expect(document.body.textContent).toContain(
    "Can't check setup right now. View details for current requirements.",
  );
  expect(document.body.querySelector("button")?.disabled).toBe(true);
  await click("Choose game folder");
  expect(picker).not.toHaveBeenCalled();
  expect(preview).not.toHaveBeenCalled();
});

it.each([undefined, []] as const)("preserves the legacy %s projection", async (actions) => {
  await root.rerender(
    <ExternalRuntimeControl
      port={port}
      status={{ ...portStatus(), port_actions: actions as never }}
      generation={7}
      busy={false}
    />,
  );
  expect(document.body.querySelector("button")?.disabled).toBe(false);
});

it("recovers from a missing current route when a fresh review assessment arrives", async () => {
  const render = (actions: NonNullable<ReturnType<typeof portStatus>["port_actions"]>) =>
    root.rerender(
      <ExternalRuntimeControl
        port={port}
        status={{ ...portStatus(), port_actions: actions }}
        generation={7}
        busy={false}
      />,
    );
  await render([{ action: "install", availability: "allowed", reason: "available" }]);
  expect(document.body.querySelector("button")?.disabled).toBe(true);
  await render([
    { action: "register_external", availability: "waiting", reason: "review_required" },
  ]);
  expect(document.body.querySelector("button")?.disabled).toBe(false);
  vi.mocked(pickInstallFolder).mockResolvedValue(record.path);
  const preview = vi
    .spyOn(desktopApi, "previewExternalRuntime")
    .mockResolvedValue(runtimePreview());
  const register = vi.spyOn(desktopApi, "registerExternalRuntime");
  await click("Choose game folder");
  expect(preview).toHaveBeenCalledExactlyOnceWith(port.id, record.path, 7);
  expect(register).not.toHaveBeenCalled();
});

function runtimePreview() {
  return {
    port_id: port.id,
    path: record.path,
    executable: record.executable,
    version: record.version,
    archive_sha256: record.archive_sha256,
    immutable_tree_sha256: record.immutable_tree_sha256,
    immutable_file_count: 17,
    preview_sha256: "reviewed-external",
  };
}

it.each(["port", "library", "away-and-back"] as const)(
  "discards a delayed folder choice after a %s context change",
  async (change) => {
    let resolvePicker!: (path: string) => void;
    vi.mocked(pickInstallFolder).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePicker = resolve;
        }),
    );
    const preview = vi
      .spyOn(desktopApi, "previewExternalRuntime")
      .mockResolvedValue(runtimePreview());
    const register = vi.spyOn(desktopApi, "registerExternalRuntime");
    const render = (selectedPort = port, generation = 7) =>
      root.rerender(
        <ExternalRuntimeControl
          port={selectedPort}
          status={portStatus()}
          generation={generation}
          busy={false}
        />,
      );
    await render();
    await click("Choose game folder");
    if (change === "library") await render(port, 8);
    else await render(otherPort);
    if (change === "away-and-back") await render();
    await act(async () => resolvePicker(record.path));
    expect(document.body.querySelector('[data-slot="dialog-content"]')).toBeNull();
    expect(preview).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
  },
);

it("closes an existing registration review instead of reviewing another game's folder", async () => {
  vi.mocked(pickInstallFolder).mockResolvedValue(record.path);
  const preview = vi
    .spyOn(desktopApi, "previewExternalRuntime")
    .mockResolvedValue(runtimePreview());
  const register = vi.spyOn(desktopApi, "registerExternalRuntime");
  const render = (selectedPort = port) =>
    root.rerender(
      <ExternalRuntimeControl
        port={selectedPort}
        status={portStatus()}
        generation={7}
        busy={false}
      />,
    );
  await render();
  await click("Choose game folder");
  expect(preview).toHaveBeenCalledExactlyOnceWith(port.id, record.path, 7);
  await render(otherPort);
  expect(document.body.querySelector('[data-slot="dialog-content"]')).toBeNull();
  expect(preview).toHaveBeenCalledOnce();
  expect(register).not.toHaveBeenCalled();
});

it.each(["library", "registration"] as const)(
  "closes a removal review when its %s context changes",
  async (change) => {
    const preview = vi.spyOn(desktopApi, "previewExternalRemoval").mockResolvedValue({
      port_id: port.id,
      path: record.path,
      version: record.version,
      external_files_will_be_preserved: true,
      preview_sha256: "reviewed-removal",
    });
    const remove = vi.spyOn(desktopApi, "removeExternalRuntime");
    const render = (generation = 7, external = record) =>
      root.rerender(
        <ExternalRuntimeControl
          port={port}
          status={{ ...portStatus(), external_runtime: external }}
          generation={generation}
          busy={false}
        />,
      );
    await render();
    await click("Stop using this installation");
    expect(preview).toHaveBeenCalledExactlyOnceWith(port.id, 7);
    await render(
      change === "library" ? 8 : 7,
      change === "registration" ? { ...record, id: "replacement-registration" } : record,
    );
    expect(document.body.querySelector('[data-slot="dialog-content"]')).toBeNull();
    expect(preview).toHaveBeenCalledOnce();
    expect(remove).not.toHaveBeenCalled();
  },
);

it.each(["same context", "new context"] as const)(
  "does not replace a fresh review with a late picker from the %s",
  async (context) => {
    let resolveOldPicker!: (path: string) => void;
    vi.mocked(pickInstallFolder)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOldPicker = resolve;
          }),
      )
      .mockResolvedValueOnce("C:\\Player\\FreshRuntime");
    const preview = vi
      .spyOn(desktopApi, "previewExternalRuntime")
      .mockResolvedValue(runtimePreview());
    const register = vi.spyOn(desktopApi, "registerExternalRuntime");
    const render = (selectedPort = port) =>
      root.rerender(
        <ExternalRuntimeControl
          port={selectedPort}
          status={portStatus()}
          generation={7}
          busy={false}
        />,
      );
    await render();
    await click("Choose game folder");
    const currentPort = context === "new context" ? otherPort : port;
    if (context === "new context") await render(currentPort);
    await click("Choose game folder");
    expect(preview).toHaveBeenCalledExactlyOnceWith(currentPort.id, "C:\\Player\\FreshRuntime", 7);
    await act(async () => resolveOldPicker(record.path));
    expect(preview).toHaveBeenCalledOnce();
    expect(document.body.querySelector('[data-slot="dialog-content"]')?.textContent).toContain(
      currentPort.name,
    );
    expect(register).not.toHaveBeenCalled();
  },
);

it("discards a folder choice after the control is unmounted", async () => {
  let resolvePicker!: (path: string) => void;
  vi.mocked(pickInstallFolder).mockImplementation(
    () =>
      new Promise((resolve) => {
        resolvePicker = resolve;
      }),
  );
  const preview = vi.spyOn(desktopApi, "previewExternalRuntime");
  await root.rerender(
    <ExternalRuntimeControl port={port} status={portStatus()} generation={7} busy={false} />,
  );
  await click("Choose game folder");
  await root.rerender(null);
  await act(async () => resolvePicker(record.path));
  expect(preview).not.toHaveBeenCalled();
  expect(document.body.querySelector('[data-slot="dialog-content"]')).toBeNull();
});

it("keeps a cancelled current folder choice out of review", async () => {
  vi.mocked(pickInstallFolder).mockResolvedValue(null);
  const preview = vi.spyOn(desktopApi, "previewExternalRuntime");
  await root.rerender(
    <ExternalRuntimeControl port={port} status={portStatus()} generation={7} busy={false} />,
  );
  await click("Choose game folder");
  expect(preview).not.toHaveBeenCalled();
  expect(document.body.querySelector('[data-slot="dialog-content"]')).toBeNull();
});

it.each(
  [
    [{ action: "launch", availability: "allowed", reason: "available" }],
    [
      {
        action: "remove_external",
        availability: "waiting",
        reason: "review_required",
        definition: { outcome: "hold", reason: "publisher_revoked" },
      },
    ],
    [{ action: "remove_external", availability: "allowed", reason: "available" }],
    [
      { action: "remove_external", availability: "waiting", reason: "review_required" },
      { action: "remove_external", availability: "not_offered", reason: "not_installed" },
    ],
  ].map((actions, index) => ({
    name: ["missing route", "definition hold", "wrong tuple", "duplicate"][index],
    actions,
  })),
)("does not open removal for $name", async ({ actions }) => {
  const preview = vi.spyOn(desktopApi, "previewExternalRemoval");
  await root.rerender(
    <ExternalRuntimeControl
      port={port}
      status={{ ...portStatus(), external_runtime: record, port_actions: actions as never }}
      generation={7}
      busy={false}
    />,
  );
  const stop = [...document.body.querySelectorAll("button")].find(
    (button) => button.textContent === "Stop using this installation",
  );
  expect(stop?.disabled).toBe(true);
  await click("Stop using this installation");
  expect(preview).not.toHaveBeenCalled();
  expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  expect(document.body.textContent).toContain(
    "Portcove couldn’t check whether you can remove this installation",
  );
});

it("explains a required external release mismatch without reporting an uncertain registration", async () => {
  vi.mocked(pickInstallFolder).mockResolvedValue(record.path);
  const error = failureReport();
  error.code = "verification";
  error.presentation.presentation_key = "verification_failed";
  error.presentation.summary = "Required verification did not pass.";
  error.presentation.technical_message =
    "user-prepared runtime differs from the accepted immutable package";
  error.presentation.technical_context = {
    expected_tree_sha256: "a".repeat(64),
    actual_tree_sha256: "b".repeat(64),
  };
  const preview = vi
    .spyOn(desktopApi, "previewExternalRuntime")
    .mockResolvedValue(runtimePreview())
    .mockRejectedValueOnce(error);
  const register = vi.spyOn(desktopApi, "registerExternalRuntime").mockResolvedValue(record);
  const viewport = { width: innerWidth, height: innerHeight };
  try {
    await page.viewport(1028, 749);
    await root.rerender(
      <ExternalRuntimeControl port={port} status={portStatus()} generation={7} busy={false} />,
    );
    await page.getByRole("button", { name: "Choose game folder", exact: true }).click();
    const dialog = page.getByRole("dialog");
    const alert = dialog.getByRole("alert");
    await expect
      .element(alert.getByText(/The files in this folder don’t match the required release/))
      .toBeVisible();
    await expect
      .element(alert.getByText(/couldn't confirm whether anything changed/))
      .not.toBeInTheDocument();
    await expect.element(dialog.getByRole("button", { name: "Cancel", exact: true })).toHaveFocus();
    await expect
      .element(dialog.getByRole("button", { name: "Use this installation", exact: true }))
      .not.toBeInTheDocument();
    await captureParityState("external-runtime-preview-release-mismatch");
    await alert.getByText("View technical details", { exact: true }).click();
    const diagnostic = fixtureValue(alert.element().querySelector("pre"), "mismatch diagnostic");
    expect(JSON.parse(diagnostic.textContent)).toEqual({
      code: error.code,
      mutation_state: "unknown",
      phase: null,
      message: error.presentation.technical_message,
      context: error.presentation.technical_context,
    });
    await captureParityState("external-runtime-preview-release-mismatch-details");
    await dialog.getByRole("button", { name: "Check again", exact: true }).click();
    await expect
      .element(dialog.getByRole("button", { name: "Use this installation", exact: true }))
      .toBeEnabled();
    expect(preview).toHaveBeenCalledTimes(2);
    expect(register).not.toHaveBeenCalled();
  } finally {
    await page.viewport(viewport.width, viewport.height);
  }
});

it.each([
  ["not_started", "This operation did not start."],
  ["no_changes", "No files were changed by this operation."],
  ["committed", "The change was saved. Check the result before trying again."],
  ["recovery_required", "An earlier attempt left unfinished work."],
  ["unknown", "Portcove couldn't confirm whether anything changed."],
] as const)(
  "preserves the reported %s outcome and makes Check again read-only",
  async (state, text) => {
    vi.mocked(pickInstallFolder).mockResolvedValue(record.path);
    const preview = vi
      .spyOn(desktopApi, "previewExternalRuntime")
      .mockResolvedValue(runtimePreview());
    const failure = failureReport();
    failure.presentation.mutation_state = state;
    failure.presentation.summary =
      "Check this runtime's current registration before another attempt.";
    failure.presentation.phase = "registration_readback";
    failure.presentation.technical_context = { port_id: port.id };
    if (state === "unknown") {
      failure.code = "verification";
      failure.presentation.technical_context = {
        expected_tree_sha256: "a".repeat(64),
        actual_tree_sha256: "b".repeat(64),
      };
    }
    const register = vi.spyOn(desktopApi, "registerExternalRuntime").mockRejectedValue(failure);
    await root.rerender(
      <ExternalRuntimeControl port={port} status={portStatus()} generation={7} busy={false} />,
    );
    await click("Choose game folder");
    await click("Use this installation");
    const alert = document.body.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain(failure.presentation.summary);
    expect(alert?.textContent).toContain(text);
    expect(alert?.textContent).toContain("View technical details");
    expect(alert?.textContent).toContain("registration_readback");
    expect(alert?.textContent).toContain(failure.code);
    expect(document.body.querySelector("button")?.textContent).not.toBe("Use this installation");
    await click("Check again");
    expect(preview).toHaveBeenCalledTimes(2);
    expect(register).toHaveBeenCalledOnce();
    expect(document.body.querySelector('[role="alert"]')).toBeNull();
  },
);

it("announces only a proven neutral cancellation as status", async () => {
  vi.mocked(pickInstallFolder).mockResolvedValue(record.path);
  const failure = failureReport();
  failure.code = "cancelled";
  failure.presentation.tone = "neutral";
  failure.presentation.mutation_state = "no_changes";
  failure.presentation.summary = "The operation was cancelled.";
  vi.spyOn(desktopApi, "previewExternalRuntime").mockRejectedValue(failure);
  await root.rerender(
    <ExternalRuntimeControl port={port} status={portStatus()} generation={7} busy={false} />,
  );
  await click("Choose game folder");
  expect(document.body.querySelector('[role="alert"]')).toBeNull();
  expect(document.body.querySelector('[role="status"]')?.textContent).toContain(
    "The operation was cancelled.",
  );
  expect(document.body.querySelector('[role="status"]')?.textContent).toContain(
    "No files were changed",
  );
});

it("keeps future and legacy failure outcomes unknown", async () => {
  const future = failureReport();
  const value = {
    ...future,
    presentation: { ...future.presentation, mutation_state: "future_outcome", tone: "neutral" },
  };
  await root.rerender(<ActionReviewFailure error={value} />);
  expect(document.body.querySelector('[role="alert"]')?.textContent).toContain(
    "Portcove couldn't confirm whether anything changed.",
  );
  expect(document.body.textContent).not.toContain("No files were changed");
  await root.rerender(<ActionReviewFailure error={new Error("Read current state again.")} />);
  expect(document.body.querySelector('[role="alert"]')?.textContent).toBe(
    "Read current state again.",
  );
  expect(document.body.textContent).not.toContain("No files were changed");
});

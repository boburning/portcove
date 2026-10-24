import { controlledAct as act } from "../../test/controlled-react-act";
import { render as renderComponent, cleanup, type RenderResult } from "vitest-browser-react";

import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { desktopApi } from "../api";
import { pickInstallFolder, pickHostToolExecutable } from "../file-picker";
import { failureReport, portDefinition, portStatus } from "../test-fixtures";
import type { ExternalRuntimeRecord, PortListingStatus } from "../types";
import { ExternalRuntimeControl, UserSelectedRuntimeControl } from "./ExternalRuntime";
import { catalogEntries } from "../features/browsing/catalog-entry";
import { ActionReviewFailure } from "./ActionReviewFailure";
import { DetailLayout } from "./DetailLayout";

vi.mock("../file-picker", () => ({
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

beforeEach(async () => {
  host = document.createElement("div");
  document.body.append(host);
  root = await renderComponent(null, { container: document.body.appendChild(host) });
});
afterEach(async () => {
  await cleanup();
  host.remove();
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

it("shows one shared refusal while retaining both disabled external maintenance controls", async () => {
  const status = {
    ...portStatus(),
    external_runtime: { ...record, user_selected: { arguments: [] } },
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
    .getByRole("textbox", { name: "Working directory", exact: true })
    .fill("C:/Player/Retained directory");
  await page.getByRole("tab", { name: "Versions", exact: true }).click();
  await page.getByRole("tab", { name: "Files", exact: true }).click();
  await expect
    .element(page.getByRole("textbox", { name: "Working directory", exact: true }))
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
    .element(page.getByRole("textbox", { name: "Working directory" }))
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
  { label: "ordinary arguments", arguments: ["--fullscreen"] },
  { label: "empty and multiline arguments", arguments: ["--profile", "", "first\nsecond"] },
])(
  "edits selected paths while preserving $label through relink",
  async ({ arguments: savedArguments }) => {
    const selected = { ...record, user_selected: { arguments: savedArguments } };
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
      previous_path: record.path,
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
    await click("Edit launch details…");
    await click("Choose game executable…");
    const keepsExactArguments = savedArguments.some(
      (argument) => argument === "" || /[\r\n]/.test(argument),
    );
    await page.getByText("Advanced launch options", { exact: true }).click();
    expect(document.body.textContent?.includes("They will be kept exactly")).toBe(
      keepsExactArguments,
    );
    expect(document.querySelector('textarea[aria-label="Launch arguments"]') === null).toBe(
      keepsExactArguments,
    );
    await click("Review launch details");
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
  const executable = "C:\\Player\\Own game\\launcher.exe";
  const directory = "C:\\Player\\Own game";
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
  await page.getByRole("textbox", { name: "Launch arguments" }).fill("--data\nC:\\Original files");
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
  expect(document.body.textContent).toContain("You or upstream own setup and updates");
  expect(document.body.textContent).not.toContain("Checked files");
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
  const guided = {
    ...port,
    presentation: {
      ...port.presentation,
      manual_preparation: "Exact compatibility, ownership and developer-option notes.",
      manual_setup: {
        steps: [
          { title: "Prepare a working copy", instruction: "Keep your original unchanged." },
          { title: "Review the folder", instruction: "Choose the prepared folder below." },
        ],
        warnings: ["Preserve the existing pilot; do not overwrite it."],
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
  expect(help.textContent).toBe("Detailed preparation guide");
  await act(async () => help.click());
  expect(open).toHaveBeenCalledExactlyOnceWith("https://example.com/guide");
  expect(register).not.toHaveBeenCalled();
  expect(pickInstallFolder).not.toHaveBeenCalled();
});

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
  await click("Use this installation");
  expect(register).toHaveBeenCalledExactlyOnceWith(port.id, record.path, "reviewed-external", 7);
  expect(changed).toHaveBeenCalledOnce();
});

it("removes only the external registration through the separate reviewed action", async () => {
  vi.spyOn(desktopApi, "previewExternalRemoval").mockResolvedValue({
    port_id: port.id,
    path: record.path,
    version: record.version,
    external_files_will_be_preserved: true,
    preview_sha256: "reviewed-removal",
  });
  const remove = vi.spyOn(desktopApi, "removeExternalRuntime").mockResolvedValue(record);
  const managedUninstall = vi.spyOn(desktopApi, "remove");
  const changed = vi.fn();
  await root.rerender(
    <ExternalRuntimeControl
      port={port}
      status={{ ...portStatus(), external_runtime: record }}
      generation={7}
      busy={false}
      onChanged={changed}
    />,
  );
  await click("Stop using this installation");
  expect(document.body.textContent).toContain("The files stay where they are, including");
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
    "Setup status unknown. View details for current requirements.",
  );
  expect(document.body.textContent).not.toContain("future_reason");
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
    "Setup status unknown. View details for current requirements.",
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
  expect(document.body.textContent).toContain("Current removal availability is unavailable");
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

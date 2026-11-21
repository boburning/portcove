import { captureParityState } from "../../test/parity-capture";
import { cleanup, render, type RenderResult } from "vitest-browser-react";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { desktopApi } from "../api";
import { currentCatalogPort } from "../catalog-test-fixtures";
import { canOpenInstalledResult } from "../features/operations/invocation-state";
import { InvocationOwnerProvider } from "../features/operations/invocation-owner";
import {
  OperationPresentationProvider,
  presentPortAction,
  useOperationPresentation,
} from "../features/operations/operation-presentation";
import { useOperationState } from "../features/operations/use-operation-state";
import { failureReport, portDefinition, portStatus } from "../test-fixtures";
import type { InstallRecord, ManagedRouteChangePreview, PortStatus } from "../types";
import { gameIdentityLabel } from "../port-identity";
import { ManagedRouteChangeControl } from "./ManagedRouteChange";
import { ExternalRuntimeControl } from "./ExternalRuntime";
import { StatusLayer } from "./Chrome";

const port = { ...portDefinition(), adapter: "native-portable" as const };
const installation: InstallRecord = {
  id: "managed-1",
  port_id: port.id,
  version: "v2",
  path: "E:/Portcove/versions/sample/accepted",
  channel: "stable",
  installed_at: 2,
  verified: true,
  staged: false,
  artifact: { asset_name: "sample.zip", sha256: "a".repeat(64), size: 1024 },
  manifest_sha256: "b".repeat(64),
  runtime: null,
  selected_executable: "game.exe",
};
const preview: ManagedRouteChangePreview = {
  port_id: port.id,
  current_registration: {
    id: "external-1",
    port_id: port.id,
    version: "user-managed",
    platform: "windows-x86-64",
    path: "C:/Player/Sample",
    executable: "C:/Player/Sample/game.exe",
    registered_at: 1,
    archive_sha256: "",
    immutable_tree_sha256: "",
    user_selected: { arguments: [] },
  },
  installation: {
    port_id: port.id,
    channel: "stable",
    platform: "windows-x86-64",
    action: "download",
    bundled_runtime: null,
    download_bytes: 1024,
    source_requirements: [],
    release: {
      version: "v2",
      channel: "stable",
      published_at: null,
      asset: {
        name: "sample.zip",
        url: "https://example.com/sample.zip",
        size: 1024,
        sha256: "a".repeat(64),
      },
    },
    storage: {
      library_root: "E:/Portcove",
      volume_available_bytes: 1024 ** 4,
      volume_total_bytes: 1024 ** 4,
    },
    output_location: {
      port_id: port.id,
      library_root: "E:/Portcove",
      configured_output_directory: null,
      default_output_directory: "E:/Portcove/versions/sample",
      effective_output_directory: "E:/Portcove/versions/sample",
      user_data_root: "E:/Portcove/user/sample",
      selection_source: "library_default",
    },
  },
  update_policy: "notify",
  permitted: true,
  reason: null,
  external_files_will_be_preserved: true,
  external_data_will_be_copied: false,
  preview_sha256: "reviewed-route",
};
let root: RenderResult;
beforeEach(async () => {
  await page.viewport(360, 800);
  vi.spyOn(desktopApi, "previewManagedRouteChange").mockResolvedValue(preview);
  root = await render(<ManagedRouteChangeControl port={port} generation={7} busy={false} />);
});
afterEach(async () => {
  await cleanup();
  await page.viewport(1280, 800);
  vi.restoreAllMocks();
});

it("reviews a separate managed copy before consent and leaves Play explicit", async () => {
  const apply = vi.spyOn(desktopApi, "changeToManagedRuntime").mockResolvedValue({
    installation,
    previous_registration: preview.current_registration,
    external_files_preserved: true,
  });
  const remove = vi.spyOn(desktopApi, "removeExternalRuntime");
  const launch = vi.spyOn(desktopApi, "launch");
  const changed = vi.fn();
  await root.rerender(
    <ManagedRouteChangeControl port={port} generation={7} busy={false} onChanged={changed} />,
  );
  await page.getByRole("button", { name: "Review a Portcove-managed copy…" }).click();
  await expect.element(page.getByRole("button", { name: "Create managed copy" })).toBeEnabled();
  expect(apply).not.toHaveBeenCalled();
  await expect
    .element(page.getByText("E:/Portcove/versions/sample", { exact: true }))
    .toBeVisible();
  expect(document.body.textContent?.replace(/\s+/gu, " ")).toContain(
    "external saves are not copied",
  );
  const dialog = document.querySelector('[role="dialog"]')?.getBoundingClientRect();
  expect(dialog).toBeDefined();
  expect(dialog!.left).toBeGreaterThanOrEqual(0);
  expect(dialog!.right).toBeLessThanOrEqual(360);
  await captureParityState("managed-route-change-reviewed-fixture");
  await page.getByRole("button", { name: "Create managed copy" }).click();
  expect(apply).toHaveBeenCalledExactlyOnceWith(port.id, "reviewed-route", 7);
  expect(changed).toHaveBeenCalledOnce();
  expect(remove).not.toHaveBeenCalled();
  expect(launch).not.toHaveBeenCalled();
});

const externalStatus = { ...portStatus(), external_runtime: preview.current_registration };
const startedWorkspaceReadRevision = () => 1;

function Workspace({
  status,
  revision,
  refresh,
  open,
}: {
  status: PortStatus;
  revision: number;
  refresh: () => Promise<unknown>;
  open: () => void;
}) {
  const operations = useOperationState({
    refresh,
    libraryGeneration: 7,
    workspaceReadRevision: revision,
    workspaceStatuses: [status],
    startedWorkspaceReadRevision,
  });
  return (
    <OperationPresentationProvider
      generation={7}
      pending={operations.pendingOperations}
      unreadInstallPorts={operations.unreadInstallPorts}
      unreadManagedRoutePorts={operations.unreadManagedRoutePorts}
      perform={operations.perform}
    >
      <ExternalRuntimeControl
        port={port}
        status={status}
        generation={7}
        busy={false}
        onChanged={refresh}
      />
      <LaunchReadback status={status} />
      <StatusLayer
        invocations={operations.invocations}
        clearError={() => operations.setError(undefined)}
        reviewCurrentState={refresh}
        openInstalledGame={(result) =>
          canOpenInstalledResult(result, status, 7, undefined, operations.unreadInstallPorts)
            ? open
            : undefined
        }
      />
    </OperationPresentationProvider>
  );
}

function LaunchReadback({ status }: { status: PortStatus }) {
  const launch = presentPortAction(useOperationPresentation(), port.id, status, "launch");
  return <button disabled={Boolean(launch.busy)}>Play current installation</button>;
}

it("retains the managed copy through failed readback and opens only the exact current copy", async () => {
  const apply = vi.spyOn(desktopApi, "changeToManagedRuntime").mockResolvedValue({
    installation,
    previous_registration: preview.current_registration,
    external_files_preserved: true,
  });
  const refresh = vi.fn().mockRejectedValueOnce(new Error("Library read interrupted"));
  const open = vi.fn();
  const workspace = (status: PortStatus, revision: number) => (
    <InvocationOwnerProvider>
      <Workspace status={status} revision={revision} refresh={refresh} open={open} />
    </InvocationOwnerProvider>
  );

  await root.rerender(workspace(externalStatus, 1));
  await page.getByRole("button", { name: "Review a Portcove-managed copy…" }).click();
  await page.getByRole("button", { name: "Create managed copy" }).click();
  const result = page.getByText("Created a managed copy of " + gameIdentityLabel(port) + " · v2");
  await expect.element(result).toBeVisible();
  await expect.element(page.getByText(/finished, but Portcove couldn’t refresh/)).toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Play current installation" }))
    .toBeDisabled();
  await expect
    .element(page.getByRole("button", { name: "Review a Portcove-managed copy…" }))
    .not.toBeInTheDocument();
  await expect.element(page.getByRole("button", { name: "Open game" })).not.toBeInTheDocument();
  await page.getByRole("button", { name: "Refresh library" }).click();
  expect(refresh).toHaveBeenCalledTimes(2);

  await root.rerender(
    workspace({ ...portStatus(), active: { ...installation, id: "other-copy" } }, 2),
  );
  await expect.element(result).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Open game" })).not.toBeInTheDocument();
  await root.rerender(workspace({ ...portStatus(), active: installation }, 3));
  await page.getByRole("button", { name: "Open game" }).click();
  expect(open).toHaveBeenCalledOnce();
  expect(apply).toHaveBeenCalledExactlyOnceWith(port.id, preview.preview_sha256, 7);
});

it("holds the old launch route when Core reports a committed copy without a receipt", async () => {
  const error = failureReport();
  error.presentation.mutation_state = "committed";
  const apply = vi.spyOn(desktopApi, "changeToManagedRuntime").mockRejectedValue(error);
  const refresh = vi.fn().mockResolvedValue(undefined);
  await root.rerender(
    <InvocationOwnerProvider>
      <Workspace status={externalStatus} revision={1} refresh={refresh} open={vi.fn()} />
    </InvocationOwnerProvider>,
  );
  await page.getByRole("button", { name: "Review a Portcove-managed copy…" }).click();
  await page.getByRole("button", { name: "Create managed copy" }).click();
  await expect
    .element(page.getByText("Your change was saved. Check the result before trying again."))
    .toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Play current installation" }))
    .toBeDisabled();
  await expect.element(page.getByRole("button", { name: "Open game" })).not.toBeInTheDocument();
  await page.getByRole("button", { name: "Refresh library" }).click();
  expect(refresh).toHaveBeenCalledOnce();
  expect(apply).toHaveBeenCalledOnce();
});

it("requires readback after a lost reply without fabricating an installation receipt", async () => {
  const apply = vi
    .spyOn(desktopApi, "changeToManagedRuntime")
    .mockRejectedValue(new Error("Native reply interrupted"));
  const refresh = vi.fn().mockResolvedValue(undefined);
  const open = vi.fn();
  const workspace = (revision: number, status: PortStatus = externalStatus) => (
    <InvocationOwnerProvider>
      <Workspace status={status} revision={revision} refresh={refresh} open={open} />
    </InvocationOwnerProvider>
  );

  await root.rerender(workspace(1));
  await page.getByRole("button", { name: "Review a Portcove-managed copy…" }).click();
  await page.getByRole("button", { name: "Create managed copy" }).click();
  await expect
    .element(page.getByRole("button", { name: "Play current installation" }))
    .toBeDisabled();
  await expect
    .element(page.getByRole("button", { name: "Review a Portcove-managed copy…" }))
    .not.toBeInTheDocument();
  await expect.element(page.getByText(/Created a managed copy/)).not.toBeInTheDocument();
  await expect.element(page.getByText(/restart Portcove before using it/)).toBeVisible();
  await page.getByRole("button", { name: "Refresh library" }).click();
  await root.rerender(workspace(2));
  await expect
    .element(page.getByRole("button", { name: "Review a Portcove-managed copy…" }))
    .not.toBeInTheDocument();
  await expect
    .element(page.getByRole("button", { name: "Play current installation" }))
    .toBeDisabled();
  await root.rerender(workspace(3, { ...portStatus(), active: installation }));
  await expect
    .element(page.getByRole("button", { name: "Play current installation" }))
    .toBeEnabled();
  await expect.element(page.getByRole("button", { name: "Open game" })).not.toBeInTheDocument();
  expect(refresh).toHaveBeenCalledOnce();
  expect(apply).toHaveBeenCalledOnce();
});

it.each(["windows-x86-64", "linux-x86-64"] as const)(
  "shows vkQuake managed setup guidance for %s in the copy review",
  async (platform) => {
    const quake = currentCatalogPort("quake-vkquake");
    vi.mocked(desktopApi.previewManagedRouteChange).mockResolvedValue({
      ...preview,
      port_id: quake.id,
      current_registration: {
        ...preview.current_registration,
        port_id: quake.id,
      },
      installation: {
        ...preview.installation,
        port_id: quake.id,
        platform,
        output_location: { ...preview.installation.output_location, port_id: quake.id },
      },
    });
    await root.rerender(<ManagedRouteChangeControl port={quake} generation={7} busy={false} />);
    await page.getByRole("button", { name: "Review a Portcove-managed copy…" }).click();
    await expect
      .element(page.getByText(/After installation, copy the id1 folder with pak0.pak and pak1.pak/))
      .toBeVisible();
    expect(document.body.textContent).toContain("Use a Vulkan-capable GPU and driver.");
    const linuxWarning = "the publisher requires glibc 2.35 or later and FUSE";
    expect(document.body.textContent?.includes(linuxWarning)).toBe(platform === "linux-x86-64");
  },
);

it("shows the Core hold while keeping the current copy intact", async () => {
  vi.mocked(desktopApi.previewManagedRouteChange).mockResolvedValue({
    ...preview,
    permitted: false,
    reason: "Portcove already has saved data for this game. Preserve it before changing routes.",
  });
  const apply = vi.spyOn(desktopApi, "changeToManagedRuntime");
  await page.getByRole("button", { name: "Review a Portcove-managed copy…" }).click();
  await expect
    .element(
      page.getByText(
        "Portcove already has saved data for this game. Preserve it before changing routes.",
        { exact: true },
      ),
    )
    .toBeVisible();
  await expect.element(page.getByRole("button", { name: "Create managed copy" })).toBeDisabled();
  expect(apply).not.toHaveBeenCalled();
  await captureParityState("managed-route-change-refused-fixture");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect
    .element(page.getByRole("button", { name: "Review a Portcove-managed copy…" }))
    .toBeVisible();
});

it("retains a committed failure until the player refreshes the authoritative installation", async () => {
  const error = failureReport();
  error.presentation.mutation_state = "committed";
  error.presentation.summary =
    "The managed copy v2 is active. Restart Portcove to finish recovery; external files were preserved.";
  vi.spyOn(desktopApi, "changeToManagedRuntime").mockRejectedValue(error);
  const changed = vi.fn();
  await root.rerender(
    <ManagedRouteChangeControl port={port} generation={7} busy={false} onChanged={changed} />,
  );
  await page.getByRole("button", { name: "Review a Portcove-managed copy…" }).click();
  await expect.element(page.getByRole("button", { name: "Create managed copy" })).toBeEnabled();
  await page.getByRole("button", { name: "Create managed copy" }).click();
  await expect.element(page.getByRole("alert")).toBeVisible();
  expect(changed).not.toHaveBeenCalled();
  await expect
    .element(page.getByRole("button", { name: "Refresh current installation" }))
    .toBeVisible();
  expect(document.body.textContent).not.toContain("Create managed copy");
  await captureParityState("managed-route-change-committed-failure-fixture");
  await page.getByRole("button", { name: "Refresh current installation" }).click();
  expect(changed).toHaveBeenCalledOnce();
});

it.each([
  { external_files_will_be_preserved: false, external_data_will_be_copied: false },
  { external_files_will_be_preserved: true, external_data_will_be_copied: true },
])("refuses changed preservation guarantees: %j", async (guarantees) => {
  vi.mocked(desktopApi.previewManagedRouteChange).mockResolvedValue({ ...preview, ...guarantees });
  const apply = vi.spyOn(desktopApi, "changeToManagedRuntime");
  await page.getByRole("button", { name: "Review a Portcove-managed copy…" }).click();
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent(
      "This proposed change has different file or data handling. Keep your current copy and update Portcove before reviewing it again.",
    );
  await expect.element(page.getByRole("button", { name: "Create managed copy" })).toBeDisabled();
  expect(document.body.textContent).not.toContain("external saves are not copied");
  expect(apply).not.toHaveBeenCalled();
});

it("keeps legacy save warnings visible without an unscoped setup instruction", async () => {
  const warned = {
    ...port,
    presentation: {
      ...port.presentation!,
      manual_setup: {
        steps: [{ title: "Set up macOS", instruction: "Open the macOS disk image." }],
        warnings: ["Back up shared saves before switching installations."],
        references: [
          { title: "Inspected version", instruction: "The old version used profile/save.bin." },
        ],
      },
    },
  };
  await root.rerender(<ManagedRouteChangeControl port={warned} generation={7} busy={false} />);
  await page.getByRole("button", { name: "Review a Portcove-managed copy…" }).click();
  const warning = page.getByText("Back up shared saves before switching installations.", {
    exact: true,
  });
  await expect.element(warning).toBeVisible();
  expect(warning.element().closest("details")).toBeNull();
  expect(page.getByRole("dialog").element().textContent).not.toContain(
    "Open the macOS disk image.",
  );
  const confirm = page.getByRole("button", { name: "Create managed copy", exact: true });
  expect(
    Boolean(
      warning.element().compareDocumentPosition(confirm.element()) &
      Node.DOCUMENT_POSITION_FOLLOWING,
    ),
  ).toBe(true);
});

it("reviews the managed copy in the current language with exact paths", async () => {
  const { initializeLocalization } = await import("../localization");
  const localization = initializeLocalization(["en-US"]);
  try {
    await localization.changeLanguage("ar-XB");
    vi.mocked(desktopApi.previewManagedRouteChange).mockResolvedValue({
      ...preview,
      current_registration: { ...preview.current_registration, path: "C:/{{path}}/Sample" },
    });
    await root.rerender(<ManagedRouteChangeControl port={port} generation={7} busy={false} />);
    await page.getByRole("button", { name: "مراجعة نسخة يديرها Portcove…" }).click();
    await expect.element(page.getByRole("dialog")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "إنشاء نسخة مُدارة" })).toBeVisible();
    expect(document.body.textContent).toContain("مجلد التثبيت الجديد: E:/Portcove/versions/sample");
    expect(document.querySelector("[role=dialog] bdi")?.textContent).toBe(gameIdentityLabel(port));
    const codes = [...document.querySelectorAll("[role=dialog] code")].map((n) => n.textContent);
    expect(codes).toContain("C:/{{path}}/Sample");
    expect(document.body.textContent).not.toContain("Create managed copy");
  } finally {
    await localization.changeLanguage("en");
  }
});

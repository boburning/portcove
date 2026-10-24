import { controlledAct as act } from "../../test/controlled-react-act";
import { render as renderComponent, cleanup, type RenderResult } from "vitest-browser-react";
import { useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { desktopApi } from "../api";
import type { ActivityRecord, InstallPlan } from "../types";
import { StatusLayer } from "./Chrome";
import { DetailPanel, InstallAction } from "./DetailPanel";
import { currentCatalogPort } from "../catalog-test-fixtures";
import { portStatus } from "../test-fixtures";
import { actions } from "./rendered-test-fixtures";

const plan: InstallPlan = {
  bundled_runtime: null,
  port_id: "sample",
  channel: "stable",
  platform: "windows-x86-64",
  action: "download",
  source_requirements: [],
  download_bytes: 64 * 1024 ** 2,
  release: {
    published_at: null,
    version: "2.0",
    channel: "stable",
    asset: {
      name: "sample.zip",
      url: "https://example.com/sample.zip",
      size: 64 * 1024 ** 2,
      sha256: "a".repeat(64),
    },
  },
  storage: {
    library_root: "E:/Portcove",
    volume_total_bytes: 1024 ** 4,
    volume_available_bytes: 512 * 1024 ** 3,
  },
  output_location: {
    configured_output_directory: null,
    port_id: "sample",
    library_root: "E:/Portcove",
    default_output_directory: "E:/Portcove/versions/sample",
    effective_output_directory: "E:/Portcove/versions/sample",
    selection_source: "library_default",
    user_data_root: "E:/Portcove/user/sample",
  },
};

function reviewedPlan(action: InstallPlan["action"]): InstallPlan {
  return {
    ...plan,
    action,
    bundled_runtime:
      action === "use_staged"
        ? {
            archive_root: "runtime",
            asset: {
              name: "runtime.zip",
              url: "https://example.com/runtime.zip",
              size: 1024,
              sha256: "d".repeat(64),
            },
            executable: "runtime.exe",
            target_directory: "runtime",
          }
        : null,
  };
}

let root: RenderResult;
let container: HTMLDivElement;

beforeEach(async () => {
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  container = document.createElement("div");
  document.body.append(container);
  root = await renderComponent(null, { container: document.body.appendChild(container) });
});

afterEach(async () => {
  await cleanup();
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function button(label: string) {
  const match = [...document.body.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.includes(label),
  );
  if (!(match instanceof HTMLButtonElement)) throw new Error(`missing button: ${label}`);
  return match;
}

async function click(label: string) {
  await act(async () => button(label).click());
}

it("keeps full distinguishing identity in the installation dialog without changing the reviewed target", async () => {
  const install = vi.fn();
  const identity = "Harbor Adventure — Édition <A&B> · Modern port · Renderer 2";
  await root.rerender(
    <InstallAction
      gameName={identity}
      ready
      sourceReady
      biosReady
      plan={plan}
      install={install}
      review={vi.fn()}
      dismiss={vi.fn()}
    />,
  );
  const dialog = document.querySelector('[role="dialog"]')!;
  const description = document.getElementById(dialog.getAttribute("aria-describedby")!)!;
  expect(description.textContent).toContain(identity);
  expect(dialog.querySelector("strong")?.textContent).toBe(identity);
  await click("Install · 64.0 MiB");
  expect(install).toHaveBeenCalledOnce();
  expect(plan.port_id).toBe("sample");
});

it.each([
  [240, "dark"],
  [240, "light"],
  [320, "dark"],
  [320, "light"],
  [960, "dark"],
] as const)("keeps long installation consequences readable at %spx in %s", async (width, theme) => {
  const original = { width: innerWidth, height: innerHeight };
  const originalTheme = document.documentElement.dataset.theme;
  const location =
    "E:\\Codex-Worktrees\\native-scenario-contracts-2222\\Portcove-Development\\outputs\\desktop-verify\\2026-10-20T20-00-53-492Z-XPWaWD\\native\\library\\versions\\portcove-install-fixture\\未知のゲーム";
  try {
    await page.viewport(width, 160);
    await expect.poll(() => innerWidth).toBe(width);
    document.documentElement.dataset.theme = theme;
    await root.rerender(
      <InstallAction
        ready
        sourceReady
        biosReady
        setupNote="Before first Play, add your own supported original-game-revision-with-a-long-distinguishing-filename.z64 beside the player. The game verifies it before starting."
        externalData
        plan={{
          ...plan,
          temporary_space: {
            path: location,
            required_bytes: plan.download_bytes,
            available_bytes: plan.storage.volume_available_bytes,
            volume_identity: "fixture-volume",
            sufficient: true,
          },
          output_location: {
            ...plan.output_location,
            default_output_directory: location,
            effective_output_directory: location,
          },
        }}
        install={vi.fn()}
        review={vi.fn()}
        dismiss={vi.fn()}
      />,
    );
    const dialog = document.querySelector<HTMLElement>('[aria-labelledby="install-review-title"]')!;
    const overflow = [...dialog.querySelectorAll<HTMLElement>("*")]
      .filter((item) => item.scrollWidth > item.clientWidth + 1)
      .map((item) => ({
        tag: item.tagName,
        class: item.className,
        client: item.clientWidth,
        scroll: item.scrollWidth,
      }));
    expect(dialog.scrollWidth, JSON.stringify(overflow)).toBeLessThanOrEqual(
      dialog.clientWidth + 1,
    );
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(innerWidth + 1);
    expect(dialog.textContent).toContain(location);
    const action = button("Install ·");
    action.scrollIntoView({ block: "center" });
    const bounds = action.getBoundingClientRect();
    expect(bounds.left).toBeGreaterThanOrEqual(0);
    expect(bounds.right).toBeLessThanOrEqual(innerWidth);
    expect(bounds.top).toBeGreaterThanOrEqual(0);
    expect(bounds.bottom).toBeLessThanOrEqual(innerHeight);
  } finally {
    await cleanup();
    if (originalTheme === undefined) delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = originalTheme;
    await page.viewport(original.width, original.height);
  }
});

it("shows preservation limits before installing the reviewed release", async () => {
  const install = vi.fn();
  const notice = "Sign-in stays with each installed version and is excluded from backups.";
  function PreservationReviewHarness() {
    const [reviewed, setReviewed] = useState<InstallPlan>();
    return (
      <InstallAction
        ready
        sourceReady
        biosReady
        plan={reviewed}
        install={install}
        review={() => setReviewed({ ...plan, preservation_notices: [notice] })}
        dismiss={() => setReviewed(undefined)}
      />
    );
  }
  await root.rerender(<PreservationReviewHarness />);
  await click("Review installation");
  expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain(notice);
  expect(install).not.toHaveBeenCalled();
  expect(button("Install ·").disabled).toBe(false);
});

it("shows upstream first-run requirements and external backup limits before installation", async () => {
  const install = vi.fn();
  const setup =
    "On first Play, choose your own supported original game in the game’s setup window.";
  await root.rerender(
    <InstallAction
      ready
      sourceReady
      biosReady
      plan={plan}
      setupNote={setup}
      externalData
      install={install}
      review={vi.fn()}
      dismiss={vi.fn()}
    />,
  );
  const dialog = page.getByRole("dialog");
  await expect.element(dialog.getByRole("region", { name: "Game setup" })).toBeVisible();
  await expect.element(dialog.getByText(setup, { exact: true })).toBeVisible();
  expect(dialog.element().textContent).toContain("outside Portcove backups");
  expect(install).not.toHaveBeenCalled();
  await click("Install · 64.0 MiB");
  expect(install).toHaveBeenCalledOnce();
});

it("discloses external saves and managed local settings for the staged MC2 route", async () => {
  const port = currentCatalogPort("alariq-mc2");
  const install = vi.fn();
  await root.rerender(
    <DetailPanel
      port={port}
      sourcePath=""
      setSourcePath={vi.fn()}
      status={{ ...portStatus(), port_id: port.id, active: null }}
      installPlan={{ ...plan, port_id: port.id }}
      actions={{ ...actions, install }}
    />,
  );
  const dialog = page.getByRole("dialog");
  await expect.element(dialog.getByRole("region", { name: "Game setup" })).toBeVisible();
  expect(dialog.element().textContent).toContain("outside Portcove backups");
  expect(dialog.element().textContent).toContain("official Windows x64 ZIP");
  expect(document.body.textContent).toContain("options.cfg");
  expect(document.body.textContent).toContain(".mechcommander2/savegame");
  expect(document.body.textContent).toContain("declared local data may still be covered");
  expect(document.body.textContent).not.toContain("Managed by Portcove for backup and restore");
  expect(install).not.toHaveBeenCalled();
});

it("keeps external-save disclosure visible without a catalog setup note", async () => {
  await root.rerender(
    <InstallAction
      ready
      sourceReady
      biosReady
      plan={plan}
      externalData
      install={vi.fn()}
      review={vi.fn()}
      dismiss={vi.fn()}
    />,
  );
  const dialog = page.getByRole("dialog");
  expect(dialog.element().textContent).toContain("outside Portcove backups");
});

async function pressEscape() {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
}

it("separates account-wide preferences from managed local fallback before installation", async () => {
  const install = vi.fn();
  function ScopeReviewHarness() {
    const [reviewed, setReviewed] = useState<InstallPlan>();
    return (
      <InstallAction
        ready
        sourceReady
        biosReady
        plan={reviewed}
        install={install}
        review={() =>
          setReviewed({
            ...plan,
            shared_preferences: {
              binding: {
                contract: "regaiden041-windows",
                account_sid_sha256: "a".repeat(64),
                path: "C:/Users/player/AppData/Roaming/gbrecompiled/runtime/runtime_prefs.ini",
              },
              local_fallback_path: "E:/Portcove/versions/regaiden/artifact/runtime_prefs.ini",
              shared_present: false,
              local_fallback_present: false,
            },
          })
        }
        dismiss={() => setReviewed(undefined)}
      />
    );
  }
  await root.rerender(<ScopeReviewHarness />);
  await click("Review installation");
  const text = document.body.querySelector('[role="dialog"]')?.textContent;
  expect(text).toContain("C:/Users/player/AppData/Roaming/gbrecompiled/runtime/runtime_prefs.ini");
  expect(text).toContain("E:/Portcove/versions/regaiden/artifact/runtime_prefs.ini");
  expect(text).toContain("does not own or back up that shared file");
  expect(text).toContain("Windows confirmation");
  expect(install).not.toHaveBeenCalled();
  await click("Cancel review");
  expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  expect(install).not.toHaveBeenCalled();
});

it("opens the missing game picker, then the BIOS picker, and restores focus after each choice", async () => {
  let finishPicker: (() => void) | undefined;
  const pickSource = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finishPicker = resolve;
      }),
  );
  const pickBios = vi.fn(() => Promise.resolve());
  function MissingFilesHarness() {
    const [sourceReady, setSourceReady] = useState(false);
    const [biosReady, setBiosReady] = useState(false);
    return (
      <InstallAction
        ready={sourceReady && biosReady}
        sourceReady={sourceReady}
        biosReady={biosReady}
        pickSource={async () => {
          await pickSource();
          setSourceReady(true);
        }}
        pickBios={async () => {
          await pickBios();
          setBiosReady(true);
        }}
        install={vi.fn()}
        review={vi.fn()}
        dismiss={vi.fn()}
      />
    );
  }
  await root.rerender(<MissingFilesHarness />);
  expect(button("Choose game files and BIOS").disabled).toBe(false);
  await click("Choose game files and BIOS");
  expect(pickSource).toHaveBeenCalledTimes(1);
  expect(button("Choose game files and BIOS").disabled).toBe(true);
  await act(async () => finishPicker?.());
  expect(button("Choose BIOS file").disabled).toBe(false);
  expect(document.activeElement).toBe(button("Choose BIOS file"));
  await click("Choose BIOS file");
  expect(pickBios).toHaveBeenCalledTimes(1);
  expect(document.activeElement).toBe(button("Review installation"));
});

it("returns focus after a canceled picker and focuses the matching field without a picker", async () => {
  const pickSource = vi.fn(() => Promise.resolve());
  await root.rerender(
    <InstallAction
      ready={false}
      sourceReady={false}
      biosReady
      pickSource={pickSource}
      install={vi.fn()}
      review={vi.fn()}
      dismiss={vi.fn()}
    />,
  );
  await click("Choose game files");
  expect(document.activeElement).toBe(button("Choose game files"));
  expect(pickSource).toHaveBeenCalledTimes(1);

  const field = document.createElement("input");
  field.id = "source-bios";
  container.append(field);
  await root.rerender(
    <InstallAction
      ready={false}
      sourceReady
      biosReady={false}
      biosInputId="source-bios"
      install={vi.fn()}
      review={vi.fn()}
      dismiss={vi.fn()}
    />,
  );
  expect(button("Choose BIOS file").disabled).toBe(false);
  await click("Choose BIOS file");
  expect(document.activeElement).toBe(field);
});

function ReviewHarness({ install = () => undefined }: { install?: () => void }) {
  const [reviewed, setReviewed] = useState<InstallPlan>();
  return (
    <InstallAction
      ready
      sourceReady
      biosReady
      plan={reviewed}
      install={install}
      review={() => setReviewed(plan)}
      dismiss={() => setReviewed(undefined)}
    />
  );
}

it("presents the reviewed installation in a dismissible dialog and restores trigger focus", async () => {
  const install = vi.fn();
  await root.rerender(<ReviewHarness install={install} />);
  await click("Review installation");
  expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
  expect(document.body.textContent).toContain("2.0");
  expect(document.body.textContent).toContain("64.0 MiB");
  expect(document.body.textContent).toContain(
    "Review the version, download size, and install folder.",
  );
  expect(document.body.textContent).toContain("Install folder");
  expect(document.body.textContent).toContain("E:/Portcove/versions/sample");
  expect(document.activeElement).toBe(document.querySelector("#install-review-title"));
  await pressEscape();
  expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement?.textContent).toContain("Review installation");

  await click("Review installation");
  await click("Install · 64.0 MiB");
  expect(install).toHaveBeenCalledTimes(1);
});

it.each(["library_default", "port_setting"] as const)(
  "routes a low-library-space review to Library and storage for the default path saved as %s",
  async (selectionSource) => {
    const openLibraryStorage = vi.fn();
    const shortPlan = {
      ...plan,
      storage: { ...plan.storage, volume_available_bytes: 32 * 1024 ** 2 },
      temporary_space: {
        path: plan.output_location.effective_output_directory,
        required_bytes: plan.download_bytes,
        available_bytes: 32 * 1024 ** 2,
        volume_identity: "library-drive",
        sufficient: false,
      },
      output_location: { ...plan.output_location, selection_source: selectionSource },
    };
    function InsufficientSpaceHarness() {
      const [reviewed, setReviewed] = useState<InstallPlan>();
      return (
        <InstallAction
          ready
          sourceReady
          biosReady
          plan={reviewed}
          install={vi.fn()}
          review={() => setReviewed(shortPlan)}
          dismiss={() => setReviewed(undefined)}
          openLibraryStorage={openLibraryStorage}
        />
      );
    }
    await root.rerender(<InsufficientSpaceHarness />);
    await click("Review installation");
    expect(button("Free space required").disabled).toBe(true);
    expect(document.body.textContent).toContain("32.0 MiB available in library");
    expect(document.body.textContent).toContain("more free space in the Portcove library");
    expect(button("Open Library and storage").disabled).toBe(false);
    await click("Open Library and storage");
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(openLibraryStorage).toHaveBeenCalledTimes(1);
    await click("Review installation");
    await pressEscape();
    expect(document.activeElement).toBe(button("Review installation"));
    expect(openLibraryStorage).toHaveBeenCalledTimes(1);
  },
);

it("reviews the complete cold download and blocks on Core's larger temporary-space requirement", async () => {
  const install = vi.fn();
  const recipePlan: InstallPlan = {
    ...plan,
    download_bytes: 230_411_690,
    auxiliary_downloads: [{ ...plan.release.asset, name: "build-input.zip", size: 226_492_668 }],
    temporary_space: {
      path: "F:/Games/sample",
      required_bytes: 2_151_402_670,
      available_bytes: 1024 ** 3,
      volume_identity: "external-drive",
      sufficient: false,
    },
    output_location: {
      ...plan.output_location,
      effective_output_directory: "F:/Games/sample",
      selection_source: "request_override",
    },
  };
  await root.rerender(
    <InstallAction
      ready
      sourceReady
      biosReady
      plan={recipePlan}
      install={install}
      review={vi.fn()}
      dismiss={vi.fn()}
    />,
  );
  expect(document.body.textContent).toContain("220 MiB");
  expect(document.body.textContent).toContain("2.0 GiB");
  expect(document.body.textContent).toContain("F:/Games/sample");
  expect(document.body.textContent).toContain("Final installed size is unknown");
  expect(button("Free space required").disabled).toBe(true);
  expect(install).not.toHaveBeenCalled();
  await root.rerender(
    <InstallAction
      ready
      sourceReady
      biosReady
      plan={{
        ...recipePlan,
        temporary_space: {
          ...recipePlan.temporary_space!,
          sufficient: null,
          available_bytes: null,
        },
      }}
      install={install}
      review={vi.fn()}
      dismiss={vi.fn()}
    />,
  );
  expect(document.body.textContent).toContain("Capacity is unknown");
  expect(button("Install · 220 MiB").disabled).toBe(false);
  await root.rerender(
    <InstallAction
      ready
      sourceReady
      biosReady
      plan={{
        ...recipePlan,
        output_location: plan.output_location,
        temporary_space: {
          ...recipePlan.temporary_space!,
          path: plan.output_location.effective_output_directory,
          sufficient: null,
          available_bytes: null,
        },
      }}
      install={install}
      review={vi.fn()}
      dismiss={vi.fn()}
    />,
  );
  expect(document.body.textContent).toContain("Destination capacity is unknown");
  expect(document.body.textContent).not.toContain("available in library");
});

it("does not block an external-output install using the library volume's free space", async () => {
  const externalPlan: InstallPlan = {
    ...plan,
    storage: { ...plan.storage, volume_available_bytes: 32 * 1024 ** 2 },
    output_location: {
      ...plan.output_location,
      configured_output_directory: "F:/Games/sample",
      effective_output_directory: "F:/Games/sample",
      selection_source: "port_setting",
    },
  };
  await root.rerender(
    <InstallAction
      ready
      sourceReady
      biosReady
      plan={externalPlan}
      install={vi.fn()}
      review={vi.fn()}
      dismiss={vi.fn()}
      openLibraryStorage={vi.fn()}
    />,
  );
  expect(button("Install · 64.0 MiB").disabled).toBe(false);
  expect(document.body.textContent).toContain("Destination capacity checked at install");
  expect(document.body.textContent).not.toContain("more free space in the Portcove library");
  expect(document.body.textContent).not.toContain("Open Library and storage");
});

it("does not dismiss the reviewed installation after installation starts", async () => {
  function BusyHarness() {
    const [reviewed, setReviewed] = useState<InstallPlan>();
    const [busy, setBusy] = useState(false);
    return (
      <InstallAction
        ready
        sourceReady
        biosReady
        plan={reviewed}
        busy={busy ? "install" : undefined}
        install={() => setBusy(true)}
        review={() => setReviewed(plan)}
        dismiss={() => setReviewed(undefined)}
      />
    );
  }

  await root.rerender(<BusyHarness />);
  await click("Review installation");
  await click("Install · 64.0 MiB");
  await pressEscape();
  expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
  expect(button("Cancel review").disabled).toBe(true);
});

it("keeps the active installation cancellation reachable inside the busy review", async () => {
  const cancel = vi
    .spyOn(desktopApi, "cancelOperation")
    .mockResolvedValue({ phase: "preparing", requested: true });
  const activity: ActivityRecord = {
    id: "install-1",
    operation: "install",
    target_id: "sample",
    target_kind: "port",
    status: "running",
    started_at: 1,
    finished_at: null,
    message: null,
    failure: null,
    cancellation: { phase: "preparing", requested: false },
  };
  await root.rerender(
    <InstallAction
      ready
      sourceReady
      biosReady
      plan={plan}
      busy="install"
      cancellations={[activity]}
      install={vi.fn()}
      review={vi.fn()}
      dismiss={vi.fn()}
    />,
  );
  const dialog = document.body.querySelector('[role="dialog"]');
  expect(button("Continue browsing").disabled).toBe(false);
  expect(dialog?.textContent).toContain("Cancel operation");
  expect(button("Cancel review").disabled).toBe(true);
  await pressEscape();
  expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
  await click("Cancel operation");
  expect(cancel).toHaveBeenCalledWith("install-1");
  expect(dialog?.textContent).toContain("Cancellation requested");
});

it("exposes a failed install result outside the dismissed review before another attempt", async () => {
  function FailureHarness() {
    const [reviewed, setReviewed] = useState<InstallPlan>();
    const [error, setError] = useState<string>();
    return (
      <>
        <StatusLayer error={error} clearError={() => setError(undefined)} />
        <InstallAction
          ready
          sourceReady
          biosReady
          plan={reviewed}
          install={() => {
            setError("Artifact unavailable");
            setReviewed(undefined);
          }}
          review={() => setReviewed(plan)}
          dismiss={() => setReviewed(undefined)}
        />
      </>
    );
  }
  await root.rerender(<FailureHarness />);
  await click("Review installation");
  await click("Install · 64.0 MiB");
  expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  expect(document.body.querySelector('[role="alert"]')?.textContent).toContain(
    "Artifact unavailable",
  );
  expect(document.activeElement?.textContent).toContain("Review installation");
});

it.each([
  ["download", "Install · 64.0 MiB", "64.0 MiB", "512 GiB available in library"],
  ["use_staged", "Use ready release", "No download", "Required component included · 1.0 KiB"],
  ["reuse_retained", "Use previous release", "No download", "Local release already checked"],
] as const)(
  "presents the %s plan with its player-facing action",
  async (action, actionLabel, firstDetail, secondDetail) => {
    const install = vi.fn();
    await root.rerender(
      <InstallAction
        ready
        sourceReady
        biosReady
        plan={reviewedPlan(action)}
        install={install}
        review={vi.fn()}
        dismiss={vi.fn()}
      />,
    );
    expect(document.body.textContent).toContain("Review installation");
    expect(document.body.textContent).toContain(firstDetail);
    expect(document.body.textContent).toContain(secondDetail);
    expect(document.body.textContent).toContain(
      action === "download"
        ? "Review the version, download size, and install folder."
        : "Review the version and how this local release will be used.",
    );
    expect(document.body.textContent?.includes("Install folder")).toBe(action === "download");
    expect(document.body.textContent?.includes("E:/Portcove/versions/sample")).toBe(
      action === "download",
    );
    expect(button(actionLabel).disabled).toBe(false);
    await click(actionLabel);
    expect(install).toHaveBeenCalledTimes(1);
  },
);

it("describes an unchecked local copy and keeps installation blocked", async () => {
  await root.rerender(
    <InstallAction
      ready
      sourceReady
      biosReady
      plan={reviewedPlan("blocked_unverified")}
      install={vi.fn()}
      review={vi.fn()}
      dismiss={vi.fn()}
    />,
  );
  expect(document.body.textContent).toContain("Local copy needs checking");
  expect(button("Verify or replace the local copy before installing").disabled).toBe(true);
  expect(document.activeElement).toBe(document.querySelector("#install-review-title"));
});

it.each(["future_action", "constructor", "__proto__"])(
  "offers only another review for unknown install action %s",
  async (action) => {
    const review = vi.fn();
    await root.rerender(
      <InstallAction
        ready
        sourceReady
        biosReady
        plan={reviewedPlan(action as InstallPlan["action"])}
        install={vi.fn()}
        review={review}
        dismiss={vi.fn()}
      />,
    );
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain(
      "cannot display the installation plan",
    );
    expect(document.body.textContent).not.toContain("INSTALL PLAN");
    expect(button("Review installation again").disabled).toBe(false);
    await click("Review installation again");
    expect(review).toHaveBeenCalledTimes(1);
  },
);

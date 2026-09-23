// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { desktopApi } from "../api";
import type { ActivityRecord, InstallPlan } from "../types";
import { StatusLayer } from "./Chrome";
import { InstallAction } from "./DetailPanel";

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

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
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

async function pressEscape() {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
}

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
  await act(async () => root.render(<MissingFilesHarness />));
  expect(button("Choose game files and BIOS").disabled).toBe(false);
  await click("Choose game files and BIOS");
  expect(pickSource).toHaveBeenCalledTimes(1);
  expect(button("Choose game files and BIOS").disabled).toBe(true);
  await act(async () => finishPicker?.());
  expect(button("Choose BIOS file").disabled).toBe(false);
  expect(document.activeElement).toBe(button("Choose BIOS file"));
  await click("Choose BIOS file");
  expect(pickBios).toHaveBeenCalledTimes(1);
  expect(document.activeElement).toBe(button("Review install"));
});

it("returns focus after a canceled picker and focuses the matching field without a picker", async () => {
  const pickSource = vi.fn(() => Promise.resolve());
  await act(async () =>
    root.render(
      <InstallAction
        ready={false}
        sourceReady={false}
        biosReady
        pickSource={pickSource}
        install={vi.fn()}
        review={vi.fn()}
        dismiss={vi.fn()}
      />,
    ),
  );
  await click("Choose game files");
  expect(document.activeElement).toBe(button("Choose game files"));
  expect(pickSource).toHaveBeenCalledTimes(1);

  const field = document.createElement("input");
  field.id = "source-bios";
  container.append(field);
  await act(async () =>
    root.render(
      <InstallAction
        ready={false}
        sourceReady
        biosReady={false}
        biosInputId="source-bios"
        install={vi.fn()}
        review={vi.fn()}
        dismiss={vi.fn()}
      />,
    ),
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
  await act(async () => root.render(<ReviewHarness install={install} />));
  await click("Review install");
  expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
  expect(document.body.textContent).toContain("2.0");
  expect(document.body.textContent).toContain("64.0 MiB");
  expect(document.activeElement?.textContent).toContain("Install · 64.0 MiB");
  await pressEscape();
  expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement?.textContent).toContain("Review install");

  await click("Review install");
  await click("Install · 64.0 MiB");
  expect(install).toHaveBeenCalledTimes(1);
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

  await act(async () => root.render(<BusyHarness />));
  await click("Review install");
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
  await act(async () =>
    root.render(
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
    ),
  );
  const dialog = document.body.querySelector('[role="dialog"]');
  expect(dialog?.querySelectorAll("button")).toHaveLength(3);
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
  await act(async () => root.render(<FailureHarness />));
  await click("Review install");
  await click("Install · 64.0 MiB");
  expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  expect(document.body.querySelector('[role="alert"]')?.textContent).toContain(
    "Artifact unavailable",
  );
  expect(document.activeElement?.textContent).toContain("Review install");
});

it.each([
  ["download", "Install · 64.0 MiB", "64.0 MiB", "512 GiB available"],
  ["use_staged", "Use ready release", "No download", "Required component included · 1.0 KiB"],
  ["reuse_retained", "Use previous release", "No download", "Local release already checked"],
] as const)(
  "presents the %s plan with its player-facing action",
  async (action, actionLabel, firstDetail, secondDetail) => {
    const install = vi.fn();
    await act(async () =>
      root.render(
        <InstallAction
          ready
          sourceReady
          biosReady
          plan={reviewedPlan(action)}
          install={install}
          review={vi.fn()}
          dismiss={vi.fn()}
        />,
      ),
    );
    expect(document.body.textContent).toContain("INSTALL PLAN");
    expect(document.body.textContent).toContain(firstDetail);
    expect(document.body.textContent).toContain(secondDetail);
    expect(button(actionLabel).disabled).toBe(false);
    await click(actionLabel);
    expect(install).toHaveBeenCalledTimes(1);
  },
);

it("describes an unchecked local copy and keeps installation blocked", async () => {
  await act(async () =>
    root.render(
      <InstallAction
        ready
        sourceReady
        biosReady
        plan={reviewedPlan("blocked_unverified")}
        install={vi.fn()}
        review={vi.fn()}
        dismiss={vi.fn()}
      />,
    ),
  );
  expect(document.body.textContent).toContain("Local copy needs checking");
  expect(button("Verify or replace the local copy before installing").disabled).toBe(true);
  expect(document.activeElement?.textContent).toBe("Cancel review");
});

it.each(["future_action", "constructor", "__proto__"])(
  "offers only another review for unknown install action %s",
  async (action) => {
    const review = vi.fn();
    await act(async () =>
      root.render(
        <InstallAction
          ready
          sourceReady
          biosReady
          plan={reviewedPlan(action as InstallPlan["action"])}
          install={vi.fn()}
          review={review}
          dismiss={vi.fn()}
        />,
      ),
    );
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain(
      "cannot display the installation plan",
    );
    expect(document.body.textContent).not.toContain("INSTALL PLAN");
    expect(button("Review install again").disabled).toBe(false);
    await click("Review install again");
    expect(review).toHaveBeenCalledTimes(1);
  },
);

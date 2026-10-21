import { StrictMode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { cleanup, render, type RenderResult } from "vitest-browser-react";
import { controlledAct as act } from "../../test/controlled-react-act";
import App, { BootstrapRecovery } from "../App";
import { desktopApi } from "../api";
import { failureReport, fixtureValue } from "../test-fixtures";
import type { BootstrapStatus, DesktopSupportBundleExport } from "../types";
import { SettingsView } from "./Chrome";
import { SupportBundleExport } from "./SupportBundleExport";
import "../styles/index.css";

function bundle(): DesktopSupportBundleExport {
  return {
    path: "E:/diagnostics/نسخة/support.zip",
    manifest: {
      schema_version: 1,
      created_at_ms: 1_700_000_000_000,
      product_version: "0.0.0-test",
      target_os: "windows",
      target_arch: "x86_64",
      source_revision: null,
      scope: "bounded_recent_diagnostics",
      library_available: false,
      limits: {
        total_bytes: 16 * 1024 * 1024,
        section_bytes: 8 * 1024 * 1024,
        log_bytes: 4 * 1024 * 1024,
        record_bytes: 64 * 1024,
        activity_count: 100,
        capture_count: 32,
        collection_seconds: 30,
      },
      sections: [
        {
          kind: "startup",
          provenance: "desktop_startup",
          entry: "startup.json",
          status: "included",
          reasons: [],
          bytes_read: null,
          bytes_written: 80,
          records: null,
        },
        {
          kind: "doctor",
          provenance: "library_doctor_snapshot",
          entry: null,
          status: "omitted",
          reasons: ["unavailable"],
          bytes_read: null,
          bytes_written: 0,
          records: null,
        },
        {
          kind: "activities",
          provenance: "activity_history",
          entry: "activities.jsonl",
          status: "partial",
          reasons: ["invalid_record", "record_limit"],
          bytes_read: 1024,
          bytes_written: 512,
          records: 2,
        },
        {
          kind: "activity_capture",
          provenance: "activity_diagnostics",
          entry: "captures/retained.json",
          status: "partial",
          reasons: ["capture_incomplete", "capture_truncated"],
          bytes_read: 256,
          bytes_written: 256,
          records: 1,
        },
        {
          kind: "runtime_log",
          provenance: "desktop_runtime_log",
          entry: "logs/runtime.jsonl",
          status: "partial",
          reasons: ["incomplete_record", "read_failed"],
          bytes_read: null,
          bytes_written: 128,
          records: 1,
        },
      ],
    },
  };
}

function startupFailure() {
  const error = failureReport();
  error.presentation.summary = "The library database could not be read.";
  return error;
}

function failedBootstrap(generation: number): BootstrapStatus {
  return {
    error: startupFailure(),
    generation,
    library_root: "E:/unavailable-library",
    ready: false,
    selection: null,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

let root: RenderResult;
let host: HTMLDivElement;
beforeEach(async () => {
  host = document.body.appendChild(document.createElement("div"));
  root = await render(null, { container: host });
});
afterEach(async () => {
  await cleanup();
  vi.restoreAllMocks();
});

function button(label: string) {
  return fixtureValue(
    [...host.querySelectorAll("button")].find((candidate) => candidate.textContent === label),
    label,
  );
}

async function click(label: string) {
  await act(async () => button(label).click());
}

it("exports only on request after failed library startup and leaves recovery available", async () => {
  const pending = deferred<DesktopSupportBundleExport>();
  const create = vi.spyOn(desktopApi, "createSupportBundle").mockReturnValue(pending.promise);
  const chooseLibrary = vi.fn(async () => {});
  const resetLibrary = vi.fn(async () => {});
  await root.rerender(
    <StrictMode>
      <BootstrapRecovery
        error={startupFailure()}
        chooseLibrary={chooseLibrary}
        resetLibrary={resetLibrary}
      />
    </StrictMode>,
  );
  expect(create).not.toHaveBeenCalled();
  const action = button("Create support bundle");
  await act(async () => {
    action.click();
    action.click();
  });
  expect(create).toHaveBeenCalledOnce();
  expect(action.disabled).toBe(true);
  expect(button("Retry startup").disabled).toBe(false);
  expect(button("Choose library").disabled).toBe(false);
  expect(button("Use platform default").disabled).toBe(false);
  await act(async () => pending.resolve(bundle()));
  expect(host.textContent).toContain("Support bundle saved to E:/diagnostics/نسخة/support.zip");
  expect(host.textContent).toContain("The library database could not be read.");
  expect(host.textContent).toContain("Some diagnostics are partial or omitted.");
  expect(host.textContent).toContain("The library was unavailable during collection.");
  expect(chooseLibrary).not.toHaveBeenCalled();
  expect(resetLibrary).not.toHaveBeenCalled();
});

it("shows retained sections, unknown contents and incomplete capture without claiming recovery", async () => {
  await root.rerender(<SupportBundleExport createSupportBundle={vi.fn(async () => bundle())} />);
  await click("Create support bundle");
  await page.getByText("View support bundle contents", { exact: true }).click();
  for (const text of [
    "Startup diagnostics: Included",
    "System and library checks: Omitted",
    "Recent activity history: Partially included",
    "Preparation output: Partially included",
    "Runtime log: Partially included",
    "The diagnostic source was unavailable; its contents are unknown.",
    "Invalid records were omitted.",
    "Some records were omitted to stay within the record limit.",
    "The retained capture may be missing later output.",
    "Some captured output was omitted when the capture limit was reached.",
    "An incomplete trailing record was omitted.",
    "The diagnostic source could not be fully read; any missing contents are unknown.",
  ]) {
    await expect.element(page.getByText(text, { exact: true })).toBeVisible();
  }
  expect(host.textContent).not.toMatch(/complete diagnostics|library recovered|0 records/iu);
});

it("describes included sections as a bounded snapshot without claiming complete diagnostics", async () => {
  const exported = bundle();
  exported.manifest.library_available = true;
  exported.manifest.sections = exported.manifest.sections.filter(
    (section) => section.kind === "startup",
  );
  await root.rerender(<SupportBundleExport createSupportBundle={vi.fn(async () => exported)} />);
  await click("Create support bundle");
  expect(host.textContent).toContain(
    "Only the available diagnostics within collection limits were saved.",
  );
  expect(host.textContent).not.toContain("Some diagnostics are partial or omitted.");
  expect(host.textContent).not.toContain("The library was unavailable");
  expect(host.textContent).not.toContain("complete diagnostics");
});

it("uses the same receipt in Settings without refreshing diagnostic state", async () => {
  const create = vi.fn(async () => bundle());
  const refresh = vi.fn(async () => {});
  await root.rerender(
    <SettingsView
      category="advanced"
      createSupportBundle={create}
      refreshDiagnostics={refresh}
      diagnosticsStale={false}
    />,
  );
  expect(create).not.toHaveBeenCalled();
  await click("Create support bundle");
  expect(create).toHaveBeenCalledOnce();
  expect(refresh).not.toHaveBeenCalled();
  expect(host.textContent).toContain("Diagnostics are current.");
  expect(host.textContent).toContain("Some diagnostics are partial or omitted.");
});

it("keeps export failure separate from startup failure and retries without exposing raw error text", async () => {
  const failure = failureReport();
  failure.message = "unrequested private export detail";
  failure.presentation.summary = "The bundle destination could not be written.";
  failure.presentation.technical_message = "redacted destination failure";
  const create = vi
    .spyOn(desktopApi, "createSupportBundle")
    .mockRejectedValueOnce(failure)
    .mockResolvedValueOnce(bundle());
  await root.rerender(<BootstrapRecovery error={startupFailure()} />);
  await click("Create support bundle");
  expect(host.textContent).toContain("Support bundle export did not finish. Try again.");
  expect(host.textContent).toContain("The bundle destination could not be written.");
  expect(host.textContent).toContain("The library database could not be read.");
  expect(host.textContent).not.toContain("unrequested private export detail");
  await click("Create support bundle");
  expect(create).toHaveBeenCalledTimes(2);
  expect(host.textContent).toContain("Support bundle saved to");
  expect(host.textContent).not.toContain("Support bundle export did not finish");
  expect(host.textContent).toContain("The library database could not be read.");
});

it.each(["unconfirmed", "unstructured failure"])(
  "does not publish a receipt for %s and allows another export",
  async (outcome) => {
    const create = vi.fn<() => Promise<DesktopSupportBundleExport | undefined>>();
    if (outcome === "unconfirmed") create.mockResolvedValueOnce(undefined);
    else create.mockRejectedValueOnce(new Error("unrequested private write detail"));
    create.mockResolvedValueOnce(bundle());
    await root.rerender(<SupportBundleExport createSupportBundle={create} />);
    await click("Create support bundle");
    expect(host.textContent).toContain("Support bundle export did not finish.");
    expect(host.textContent).not.toContain("Support bundle saved to");
    expect(host.textContent).not.toContain("unrequested private write detail");
    expect(button("Create support bundle").disabled).toBe(false);
    await click("Create support bundle");
    expect(host.textContent).toContain("Support bundle saved to");
  },
);

it.each(["success", "failure"])(
  "discards a late export %s after the failed library generation is replaced",
  async (outcome) => {
    const pending = deferred<DesktopSupportBundleExport>();
    vi.spyOn(desktopApi, "bootstrapStatus").mockResolvedValue(failedBootstrap(1));
    vi.spyOn(desktopApi, "resetDefaultLibrary").mockResolvedValue(failedBootstrap(2));
    const replacement = bundle();
    replacement.path = "E:/diagnostics/current-library.zip";
    const create = vi
      .spyOn(desktopApi, "createSupportBundle")
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(replacement);
    await root.rerender(<App />);
    await click("Create support bundle");
    await click("Use platform default");
    expect(button("Create support bundle").disabled).toBe(false);
    await click("Create support bundle");
    await act(async () => {
      if (outcome === "success") pending.resolve(bundle());
      else pending.reject(new Error("outgoing export failure"));
    });
    expect(create).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain(replacement.path);
    expect(host.textContent).not.toContain(bundle().path);
    expect(host.textContent).not.toContain("Support bundle export did not finish");
    expect(host.textContent).not.toContain("outgoing export failure");
  },
);

it("keeps a Unicode destination readable in a narrow reading flow", async () => {
  await page.viewport(240, 800);
  const exported = bundle();
  exported.path = `E:/diagnostics/${"نسخة-保存-".repeat(16)}support.zip`;
  try {
    await root.rerender(
      <main style={{ padding: 16 }}>
        <SupportBundleExport createSupportBundle={vi.fn(async () => exported)} />
      </main>,
    );
    await click("Create support bundle");
    const path = fixtureValue(host.querySelector('[role="status"] code'), "saved path");
    expect(path.textContent).toBe(exported.path);
    expect(path.getAttribute("dir")).toBe("ltr");
    expect(getComputedStyle(path).unicodeBidi).toBe("isolate");
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(241);
  } finally {
    await page.viewport(1280, 800);
  }
});

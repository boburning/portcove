// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { desktopApi } from "../api";
import type {
  InstallRecord,
  OutputDestinationPreview,
  OutputRelocationPlan,
  PortOutputLocation,
} from "../types";
import { OutputLocationControl } from "./OutputLocation";

const defaultLocation = (portId: string, custom?: string): PortOutputLocation => ({
  port_id: portId,
  library_root: "E:/Portcove",
  default_output_directory: `E:/Portcove/versions/${portId}`,
  configured_output_directory: custom ?? null,
  effective_output_directory: custom ?? `E:/Portcove/versions/${portId}`,
  selection_source: custom ? "port_setting" : "library_default",
  user_data_root: `E:/Portcove/user/${portId}`,
});

const destinationPreview = (
  portId: string,
  path: string,
  overrides: Partial<OutputDestinationPreview> = {},
): OutputDestinationPreview => ({
  port_id: portId,
  current: defaultLocation(portId),
  proposed: {
    ...defaultLocation(portId, path),
    selection_source: "port_setting",
  },
  reset_to_default: false,
  availability: "available",
  ownership: "unclaimed",
  available_bytes: 8 * 1024 ** 3,
  total_bytes: 16 * 1024 ** 3,
  volume_identity: "volume-a",
  validation_errors: [],
  affected_installs: [],
  moves_existing_install: false,
  preview_sha256: "a".repeat(64),
  ...overrides,
});

const currentDestinationPreview = (
  portId: string,
  path: string | null = null,
  overrides: Partial<OutputDestinationPreview> = {},
): OutputDestinationPreview => {
  const current = defaultLocation(portId, path ?? undefined);
  return {
    ...destinationPreview(portId, current.effective_output_directory),
    current,
    proposed: current,
    reset_to_default: path === null,
    ownership: path === null ? "library_default" : "owned_by_port",
    ...overrides,
  };
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

let root: Root;
let container: HTMLDivElement;

async function render(children: React.ReactNode) {
  await act(async () => {
    root.render(children);
  });
}

function button(label: string, within: ParentNode = document.body) {
  const match = [...within.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.includes(label),
  );
  if (!(match instanceof HTMLButtonElement)) throw new Error(`missing button: ${label}`);
  return match;
}

async function click(label: string, within: ParentNode = document.body) {
  await act(async () => {
    button(label, within).click();
  });
}

async function changePath(path: string, within: ParentNode = container) {
  const input = within.querySelector("input");
  if (!(input instanceof HTMLInputElement)) throw new Error("missing output path input");
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (setter) Reflect.apply(setter, input, [path]);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function pressEscape() {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  vi.spyOn(desktopApi, "outputRelocationStatus").mockResolvedValue(null);
  vi.spyOn(desktopApi, "previewOutputLocation").mockImplementation(async (portId, path) =>
    currentDestinationPreview(portId, path),
  );
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("per-game install folder", () => {
  it("shows current destination availability and capacity without requiring a review", async () => {
    vi.spyOn(desktopApi, "outputLocation").mockResolvedValue(defaultLocation("sample"));

    await render(<OutputLocationControl portId="sample" generation={7} />);

    const current = container.querySelector('[aria-label="Current output destination"]');
    expect(current?.textContent).toContain("Current destination");
    expect(current?.textContent).toContain("Available");
    expect(current?.textContent).toContain("8.0 GiB available of 16.0 GiB");
    expect(desktopApi.previewOutputLocation).toHaveBeenCalledWith("sample", null, 7);
  });

  it("keeps an unavailable current folder selected and gives a reviewed recovery action", async () => {
    const custom = "F:/Disconnected/Sample";
    vi.spyOn(desktopApi, "outputLocation").mockResolvedValue(defaultLocation("sample", custom));
    vi.mocked(desktopApi.previewOutputLocation).mockResolvedValue(
      currentDestinationPreview("sample", custom, {
        availability: "unavailable",
        available_bytes: null,
        total_bytes: null,
        validation_errors: ["selected drive is unavailable"],
      }),
    );
    const reset = vi.spyOn(desktopApi, "resetOutputLocation");

    await render(<OutputLocationControl portId="sample" generation={7} />);

    const current = container.querySelector('[aria-label="Current output destination"]');
    expect(current?.textContent).toContain("Unavailable");
    expect(current?.textContent).toContain("Capacity unavailable");
    expect(current?.textContent).toContain("selected drive is unavailable");
    expect(current?.textContent).toContain("This destination stays selected");
    expect(current?.textContent).toContain("Choose an available folder below");
    expect(document.body.textContent).toContain(custom);
    expect(document.body.textContent).toContain("Custom for this game");
    expect(desktopApi.previewOutputLocation).toHaveBeenCalledWith("sample", custom, 7);
    expect(reset).not.toHaveBeenCalled();
  });

  it("leaves folder controls usable when current availability cannot be checked", async () => {
    vi.spyOn(desktopApi, "outputLocation").mockResolvedValue(defaultLocation("sample"));
    vi.mocked(desktopApi.previewOutputLocation).mockRejectedValue(
      new Error("volume inspection failed"),
    );

    await render(<OutputLocationControl portId="sample" generation={7} />);

    expect(document.body.textContent).toContain(
      "Current availability could not be checked: volume inspection failed",
    );
    expect(button("Review future folder").disabled).toBe(false);
    expect((container.querySelector("input") as HTMLInputElement).disabled).toBe(false);
  });

  it("discards a current destination inspection after the game and library change", async () => {
    const first = deferred<OutputDestinationPreview>();
    const second = deferred<OutputDestinationPreview>();
    vi.spyOn(desktopApi, "outputLocation").mockImplementation(async (portId) =>
      defaultLocation(portId, `F:/${portId}`),
    );
    vi.mocked(desktopApi.previewOutputLocation).mockImplementation((portId) =>
      portId === "first" ? first.promise : second.promise,
    );

    await render(<OutputLocationControl portId="first" generation={7} />);
    await render(<OutputLocationControl portId="second" generation={8} />);
    await act(async () => {
      second.resolve(currentDestinationPreview("second", "F:/second"));
      await second.promise;
    });
    await act(async () => {
      first.resolve(
        currentDestinationPreview("first", "F:/first", {
          availability: "unavailable",
          validation_errors: ["old destination is unavailable"],
        }),
      );
      await first.promise;
    });

    expect(document.body.textContent).toContain("F:/second");
    expect(document.body.textContent).toContain("Available");
    expect(document.body.textContent).not.toContain("old destination is unavailable");
  });

  it.each([
    [
      0,
      "Relocation cleanup is pending. Portcove will retry only when the reviewed contents are unchanged.",
    ],
    [
      1,
      "Relocation cleanup is pending for 1 old folder. Portcove will retry only when its reviewed contents are unchanged.",
    ],
    [
      2,
      "Relocation cleanup is pending for 2 old folders. Portcove will retry only when their reviewed contents are unchanged.",
    ],
  ])("keeps pending cleanup explicit for %s old folders", async (count, message) => {
    vi.spyOn(desktopApi, "outputLocation").mockResolvedValue(defaultLocation("sample"));
    vi.mocked(desktopApi.outputRelocationStatus).mockResolvedValue({
      port_id: "sample",
      operation_id: "pending",
      destination_root: "F:/Games/Sample",
      phase: "cleanup_pending",
      last_error: null,
      cleanup_pending_paths: Array.from(
        { length: Number(count) },
        (_, index) => `E:/Portcove/old-${index}`,
      ),
    });
    await render(<OutputLocationControl portId="sample" generation={7} />);
    expect(document.body.textContent).toContain(message);
    expect(document.body.textContent).not.toContain("folder(s)");
  });

  it("keeps an unknown destination availability blocked", async () => {
    vi.spyOn(desktopApi, "outputLocation").mockResolvedValue(defaultLocation("sample"));
    vi.spyOn(desktopApi, "previewOutputLocation").mockResolvedValue(
      destinationPreview("sample", "F:/Games/Sample", {
        availability: "future_availability" as OutputDestinationPreview["availability"],
      }),
    );
    await render(<OutputLocationControl portId="sample" generation={7} />);
    await changePath("F:/Games/Sample");
    await click("Review future folder");
    expect(document.body.textContent).toContain("Availability result unavailable");
    expect(button("Use this folder for future installs").disabled).toBe(true);
  });

  it("does not relocate installations using an unknown ownership result", async () => {
    vi.spyOn(desktopApi, "outputLocation").mockResolvedValue(defaultLocation("sample"));
    const affected = {
      install_id: "install-1",
      version: "1.0",
      path: "E:/Portcove/versions/sample/old",
      active: true,
      previous: false,
      staged: false,
    };
    vi.spyOn(desktopApi, "previewOutputLocation").mockResolvedValue(
      destinationPreview("sample", "F:/Games/Sample", {
        affected_installs: [affected],
      }),
    );
    vi.spyOn(desktopApi, "planOutputRelocation").mockResolvedValue({
      port_id: "sample",
      current: defaultLocation("sample"),
      channel: "stable",
      destination_root: "F:/Games/Sample",
      installs: [],
      required_bytes: 0,
      available_bytes: 1024,
      total_bytes: 2048,
      volume_identity: "owned-volume",
      availability: "available",
      ownership: "future_ownership" as OutputRelocationPlan["ownership"],
      validation_errors: [],
      sources_will_move: false,
      user_data_will_move: false,
      backups_will_move: false,
      plan_sha256: "b".repeat(64),
    });
    const move = vi.spyOn(desktopApi, "relocateOutput");
    await render(<OutputLocationControl portId="sample" generation={7} />);
    await changePath("F:/Games/Sample");
    await click("Review future folder");
    await click("Review moving existing versions");
    expect(document.body.textContent).toContain("Ownership result unavailable");
    expect(button("Move existing versions").disabled).toBe(true);
    await click("Move existing versions");
    expect(move).not.toHaveBeenCalled();
  });

  it.each(["future_ownership", "constructor", "__proto__"])(
    "does not apply an unfamiliar destination ownership %s",
    async (ownership) => {
      vi.spyOn(desktopApi, "outputLocation").mockResolvedValue(defaultLocation("sample"));
      const preview = destinationPreview("sample", "F:/Games/Sample", {
        ownership: ownership as OutputDestinationPreview["ownership"],
      });
      preview.proposed.selection_source =
        "future_location_origin" as typeof preview.proposed.selection_source;
      vi.spyOn(desktopApi, "previewOutputLocation").mockResolvedValue(preview);
      const apply = vi.spyOn(desktopApi, "setOutputLocation");
      await render(<OutputLocationControl portId="sample" generation={7} />);
      await changePath("F:/Games/Sample");
      await click("Review future folder");
      expect(document.body.textContent).toContain("Ownership result unavailable");
      expect(document.body.textContent).toContain("Location origin unavailable");
      expect(button("Use this folder for future installs").disabled).toBe(true);
      await click("Use this folder for future installs");
      expect(apply).not.toHaveBeenCalled();
    },
  );

  it("renders inherited, unavailable, full, and validation-error states without offering an unsafe apply", async () => {
    vi.spyOn(desktopApi, "outputLocation").mockResolvedValue(defaultLocation("sample"));
    vi.mocked(desktopApi.previewOutputLocation)
      .mockResolvedValueOnce(currentDestinationPreview("sample"))
      .mockResolvedValueOnce(
        destinationPreview("sample", "F:/Games/Sample", {
          availability: "unavailable",
          available_bytes: null,
          total_bytes: null,
          validation_errors: ["selected drive is unavailable"],
        }),
      )
      .mockResolvedValueOnce(
        destinationPreview("sample", "G:/Games/Sample", {
          availability: "full",
          available_bytes: 0,
          validation_errors: ["game output volume has no available space"],
        }),
      );

    await render(<OutputLocationControl portId="sample" generation={7} />);
    expect(document.body.textContent).toContain("Inherited from the Portcove library");
    expect(document.body.textContent).toContain(
      "New versions will be installed here. Existing versions will not move.",
    );
    const input = container.querySelector("input")!;
    expect(container.querySelector(`label[for="${input.id}"]`)?.textContent).toContain(
      "Folder for future installs",
    );
    expect(input.getAttribute("aria-describedby")).toBe("output-location-note-sample");
    expect(button("Review future folder").hasAttribute("data-focusable")).toBe(true);

    await changePath("F:/Games/Sample");
    await click("Review future folder");
    expect(document.body.textContent).toContain("Unavailable");
    expect(document.body.textContent).toContain("Custom for this game");
    expect(document.body.textContent).toContain("selected drive is unavailable");
    expect(button("Use this folder for future installs").disabled).toBe(true);

    await changePath("G:/Games/Sample");
    await click("Review future folder");
    expect(document.body.textContent).toContain("Full · no free space");
    expect(document.body.textContent).toContain("game output volume has no available space");
    expect(button("Use this folder for future installs").disabled).toBe(true);
  });

  it("reviews and resets a custom folder while restoring focus after cancellation", async () => {
    const custom = defaultLocation("sample", "F:/Games/Sample");
    const reset = defaultLocation("sample");
    vi.spyOn(desktopApi, "outputLocation").mockResolvedValue(custom);
    const resetPreview = {
      ...destinationPreview("sample", reset.effective_output_directory),
      current: custom,
      proposed: reset,
      reset_to_default: true,
      ownership: "library_default",
    } satisfies OutputDestinationPreview;
    vi.mocked(desktopApi.previewOutputLocation)
      .mockResolvedValueOnce(currentDestinationPreview("sample", custom.effective_output_directory))
      .mockResolvedValueOnce(resetPreview)
      .mockResolvedValueOnce(resetPreview)
      .mockResolvedValueOnce(
        currentDestinationPreview("sample", null, {
          available_bytes: 4 * 1024 ** 3,
          total_bytes: 16 * 1024 ** 3,
        }),
      );
    const applyReset = vi.spyOn(desktopApi, "resetOutputLocation").mockResolvedValue(reset);
    const onChanged = vi.fn();
    const onApplying = vi.fn();

    await render(
      <OutputLocationControl
        portId="sample"
        generation={8}
        onChanged={onChanged}
        onApplying={onApplying}
      />,
    );
    expect(document.body.textContent).toContain("Custom for this game");
    const trigger = button("Review library default");
    await click("Review library default");
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.body.textContent).toContain("Use library default for future installs");
    expect(document.body.textContent).toContain("Future placement only");
    await pressEscape();
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);

    await click("Review library default");
    await click("Use library default for future installs");
    expect(applyReset).toHaveBeenCalledWith("sample", "a".repeat(64), 8);
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(onApplying.mock.calls).toEqual([[true], [false]]);
    expect(document.body.textContent).toContain("Inherited from the Portcove library");
    expect(document.activeElement).toBe(button("Review future folder"));
    expect(document.body.textContent).toContain("4.0 GiB available of 16.0 GiB");
    expect(desktopApi.previewOutputLocation).toHaveBeenNthCalledWith(4, "sample", null, 8);
  });

  it("keeps mixed roots independent and disables controls during another operation", async () => {
    vi.spyOn(desktopApi, "outputLocation").mockImplementation(async (portId) =>
      defaultLocation(portId, `F:/Games/${portId}`),
    );
    vi.spyOn(desktopApi, "previewOutputLocation").mockImplementation(async (portId) => ({
      ...destinationPreview(portId, `E:/Portcove/versions/${portId}`),
      current: defaultLocation(portId, `F:/Games/${portId}`),
      proposed: defaultLocation(portId),
      reset_to_default: true,
      ownership: "library_default",
    }));
    const reset = vi
      .spyOn(desktopApi, "resetOutputLocation")
      .mockImplementation(async (portId) => defaultLocation(portId));

    await render(
      <>
        <div data-port="first">
          <OutputLocationControl portId="first" generation={9} />
        </div>
        <div data-port="second">
          <OutputLocationControl portId="second" generation={9} busy="install" />
        </div>
      </>,
    );
    const first = container.querySelector('[data-port="first"]')!;
    const second = container.querySelector('[data-port="second"]')!;
    expect((second.querySelector("input") as HTMLInputElement).disabled).toBe(true);
    await click("Review library default", first);
    await click("Use library default for future installs");
    expect(reset).toHaveBeenCalledTimes(1);
    expect(reset.mock.calls[0][0]).toBe("first");
    expect(second.textContent).toContain("F:/Games/second");
  });

  it("keeps the newest path preview, suppresses stale failures, and requires a fresh review after apply conflict", async () => {
    vi.spyOn(desktopApi, "outputLocation").mockResolvedValue(defaultLocation("sample"));
    const old = deferred<OutputDestinationPreview>();
    const current = deferred<OutputDestinationPreview>();
    vi.mocked(desktopApi.previewOutputLocation)
      .mockResolvedValueOnce(currentDestinationPreview("sample"))
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(current.promise);
    const apply = vi
      .spyOn(desktopApi, "setOutputLocation")
      .mockRejectedValue(new Error("destination capacity changed"));

    await render(<OutputLocationControl portId="sample" generation={10} />);
    await changePath("F:/Old");
    let oldReview!: Promise<void>;
    await act(async () => {
      oldReview = Promise.resolve(button("Review future folder").click()).then(() => undefined);
    });
    await changePath("F:/Current");
    await click("Review future folder");
    await act(async () => {
      current.resolve(destinationPreview("sample", "F:/Current"));
      await current.promise;
    });
    await act(async () => {
      old.reject(new Error("stale preview failed"));
      await oldReview;
    });
    expect(document.body.textContent).toContain("F:/Current");
    expect(document.body.textContent).not.toContain("stale preview failed");

    await click("Use this folder for future installs");
    expect(apply).toHaveBeenCalledWith("sample", "F:/Current", "a".repeat(64), 10);
    expect(document.body.textContent).toContain("destination capacity changed");
    expect(document.body.textContent).toContain("Review the current destination again");
    expect(document.body.textContent).not.toContain("Use this folder for future installs");
    expect(document.activeElement).toBe(button("Review future folder"));
  });

  it("discards an old preview after the port and library generation change", async () => {
    vi.spyOn(desktopApi, "outputLocation").mockImplementation(async (portId) =>
      defaultLocation(portId),
    );
    const old = deferred<OutputDestinationPreview>();
    const current = deferred<OutputDestinationPreview>();
    vi.mocked(desktopApi.previewOutputLocation).mockImplementation((_portId, path) => {
      if (path === null) return Promise.resolve(currentDestinationPreview(_portId));
      return path === "F:/First" ? old.promise : current.promise;
    });

    await render(<OutputLocationControl key="first:11" portId="first" generation={11} />);
    await changePath("F:/First");
    await click("Review future folder");
    await render(<OutputLocationControl key="second:12" portId="second" generation={12} />);
    await changePath("F:/Second");
    await click("Review future folder");
    await act(async () => {
      current.resolve(destinationPreview("second", "F:/Second"));
      await current.promise;
    });
    await act(async () => {
      old.reject(new Error("old library failed"));
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain("F:/Second");
    expect(document.body.textContent).not.toContain("F:/First");
    expect(document.body.textContent).not.toContain("old library failed");
    expect(desktopApi.previewOutputLocation).toHaveBeenNthCalledWith(2, "first", "F:/First", 11);
    expect(desktopApi.previewOutputLocation).toHaveBeenNthCalledWith(4, "second", "F:/Second", 12);
  });

  it("releases the detail busy state when the selected game changes during apply", async () => {
    vi.spyOn(desktopApi, "outputLocation").mockImplementation(async (portId) =>
      defaultLocation(portId),
    );
    vi.spyOn(desktopApi, "previewOutputLocation").mockResolvedValue(
      destinationPreview("first", "F:/First"),
    );
    const oldApply = deferred<PortOutputLocation>();
    vi.spyOn(desktopApi, "setOutputLocation").mockReturnValue(oldApply.promise);
    const onApplying = vi.fn();
    const onChanged = vi.fn();

    await render(
      <OutputLocationControl
        key="first:13"
        portId="first"
        generation={13}
        onApplying={onApplying}
        onChanged={onChanged}
      />,
    );
    await changePath("F:/First");
    await click("Review future folder");
    await act(async () => {
      button("Use this folder for future installs").click();
    });
    expect(onApplying.mock.calls).toEqual([[true]]);
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
    await pressEscape();
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();

    await render(
      <OutputLocationControl
        key="second:13"
        portId="second"
        generation={13}
        onApplying={onApplying}
        onChanged={onChanged}
      />,
    );
    expect(onApplying.mock.calls).toEqual([[true], [false]]);
    await act(async () => {
      oldApply.resolve(defaultLocation("first", "F:/First"));
      await oldApply.promise;
    });
    expect(onApplying.mock.calls).toEqual([[true], [false]]);
    expect(onChanged).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("E:/Portcove/versions/second");
  });

  it("offers a state-bound relocation review and reports retained cleanup truthfully", async () => {
    const affected = {
      install_id: "install-1",
      version: "1.0.0",
      path: "E:/Portcove/versions/sample/old",
      active: true,
      previous: false,
      staged: false,
    };
    vi.spyOn(desktopApi, "outputLocation").mockResolvedValue(defaultLocation("sample"));
    vi.spyOn(desktopApi, "previewOutputLocation").mockResolvedValue(
      destinationPreview("sample", "F:/Games/Sample", {
        affected_installs: [affected],
      }),
    );
    const install = {
      id: "install-1",
      port_id: "sample",
      version: "1.0.0",
      path: affected.path,
    } as InstallRecord;
    const plan = {
      port_id: "sample",
      current: defaultLocation("sample"),
      channel: "stable",
      destination_root: "F:/Games/Sample",
      installs: [
        {
          install,
          destination_path: "F:/Games/Sample/install-1",
          active: true,
          previous: false,
          staged: false,
          retained: false,
          copy: {
            directories: [],
            files: [],
            skipped_entries: [],
            total_bytes: 4096,
          },
        },
      ],
      required_bytes: 4096,
      available_bytes: 1024 ** 3,
      total_bytes: 2 * 1024 ** 3,
      volume_identity: "volume-f",
      availability: "available",
      ownership: "unclaimed",
      validation_errors: [],
      sources_will_move: false,
      user_data_will_move: false,
      backups_will_move: false,
      plan_sha256: "b".repeat(64),
    } satisfies OutputRelocationPlan;
    const reviewMove = vi.spyOn(desktopApi, "planOutputRelocation").mockResolvedValue(plan);
    const move = vi.spyOn(desktopApi, "relocateOutput").mockResolvedValue({
      operation_id: "operation-1",
      port_id: "sample",
      output_location: defaultLocation("sample", "F:/Games/Sample"),
      relocated_installs: [{ ...install, path: "F:/Games/Sample/install-1" }],
      old_paths_retained: [affected.path],
      cleanup_pending: true,
    });
    const onApplying = vi.fn();

    await render(<OutputLocationControl portId="sample" generation={14} onApplying={onApplying} />);
    await changePath("F:/Games/Sample");
    const trigger = button("Review future folder");
    await click("Review future folder");
    expect(document.body.textContent).toContain("remain at their recorded locations");
    await click("Review moving existing versions");
    expect(reviewMove).toHaveBeenCalledWith("sample", "F:/Games/Sample", 14);
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
    await pressEscape();
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    await click("Review future folder");
    await click("Review moving existing versions");
    expect(document.body.textContent).toContain("SourcesStay in the central source library");
    expect(document.body.textContent).toContain("Saves and backupsStay in their current folders");
    expect(document.body.textContent).toContain("active");
    await click("Move existing versions");
    expect(move).toHaveBeenCalledWith("sample", "F:/Games/Sample", "b".repeat(64), 14);
    expect(onApplying.mock.calls).toEqual([[true], [false]]);
    expect(document.body.textContent).toContain("Move completed");
    expect(document.activeElement).toBe(trigger);
    expect(document.body.textContent).toContain(
      "Move completed. 1 old folder contains changed files and remains for safe cleanup.",
    );
  });
});

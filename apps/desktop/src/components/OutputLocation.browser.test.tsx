import { requireCompleteCaptureTarget } from "../../test/capture-target";
import { captureParityState } from "../../test/parity-capture";
import { controlledAct as act } from "../../test/controlled-react-act";
import { render as renderComponent, cleanup, type RenderResult } from "vitest-browser-react";
import { fixtureValue } from "../test-fixtures";

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { useState } from "react";
import { desktopApi } from "../api";
import type {
  InstallRecord,
  OutputDestinationPreview,
  OutputRelocationPlan,
  PortOutputLocation,
} from "../types";
import { OutputLocationControl } from "./OutputLocation";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./ui/dialog";

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

let root: RenderResult;
let container: HTMLDivElement;

async function render(children: React.ReactNode) {
  await root.rerender(children);
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

function RetryFocusContext() {
  const [helpOpen, setHelpOpen] = useState(false);
  return (
    <>
      <OutputLocationControl portId="sample" generation={7} />
      <details>
        <summary>Technical details outside the folder control</summary>
        <p>Recorded checks remain available.</p>
      </details>
      <Button onClick={() => setHelpOpen(true)}>Open read-only folder help</Button>
      <Dialog open={helpOpen} onOpenChange={setHelpOpen}>
        <DialogContent>
          <DialogTitle>Read-only folder help</DialogTitle>
          <DialogDescription>
            Reading folder settings does not change installed files.
          </DialogDescription>
          <Button>Keep reading help</Button>
        </DialogContent>
      </Dialog>
    </>
  );
}

async function pressEscape() {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
}

beforeEach(async () => {
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  container = document.createElement("div");
  document.body.append(container);
  root = await renderComponent(null, { container: document.body.appendChild(container) });
  vi.spyOn(desktopApi, "outputRelocationStatus").mockResolvedValue(null);
  vi.spyOn(desktopApi, "previewOutputLocation").mockImplementation(async (portId, path) =>
    currentDestinationPreview(portId, path),
  );
});

afterEach(async () => {
  await cleanup();
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("per-game install folder", () => {
  it.each([
    {
      name: "extended-windows",
      theme: "dark",
      width: 960,
      direction: "ltr",
      prefix: String.raw`\\?\C:\Portcove`,
    },
    {
      name: "extended-windows-rtl",
      theme: "light",
      width: 430,
      direction: "rtl",
      prefix: String.raw`\\?\C:\Portcove`,
    },
    {
      name: "extended-unc",
      theme: "dark",
      width: 430,
      direction: "ltr",
      prefix: String.raw`\\?\UNC\archive\games`,
    },
    {
      name: "posix",
      theme: "light",
      width: 430,
      direction: "ltr",
      prefix: "/home/player/Portcove",
    },
  ])(
    "keeps the $name path prefix with its value at $width",
    async ({ name, theme, width, direction, prefix }) => {
      const previousTheme = document.documentElement.dataset.theme;
      const previousDirection = document.documentElement.getAttribute("dir");
      const previousViewport = { width: innerWidth, height: innerHeight };
      const path =
        prefix + (name === "posix" ? "/" : "\\") + "RecordedOriginalGameFiles".repeat(10);
      document.documentElement.dataset.theme = theme;
      document.documentElement.setAttribute("dir", direction);
      await page.viewport(width, 780);
      try {
        vi.spyOn(desktopApi, "outputLocation").mockResolvedValue(defaultLocation("sample"));
        vi.mocked(desktopApi.previewOutputLocation).mockResolvedValue(
          destinationPreview("sample", path),
        );
        await render(<OutputLocationControl portId="sample" generation={7} />);
        await changePath(path);
        await click("Review future folder");
        await document.fonts.ready;
        const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
        const value = dialog?.querySelector<HTMLElement>("code");
        expect(value).not.toBeNull();
        expect(value!.textContent).toBe(path);
        expect(value!.title).toBe(path);
        expect(getComputedStyle(value!).direction).toBe("ltr");
        const bounds = value!.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(value!);
        const lines = [...range.getClientRects()];
        expect(lines.length).toBeGreaterThan(1);
        for (const line of lines) {
          expect(line.left).toBeGreaterThanOrEqual(bounds.left - 1);
          expect(line.right).toBeLessThanOrEqual(bounds.right + 1);
        }
        const selection = window.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
        expect(selection.toString()).toBe(path);
        selection.removeAllRanges();
        range.setStart(value!.firstChild!, 0);
        range.setEnd(value!.firstChild!, 16);
        expect(range.getClientRects().length).toBe(1);
        expect(dialog!.scrollWidth).toBeLessThanOrEqual(dialog!.clientWidth + 1);
        await captureParityState(`output-path-prefix-${name}`);
        const footer = dialog!.querySelector<HTMLElement>('[data-slot="dialog-footer"]')!;
        footer.scrollIntoView({ block: "center", behavior: "instant" });
        const actions = [...footer.querySelectorAll<HTMLButtonElement>("button")];
        expect(actions.map((action) => action.textContent)).toEqual([
          "Use this folder for future installs",
          "Cancel review",
        ]);
        const dialogBounds = dialog!.getBoundingClientRect();
        for (const action of actions) {
          const bounds = action.getBoundingClientRect();
          requireCompleteCaptureTarget(
            {
              target: action.textContent,
              target_count: 1,
              visible: action.checkVisibility(),
              rect: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
              viewport: { width: innerWidth, height: innerHeight },
            },
            action.textContent,
          );
          expect(bounds.left).toBeGreaterThanOrEqual(dialogBounds.left);
          expect(bounds.right).toBeLessThanOrEqual(dialogBounds.right);
          expect(bounds.top).toBeGreaterThanOrEqual(dialogBounds.top);
          expect(bounds.bottom).toBeLessThanOrEqual(dialogBounds.bottom);
        }
        if (width === 430) await captureParityState(`output-path-prefix-${name}-footer`);
      } finally {
        if (previousTheme === undefined) delete document.documentElement.dataset.theme;
        else document.documentElement.dataset.theme = previousTheme;
        if (previousDirection === null) document.documentElement.removeAttribute("dir");
        else document.documentElement.setAttribute("dir", previousDirection);
        await page.viewport(previousViewport.width, previousViewport.height);
      }
    },
  );

  it.each([
    ["owned_by_port", "Used by this game", false],
    ["owned_by_another_port", "Used by another game", true],
    ["unrelated_content", "Contains unrelated files", true],
    ["invalid", "Invalid destination", true],
    ["unknown", "Unknown", true],
  ] as const)("explains read-only folder suitability for %s", async (ownership, label, blocked) => {
    vi.spyOn(desktopApi, "outputLocation").mockResolvedValue(defaultLocation("sample"));
    vi.mocked(desktopApi.previewOutputLocation).mockResolvedValue(
      destinationPreview("sample", "F:/Games/Sample", { ownership }),
    );
    const apply = vi.spyOn(desktopApi, "setOutputLocation");
    const reset = vi.spyOn(desktopApi, "resetOutputLocation");
    const move = vi.spyOn(desktopApi, "relocateOutput");
    await render(<OutputLocationControl portId="sample" generation={7} />);
    const input = document.getElementById("output-location-path-sample")!;
    const note = input
      .getAttribute("aria-describedby")!
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent)
      .join(" ");
    expect(note).toContain("Portcove will check whether this folder can be used.");
    expect(note).toContain("Checking does not create or move files.");
    expect(document.body.textContent).toContain(label);
    await changePath("F:/Games/Sample");
    await click("Review future folder");
    const review = document.querySelector('[role="dialog"]');
    expect(review?.textContent).toContain(label);
    const checks = review?.querySelector(
      '[aria-label="Install folder review"] > [aria-live="polite"]',
    );
    expect(checks?.textContent).toContain(blocked ? "Needs attention" : "Checks passed");
    expect(checks?.textContent).not.toContain("Available");
    expect(button("Use this folder for future installs", review!).disabled).toBe(blocked);
    await click("Cancel review", review!);
    expect(apply).not.toHaveBeenCalled();
    expect(reset).not.toHaveBeenCalled();
    expect(move).not.toHaveBeenCalled();
  });

  it("keeps an available destination with validation problems refused in the review summary", async () => {
    vi.spyOn(desktopApi, "outputLocation").mockResolvedValue(defaultLocation("sample"));
    vi.mocked(desktopApi.previewOutputLocation).mockResolvedValue(
      destinationPreview("sample", "F:/Games/Sample", {
        validation_errors: ["destination overlaps the library"],
      }),
    );
    const apply = vi.spyOn(desktopApi, "setOutputLocation");
    await render(<OutputLocationControl portId="sample" generation={7} />);
    await changePath("F:/Games/Sample");
    await click("Review future folder");
    const review = document.querySelector('[role="dialog"]')!;
    const checks = review.querySelector(
      '[aria-label="Install folder review"] > [aria-live="polite"]',
    );
    expect(checks?.textContent).toContain("Needs attention");
    expect(checks?.textContent).not.toContain("Checks passed");
    expect(review.textContent).toContain("destination overlaps the library");
    expect(button("Use this folder for future installs", review).disabled).toBe(true);
    await click("Cancel review", review);
    expect(apply).not.toHaveBeenCalled();
  });

  it("distinguishes a pending folder read from failure and keeps loaded paths while editing after an error", async () => {
    const initial = deferred<PortOutputLocation>();
    const refusedRetry = deferred<PortOutputLocation>();
    const reloaded = deferred<PortOutputLocation>();
    const currentPath = "F:/Existing/Sample";
    const read = vi
      .spyOn(desktopApi, "outputLocation")
      .mockReturnValueOnce(initial.promise)
      .mockReturnValueOnce(refusedRetry.promise)
      .mockReturnValueOnce(reloaded.promise);
    const apply = vi.spyOn(desktopApi, "setOutputLocation");
    const reset = vi.spyOn(desktopApi, "resetOutputLocation");
    const move = vi.spyOn(desktopApi, "relocateOutput");
    const changed = vi.fn();
    await render(
      <OutputLocationControl
        portId="sample"
        generation={7}
        busy="Owned unrelated operation"
        onChanged={changed}
      />,
    );
    const readStatus = page.getByText("Loading current folder…", { exact: true }).element();
    const input = fixtureValue(container.querySelector("input"), "folder draft input");
    expect(readStatus.textContent).toBe("Loading current folder…");
    expect(input.disabled).toBe(true);
    await act(async () => {
      initial.reject(new Error("Current folder read failed"));
    });
    expect(readStatus.textContent).toBe("Current folder unavailable");
    expect(document.body.textContent).toContain("Current folder read failed");
    expect(input.disabled).toBe(true);
    expect(button("Review future folder").disabled).toBe(true);
    expect(desktopApi.previewOutputLocation).not.toHaveBeenCalled();

    const retry = button("Retry current folder");
    expect(retry.disabled).toBe(false);
    retry.focus();
    await click("Retry current folder");
    expect(read).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenLastCalledWith("sample", 7);
    expect(desktopApi.outputRelocationStatus).toHaveBeenCalledTimes(2);
    expect(desktopApi.outputRelocationStatus).toHaveBeenLastCalledWith("sample", 7);
    expect(button("Reading current folder…")).toBe(retry);
    expect(retry.getAttribute("aria-busy")).toBe("true");
    expect(retry.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(retry);
    await click("Reading current folder…");
    expect(read).toHaveBeenCalledTimes(2);
    expect(readStatus.textContent).toBe("Loading current folder…");
    expect(document.body.textContent).not.toContain("Current folder read failed");
    expect(input.disabled).toBe(true);
    await act(async () => {
      refusedRetry.reject(new Error("Retry read failed"));
    });
    expect(document.activeElement).toBe(retry);
    expect(button("Retry current folder")).toBe(retry);
    expect(readStatus.textContent).toBe("Current folder unavailable");
    expect(document.body.textContent).toContain("Retry read failed");
    await click("Retry current folder");
    expect(read).toHaveBeenCalledTimes(3);
    expect(read).toHaveBeenLastCalledWith("sample", 7);
    expect(desktopApi.outputRelocationStatus).toHaveBeenCalledTimes(3);
    expect(document.activeElement).toBe(retry);
    await act(async () => {
      reloaded.resolve(defaultLocation("sample", currentPath));
      await reloaded.promise;
    });
    const caption = fixtureValue(container.querySelector("code"), "loaded current folder path");
    expect(caption.textContent).toBe(currentPath);
    expect(document.activeElement).toBe(caption);
    expect(retry.isConnected).toBe(false);
    expect(input.disabled).toBe(true);
    await render(<OutputLocationControl portId="sample" generation={7} onChanged={changed} />);
    expect(read).toHaveBeenCalledTimes(3);
    expect(input.disabled).toBe(false);
    expect(input.value).toBe(currentPath);
    vi.mocked(desktopApi.previewOutputLocation).mockRejectedValueOnce(
      new Error("Folder review failed"),
    );
    await changePath("G:/Draft/Sample");
    await click("Review future folder");
    expect(document.body.textContent).toContain("Folder review failed");
    expect(caption.textContent).toBe(currentPath);
    expect(input.disabled).toBe(false);
    await changePath("H:/Revised/Sample");
    expect(input.value).toBe("H:/Revised/Sample");
    expect(document.body.textContent).not.toContain("Folder review failed");
    expect(caption.textContent).toBe(currentPath);
    expect(document.body.textContent).not.toContain("Loading current folder…");
    expect(button("Review future folder").disabled).toBe(false);
    expect(apply).not.toHaveBeenCalled();
    expect(reset).not.toHaveBeenCalled();
    expect(move).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
  });

  it("preserves a same-session draft and ignores a held read after the folder scope changes", async () => {
    const oldGeneration = deferred<PortOutputLocation>();
    const currentScope = deferred<PortOutputLocation>();
    const initialPath = "F:/Recorded/Sample";
    const draft = "G:/Unsubmitted/Sample";
    const stalePath = "H:/Departed/Sample";
    const currentPath = "I:/Recorded/Other";
    const read = vi
      .spyOn(desktopApi, "outputLocation")
      .mockResolvedValueOnce(defaultLocation("sample", initialPath))
      .mockReturnValueOnce(oldGeneration.promise)
      .mockReturnValueOnce(currentScope.promise);
    const changed = vi.fn();
    const applying = vi.fn();
    const replacementChanged = vi.fn();
    const replacementApplying = vi.fn();
    const expectLoading = () => {
      expect(page.getByText("Loading current folder…", { exact: true }).element().textContent).toBe(
        "Loading current folder…",
      );
      const input = fixtureValue(container.querySelector("input"), "new-session folder draft");
      expect(input.value).toBe("");
      expect(input.disabled).toBe(true);
      expect(container.querySelector("code")).toBeNull();
      expect(button("Review future folder").disabled).toBe(true);
    };
    try {
      await render(
        <OutputLocationControl
          portId="sample"
          generation={7}
          onChanged={changed}
          onApplying={applying}
        />,
      );
      await changePath(draft);
      await render(
        <OutputLocationControl
          portId="sample"
          generation={7}
          busy="Owned parent operation"
          onChanged={replacementChanged}
          onApplying={replacementApplying}
        />,
      );
      const sameSession = fixtureValue(
        container.querySelector("input"),
        "same-session folder draft",
      );
      expect(sameSession.value).toBe(draft);
      expect(sameSession.disabled).toBe(true);
      expect(read).toHaveBeenCalledExactlyOnceWith("sample", 7);
      expect(desktopApi.outputRelocationStatus).toHaveBeenCalledExactlyOnceWith("sample", 7);
      await render(
        <OutputLocationControl
          portId="sample"
          generation={7}
          onChanged={replacementChanged}
          onApplying={replacementApplying}
        />,
      );
      expect(sameSession.value).toBe(draft);
      expect(sameSession.disabled).toBe(false);
      expect(read).toHaveBeenCalledTimes(1);
      expect(desktopApi.previewOutputLocation).toHaveBeenCalledExactlyOnceWith(
        "sample",
        initialPath,
        7,
      );

      // No caller key: the public control owns the port/generation session boundary.
      await render(<OutputLocationControl portId="sample" generation={8} />);
      expectLoading();
      expect(document.body.textContent).not.toContain(initialPath);
      expect(read).toHaveBeenCalledTimes(2);
      expect(read).toHaveBeenLastCalledWith("sample", 8);
      await render(<OutputLocationControl portId="other" generation={8} />);
      expectLoading();
      expect(read).toHaveBeenCalledTimes(3);
      expect(read).toHaveBeenLastCalledWith("other", 8);
      await act(async () => {
        oldGeneration.resolve(defaultLocation("sample", stalePath));
        await oldGeneration.promise;
      });
      expectLoading();
      expect(document.body.textContent).not.toContain(stalePath);
      expect(read).toHaveBeenCalledTimes(3);
      expect(desktopApi.previewOutputLocation).toHaveBeenCalledTimes(1);
      await act(async () => {
        currentScope.resolve(defaultLocation("other", currentPath));
        await currentScope.promise;
      });
      expect(container.querySelector("code")?.textContent).toBe(currentPath);
      const currentInput = fixtureValue(
        container.querySelector("input"),
        "current-scope folder draft",
      );
      expect(currentInput.value).toBe(currentPath);
      expect(currentInput.disabled).toBe(false);
      expect(document.body.textContent).not.toContain(stalePath);
      expect(read.mock.calls).toEqual([
        ["sample", 7],
        ["sample", 8],
        ["other", 8],
      ]);
      expect(desktopApi.outputRelocationStatus).toHaveBeenCalledTimes(3);
      expect(desktopApi.previewOutputLocation).toHaveBeenCalledTimes(2);
      expect(desktopApi.previewOutputLocation).toHaveBeenLastCalledWith("other", currentPath, 8);
      expect(changed).not.toHaveBeenCalled();
      expect(replacementChanged).not.toHaveBeenCalled();
      expect(applying).not.toHaveBeenCalled();
      expect(replacementApplying).not.toHaveBeenCalled();
    } finally {
      // Release and join both owned reads even if an earlier assertion interrupts the case.
      await act(async () => {
        oldGeneration.resolve(defaultLocation("sample", stalePath));
        currentScope.resolve(defaultLocation("other", currentPath));
        await Promise.all([oldGeneration.promise, currentScope.promise]);
      });
    }
  });

  it("keeps keyboard focus outside the folder control when a held retry succeeds", async () => {
    const retried = deferred<PortOutputLocation>();
    const read = vi
      .spyOn(desktopApi, "outputLocation")
      .mockRejectedValueOnce(new Error("Initial read failed"))
      .mockReturnValueOnce(retried.promise);
    await render(<RetryFocusContext />);
    const retry = button("Retry current folder");
    retry.focus();
    await click("Retry current folder");
    await act(async () => userEvent.tab());
    const summary = fixtureValue(container.querySelector("summary"), "outside technical details");
    expect(document.activeElement).toBe(summary);
    await act(async () => {
      retried.resolve(defaultLocation("sample"));
      await retried.promise;
    });
    expect(document.activeElement).toBe(summary);
    expect(retry.isConnected).toBe(false);
    expect(container.querySelector("code")?.textContent).toBe(
      defaultLocation("sample").effective_output_directory,
    );
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("keeps pointer-chosen overlay focus when a held retry fails", async () => {
    const retried = deferred<PortOutputLocation>();
    const read = vi
      .spyOn(desktopApi, "outputLocation")
      .mockRejectedValueOnce(new Error("Initial read failed"))
      .mockReturnValueOnce(retried.promise);
    await render(<RetryFocusContext />);
    const retry = button("Retry current folder");
    retry.focus();
    await click("Retry current folder");
    await page.getByRole("button", { name: "Open read-only folder help", exact: true }).click();
    const help = page.getByRole("dialog", { name: "Read-only folder help", exact: true });
    await expect.element(help).toBeVisible();
    const keepReading = page.getByRole("button", { name: "Keep reading help", exact: true });
    await keepReading.click();
    expect(document.activeElement).toBe(keepReading.element());
    await act(async () => {
      retried.reject(new Error("Retry read failed"));
    });
    expect(document.activeElement).toBe(keepReading.element());
    expect(help.element().contains(document.activeElement)).toBe(true);
    expect(retry.isConnected).toBe(true);
    expect(
      page.getByText("Current folder unavailable", { exact: true }).element().textContent,
    ).toBe("Current folder unavailable");
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("keeps an invalid current destination selected without announcing passed checks", async () => {
    const custom = "F:/Games/Conflicting";
    vi.spyOn(desktopApi, "outputLocation").mockResolvedValue(defaultLocation("sample", custom));
    vi.mocked(desktopApi.previewOutputLocation).mockResolvedValue(
      currentDestinationPreview("sample", custom, {
        ownership: "invalid",
        available_bytes: null,
        total_bytes: null,
        validation_errors: ["destination overlaps the library"],
      }),
    );
    await render(<OutputLocationControl portId="sample" generation={7} />);
    const current = container.querySelector('[aria-label="Current install folder"]');
    expect(current?.querySelector('[aria-live="polite"]')?.textContent).toContain(
      "Needs attention",
    );
    expect(current?.textContent).toContain("Invalid destination");
    expect(current?.textContent).toContain("Capacity unavailable");
    expect(current?.textContent).toContain("This destination stays selected");
    expect(document.body.textContent).toContain(custom);
  });

  it("shows current destination availability and capacity without requiring a review", async () => {
    vi.spyOn(desktopApi, "outputLocation").mockResolvedValue(defaultLocation("sample"));

    await render(<OutputLocationControl portId="sample" generation={7} />);

    const current = container.querySelector('[aria-label="Current install folder"]');
    expect(current?.textContent).toContain("Current destination");
    expect(current?.textContent).toContain("Checks passed");
    expect(current?.textContent).toContain("8.0 GiB available of 16.0 GiB");
    await captureParityState("output-current-capacity-fixture");
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

    const current = container.querySelector('[aria-label="Current install folder"]');
    expect(current?.textContent).toContain("Unavailable");
    expect(current?.textContent).toContain("Capacity unavailable");
    expect(current?.textContent).toContain("selected drive is unavailable");
    expect(current?.textContent).toContain("This destination stays selected");
    expect(current?.textContent).toContain("Choose an available folder below");
    await captureParityState("output-current-unavailable-fixture");
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
    expect(document.body.textContent).toContain("Checks passed");
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
    for (let index = 0; index < Number(count); index++)
      expect(document.body.textContent).toContain(`E:/Portcove/old-${index}`);
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
    expect(document.body.textContent).toContain("Folder availability could not be confirmed");
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
    expect(document.body.textContent).toContain("Folder ownership could not be confirmed");
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
      expect(document.body.textContent).toContain("Folder ownership could not be confirmed");
      expect(document.body.textContent).toContain("Folder preference source unavailable");
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
      "Future installs use this folder by default. Existing versions will not move.",
    );
    const input = container.querySelector("input")!;
    expect(input.dataset.slot).toBe("input");
    expect(container.querySelector(`label[for="${input.id}"]`)?.textContent).toContain(
      "Folder for future installs",
    );
    const description = input
      .getAttribute("aria-describedby")!
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent)
      .join(" ");
    expect(description).toContain("Portcove will check whether this folder can be used.");
    expect(description).toContain("Checking does not create or move files.");
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
    await captureParityState("output-review-full-validation-fixture");
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
    await expect.poll(() => document.activeElement?.id).toBe("output-location-review-title");
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
    expect(fixtureValue(reset.mock.calls[0], "reset.mock.calls[0]")[0]).toBe("first");
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
    expect(document.body.textContent).toContain("1 remains at its recorded location");
    await captureParityState("output-review-one-existing-install");
    await click("Review moving existing versions");
    expect(reviewMove).toHaveBeenCalledWith("sample", "F:/Games/Sample", 14);
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
    await expect.poll(() => document.activeElement?.id).toBe("output-relocation-review-title");
    await pressEscape();
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    await click("Review future folder");
    await click("Review moving existing versions");
    expect(document.body.textContent).toContain("Original game filesStay at their saved locations");
    expect(document.body.textContent).toContain("Saves and backupsStay in their current folders");
    expect(document.body.textContent).toContain("active");
    await click("Move existing versions");
    expect(move).toHaveBeenCalledWith("sample", "F:/Games/Sample", "b".repeat(64), 14);
    expect(onApplying.mock.calls).toEqual([[true], [false]]);
    expect(document.body.textContent).toContain("Move completed");
    expect(document.body.textContent).toContain(affected.path);
    expect(document.activeElement).toBe(trigger);
    expect(document.body.textContent).toContain(
      "Move completed. 1 old folder contains changed files and remains for safe cleanup.",
    );
  });
});

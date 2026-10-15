import { render as renderComponent, cleanup, type RenderResult } from "vitest-browser-react";
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { desktopApi } from "../api";
import * as clipboard from "../clipboard";
import { portDefinition, portStatus } from "../test-fixtures";
import type { CliCommandContext, PortStatus } from "../types";
import { CliContinuity } from "./CliContinuity";

let root: RenderResult;
const context: CliCommandContext = {
  executable: "C:/Apps/portcove.exe",
  library_root: "E:/My library",
  platform: "windows-x86-64",
};
const props = {
  generation: 1,
  port: portDefinition(),
  channel: "stable" as const,
  sourcePath: "",
  biosPath: "",
};
beforeEach(async () => {
  vi.spyOn(desktopApi, "cliCommandContext").mockResolvedValue(context);
  vi.mocked(clipboard.copyText).mockResolvedValue();
  const host = document.createElement("div");
  document.body.append(host);
  root = await renderComponent(null, { container: document.body.appendChild(host) });
});
afterEach(async () => {
  await cleanup();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("copies an active launch using its selected library and separate argument array", async () => {
  const status = { ...portStatus(), active: { id: "active" } } as PortStatus;
  await root.rerender(<CliContinuity {...props} status={status} />);
  expect(document.body.textContent).toContain("Launch from another app");
  await act(async () =>
    document.querySelector<HTMLButtonElement>('[aria-label="Copy launch command"]')!.click(),
  );
  expect(clipboard.copyText).toHaveBeenCalledWith(
    expect.stringContaining("--library 'E:/My library' exec"),
  );
  await act(async () =>
    document.querySelector<HTMLButtonElement>('[aria-label="Copy argument array"]')!.click(),
  );
  expect(clipboard.copyText).toHaveBeenLastCalledWith(
    JSON.stringify(["--library", context.library_root, "exec", props.port.id, "--"]),
  );
});
it("labels unresolved setup templates and exposes clipboard failure", async () => {
  vi.mocked(desktopApi.cliCommandContext).mockResolvedValue({
    ...context,
    executable: null,
  });
  vi.mocked(clipboard.copyText).mockRejectedValue(new Error("unavailable"));
  await root.rerender(
    <CliContinuity {...props} port={{ ...props.port, source_profile: "source" }} />,
  );
  expect(document.body.textContent).toContain(
    "Template — replace: Portcove CLI executable, source-path",
  );
  expect(document.querySelector('[aria-label="Copy setup command"]')).toBeNull();
  await act(async () =>
    document.querySelector<HTMLButtonElement>('[aria-label="Copy command template"]')!.click(),
  );
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("Clipboard unavailable");
});
it("discards late command context from the previous library", async () => {
  let resolveOld!: (value: CliCommandContext) => void;
  vi.mocked(desktopApi.cliCommandContext).mockImplementation((generation) =>
    generation === 1
      ? new Promise((resolve) => {
          resolveOld = resolve;
        })
      : Promise.resolve({ ...context, library_root: "F:/Current" }),
  );
  await root.rerender(<CliContinuity {...props} />);
  await root.rerender(<CliContinuity {...props} generation={2} />);
  await act(async () => resolveOld(context));
  expect(document.body.textContent).toContain("F:/Current");
  expect(document.body.textContent).not.toContain("E:/My library");
});

it.each([false, true])(
  "explains compatible beta setup syntax when CLI support is unproven (template=%s)",
  async (template) => {
    if (template)
      vi.mocked(desktopApi.cliCommandContext).mockResolvedValue({ ...context, executable: null });
    await root.rerender(<CliContinuity {...props} channel="beta" />);
    expect(document.body.textContent).toContain("beta selects Preview");
    expect(document.body.textContent).toContain("preview input support has not been verified");
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>(
          `[aria-label="${template ? "Copy command template" : "Copy setup command"}"]`,
        )!
        .click(),
    );
    expect(clipboard.copyText).toHaveBeenLastCalledWith(expect.stringContaining("--channel beta"));
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[aria-label="Copy argument array"]')!.click(),
    );
    expect(JSON.parse(vi.mocked(clipboard.copyText).mock.calls.at(-1)![0])).toContain("beta");
    await root.rerender(<CliContinuity {...props} channel="stable" />);
    expect(document.body.textContent).not.toContain("beta selects Preview");
    await root.rerender(
      <CliContinuity
        {...props}
        channel="beta"
        status={{ ...portStatus(), active: { id: "active" } } as PortStatus}
      />,
    );
    expect(document.body.textContent).not.toContain("beta selects Preview");
  },
);

vi.mock("../clipboard", { spy: true });

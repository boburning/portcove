// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { desktopApi } from "../api";
import * as clipboard from "../clipboard";
import { portDefinition, portStatus } from "../test-fixtures";
import type { CliCommandContext, PortStatus } from "../types";
import { CliContinuity } from "./CliContinuity";

let root: Root;
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
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(desktopApi, "cliCommandContext").mockResolvedValue(context);
  vi.spyOn(clipboard, "copyText").mockResolvedValue();
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("copies an active launch using its selected library and separate argument array", async () => {
  const status = { ...portStatus(), active: { id: "active" } } as PortStatus;
  await act(async () =>
    root.render(<CliContinuity {...props} status={status} />),
  );
  expect(document.body.textContent).toContain("Launch from another app");
  await act(async () =>
    document
      .querySelector<HTMLButtonElement>('[aria-label="Copy launch command"]')!
      .click(),
  );
  expect(clipboard.copyText).toHaveBeenCalledWith(
    expect.stringContaining("--library 'E:/My library' exec"),
  );
  await act(async () =>
    document
      .querySelector<HTMLButtonElement>('[aria-label="Copy argument array"]')!
      .click(),
  );
  expect(clipboard.copyText).toHaveBeenLastCalledWith(
    JSON.stringify([
      "--library",
      context.library_root,
      "exec",
      props.port.id,
      "--",
    ]),
  );
});
it("labels unresolved setup templates and exposes clipboard failure", async () => {
  vi.mocked(desktopApi.cliCommandContext).mockResolvedValue({
    ...context,
    executable: null,
  });
  vi.mocked(clipboard.copyText).mockRejectedValue(new Error("unavailable"));
  await act(async () =>
    root.render(
      <CliContinuity
        {...props}
        port={{ ...props.port, source_profile: "source" }}
      />,
    ),
  );
  expect(document.body.textContent).toContain(
    "Template — replace: Portcove CLI executable, source-path",
  );
  expect(
    document.querySelector('[aria-label="Copy setup command"]'),
  ).toBeNull();
  await act(async () =>
    document
      .querySelector<HTMLButtonElement>('[aria-label="Copy command template"]')!
      .click(),
  );
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    "Clipboard unavailable",
  );
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
  await act(async () => root.render(<CliContinuity {...props} />));
  await act(async () =>
    root.render(<CliContinuity {...props} generation={2} />),
  );
  await act(async () => resolveOld(context));
  expect(document.body.textContent).toContain("F:/Current");
  expect(document.body.textContent).not.toContain("E:/My library");
});

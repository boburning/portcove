import { controlledAct as act } from "../../test/controlled-react-act";
import { render as renderComponent, cleanup, type RenderResult } from "vitest-browser-react";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { desktopApi } from "../api";
import type { PortStatus, RuntimePrerequisiteReport } from "../types";
import { RuntimePrerequisiteNotice } from "./RuntimePrerequisiteNotice";
import { captureParityState } from "../../test/parity-capture";
import { browserFixture } from "../../test/browser-fixture";
import "../styles/index.css";

const VISUAL_CPP = "https://learn.microsoft.com/cpp/windows/latest-supported-vc-redist";
const DIRECTX = "https://www.microsoft.com/download/details.aspx?id=35";

function report(
  presence: "present" | "missing" | "unknown",
  host: "checked" | "not_windows" = "checked",
): RuntimePrerequisiteReport {
  return {
    inspection: "complete",
    host,
    requirements: [
      {
        runtime: "visual_cpp_2015_or_later",
        architecture: "x64",
        presence: "present",
        files: ["vcruntime140.dll"],
        download_page: VISUAL_CPP,
      },
      {
        runtime: "directx_june_2010",
        architecture: "x86",
        presence,
        files: ["d3dx9_43.dll"],
        ...(presence === "missing" ? { missing_files: ["d3dx9_43.dll"] } : {}),
        download_page: DIRECTX,
      },
      {
        runtime: "dotnet",
        architecture: "x64",
        framework: { name: "Microsoft.WindowsDesktop.App", version: "8.0.0" },
        presence,
        download_page: "https://dotnet.microsoft.com/download/dotnet/8.0",
      },
    ],
  };
}

const installed = { active: { id: "i1" } } as unknown as PortStatus;
let root: RenderResult;
let container: HTMLDivElement;
let fixture: ReturnType<typeof browserFixture>;
beforeEach(async () => {
  fixture = browserFixture({ viewport: true, attributes: ["data-theme"] });
  container = document.createElement("div");
  document.body.append(container);
  root = await renderComponent(null, { container: document.body.appendChild(container) });
});
afterEach(async () => {
  await cleanup();
  container.remove();
  vi.restoreAllMocks();
  await fixture.dispose();
});

async function show(load: () => Promise<RuntimePrerequisiteReport | null>, status?: PortStatus) {
  await act(async () => {
    await root.rerender(
      <RuntimePrerequisiteNotice portId="p" generation={1} status={status} load={load} />,
    );
  });
}
const notice = () => document.body.querySelector("[data-runtime-prerequisites]");

it("names only the runtimes Core reports missing, with Microsoft's download page", async () => {
  const load = vi.fn().mockResolvedValue(report("missing"));
  await show(load, installed);
  expect(load).toHaveBeenCalledWith("p", "i1", 1);
  const text = notice()?.textContent ?? "";
  expect(text).toContain("Windows is most likely missing something this game needs to start");
  expect(text).toContain("DirectX End-User Runtime (June 2010) (x86)");
  expect(text).toContain(".NET Desktop Runtime 8.0.0 (x64)");
  expect(text).not.toContain("Visual C++");
  const links = [...(notice()?.querySelectorAll("a") ?? [])].map((link) =>
    link.getAttribute("href"),
  );
  expect(links).toEqual([DIRECTX, "https://dotnet.microsoft.com/download/dotnet/8.0"]);
});

it("opens the download page through the reviewed external-link route", async () => {
  const open = vi.spyOn(desktopApi, "openExternalUrl").mockResolvedValue(undefined);
  await show(() => Promise.resolve(report("missing")), installed);
  await act(async () => (notice()?.querySelector("a") as HTMLAnchorElement | null)?.click());
  expect(open).toHaveBeenCalledWith(DIRECTX);
});

it.each([
  ["installed runtimes", () => Promise.resolve(report("present"))],
  ["runtimes Portcove could not check", () => Promise.resolve(report("unknown"))],
  ["a host that is not Windows", () => Promise.resolve(report("unknown", "not_windows"))],
  ["no installation report", () => Promise.resolve(null)],
  ["a failed read", () => Promise.reject(new Error("down"))],
])("shows nothing for %s", async (_name, load) => {
  await show(load, installed);
  expect(notice()).toBeNull();
});

it("reads nothing without a current installation and follows an external registration", async () => {
  const load = vi.fn().mockResolvedValue(report("missing"));
  await show(load, undefined);
  await show(load, { active: null } as unknown as PortStatus);
  expect(load).not.toHaveBeenCalled();
  expect(notice()).toBeNull();
  await show(load, { external_runtime: { id: "e1" } } as unknown as PortStatus);
  expect(notice()).not.toBeNull();
  expect(load).toHaveBeenLastCalledWith("p", "e1", 1);
});

it("does not re-read program files when only the status object refreshes", async () => {
  const load = vi.fn().mockResolvedValue(report("missing"));
  await show(load, { active: { id: "i1" } } as unknown as PortStatus);
  await show(load, { active: { id: "i1" }, channel: "stable" } as unknown as PortStatus);
  expect(load).toHaveBeenCalledOnce();
});

it.each([
  { width: 960, theme: "dark" },
  { width: 430, theme: "light" },
])(
  "rechecks the same installation without naming a launch label at $width px in $theme",
  async ({ width, theme }) => {
    await page.viewport(width, width < 600 ? 780 : 800);
    document.documentElement.dataset.theme = theme;
    const load = vi
      .fn()
      .mockResolvedValueOnce(report("missing"))
      .mockRejectedValueOnce(new Error("unavailable"))
      .mockResolvedValueOnce(report("unknown"))
      .mockResolvedValueOnce({ ...report("present"), inspection: "partial" })
      .mockResolvedValueOnce(report("present"));
    await show(load, installed);

    const recheck = async () => {
      const button = notice()?.querySelector("button");
      if (!button) throw new Error("Expected the runtime recheck button");
      await act(async () => button.click());
    };
    await recheck();
    expect(notice()?.textContent).toContain("could not confirm");
    await recheck();
    expect(notice()?.textContent).toContain("could not confirm");
    await recheck();
    expect(notice()?.textContent).toContain("could not confirm");
    await recheck();
    expect(load.mock.calls).toEqual(Array.from({ length: 5 }, () => ["p", "i1", 1]));
    expect(notice()?.querySelector("p")?.textContent).toBe("The checked runtimes are installed.");
    expect(notice()?.querySelector("a")).toBeNull();
    await captureParityState("runtime-recheck-present-action-neutral");
  },
);

it("never shows a report for an installation that is no longer current", async () => {
  let resolveFirst: (value: RuntimePrerequisiteReport) => void = () => {};
  const load = vi
    .fn<() => Promise<RuntimePrerequisiteReport | null>>()
    .mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve)))
    .mockResolvedValueOnce(report("present"));
  await show(load, installed);
  await show(load, { active: { id: "i2" } } as unknown as PortStatus);
  await act(async () => resolveFirst(report("missing")));
  expect(notice()).toBeNull();
});

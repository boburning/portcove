// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { desktopApi } from "../api";
import { portStatus } from "../test-fixtures";
import type { GameUpdatePlan } from "../types";
import type { Perform } from "../use-portcove";
import { GameUpdateControl, UpdatePolicyControl } from "./GameUpdates";

const plan: GameUpdatePlan = {
  activate: false,
  plan_sha256: "reviewed-download",
  plan: {
    bundled_runtime: null,
    port_id: "sample",
    channel: "stable",
    platform: "windows-x86-64",
    action: "download",
    source_requirements: [],
    download_bytes: 1024,
    release: {
      published_at: null,
      version: "2.0",
      channel: "stable",
      asset: {
        name: "sample.zip",
        url: "https://example.com/sample.zip",
        size: 1024,
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
  },
};
const perform: Perform = async (_name, task) => task();
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
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
async function click(label: string, contains = false) {
  const button = [...document.querySelectorAll("button")].find((button) =>
    contains ? button.textContent?.includes(label) : button.textContent === label,
  );
  expect(button).toBeDefined();
  await act(async () => button?.click());
}

it("edits locally until Save and never reviews or runs an update when saving", async () => {
  const save = vi.fn().mockResolvedValue({ ...portStatus(), update_policy: "automatic" });
  const review = vi.spyOn(desktopApi, "planGameUpdate");
  const apply = vi.spyOn(desktopApi, "applyGameUpdate");
  await act(async () =>
    root.render(<UpdatePolicyControl policy="notify" busy={false} save={save} />),
  );
  await click("Saved update policy", true);
  await click("Install when running updates");
  expect(save).not.toHaveBeenCalled();
  await click("Save update settings");
  expect(save).toHaveBeenCalledExactlyOnceWith("automatic");
  expect(review).not.toHaveBeenCalled();
  expect(apply).not.toHaveBeenCalled();
  expect(container.textContent).toContain("No update was run");
});

it("does not report a settings save as successful after failure", async () => {
  const save = vi.fn().mockRejectedValue(new Error("Library changed"));
  await act(async () =>
    root.render(<UpdatePolicyControl policy="notify" busy={false} save={save} />),
  );
  await click("Saved update policy", true);
  await click("Download for later");
  await click("Save update settings");
  expect(container.textContent).toContain("Library changed");
  expect(container.textContent).not.toContain("settings saved");
});

it("reviews without execution and submits the exact download-only plan on confirmation", async () => {
  vi.spyOn(desktopApi, "planGameUpdate").mockResolvedValue(plan);
  const apply = vi.spyOn(desktopApi, "applyGameUpdate").mockResolvedValue(undefined!);
  await act(async () =>
    root.render(
      <GameUpdateControl
        portId="sample"
        generation={9}
        policy="notify"
        busy={false}
        perform={perform}
      />,
    ),
  );
  await click("Review game update");
  expect(apply).not.toHaveBeenCalled();
  expect(desktopApi.planGameUpdate).toHaveBeenCalledExactlyOnceWith("sample", false, 9);
  expect(container.textContent).toContain("active version stays unchanged");
  await click("Download update for later");
  expect(apply).toHaveBeenCalledExactlyOnceWith(
    "sample",
    false,
    "reviewed-download",
    9,
    expect.any(Function),
  );
  expect(container.textContent).toContain("Review game update");
});

it("requires another review when the chosen action changes and binds activation to that review", async () => {
  vi.spyOn(desktopApi, "planGameUpdate")
    .mockResolvedValueOnce(plan)
    .mockResolvedValueOnce({
      ...plan,
      activate: true,
      plan_sha256: "reviewed-activation",
    });
  const apply = vi
    .spyOn(desktopApi, "applyGameUpdate")
    .mockRejectedValue(new Error("Release changed"));
  await act(async () =>
    root.render(
      <GameUpdateControl
        portId="sample"
        generation={9}
        policy="notify"
        busy={false}
        perform={perform}
      />,
    ),
  );
  await click("Review game update");
  await click("This update", true);
  await click("Install after download");
  expect(container.textContent).not.toContain("2.0");
  expect(apply).not.toHaveBeenCalled();
  await click("Review game update");
  await click("Download and install update");
  expect(apply).toHaveBeenCalledExactlyOnceWith(
    "sample",
    true,
    "reviewed-activation",
    9,
    expect.any(Function),
  );
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Release changed");
  expect(container.textContent).toContain("Review game update");
});

it("discards a late update review after switching the selected library", async () => {
  let complete!: (value: GameUpdatePlan) => void;
  vi.spyOn(desktopApi, "planGameUpdate").mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  await act(async () =>
    root.render(
      <GameUpdateControl
        key="old"
        portId="sample"
        generation={9}
        policy="notify"
        busy={false}
        perform={perform}
      />,
    ),
  );
  await click("Review game update");
  await act(async () =>
    root.render(
      <GameUpdateControl
        key="new"
        portId="sample"
        generation={10}
        policy="notify"
        busy={false}
        perform={perform}
      />,
    ),
  );
  await act(async () => complete(plan));
  expect(container.textContent).not.toContain("2.0");
});

it.each(["future_action", "constructor", "__proto__", "toString"])(
  "rejects an unfamiliar update action %s before execution and supports a fresh review",
  async (action) => {
    vi.spyOn(desktopApi, "planGameUpdate")
      .mockResolvedValueOnce({
        ...plan,
        plan: {
          ...plan.plan,
          action: action as GameUpdatePlan["plan"]["action"],
        },
      })
      .mockResolvedValueOnce(plan);
    const apply = vi.spyOn(desktopApi, "applyGameUpdate").mockResolvedValue(undefined!);
    await act(async () =>
      root.render(
        <GameUpdateControl
          portId="sample"
          generation={9}
          policy="notify"
          busy={false}
          perform={perform}
        />,
      ),
    );
    await click("Review game update");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "cannot display this update plan",
    );
    expect(container.textContent).not.toContain("verified local release");
    expect(container.querySelector(".install-plan button.primary")).toBeNull();
    expect(apply).not.toHaveBeenCalled();
    await click("Review game update again");
    expect(container.querySelector('[role="alert"]')).toBeNull();
    await click("Download update for later");
    expect(apply).toHaveBeenCalledExactlyOnceWith(
      "sample",
      false,
      "reviewed-download",
      9,
      expect.any(Function),
    );
  },
);

it.each(["already_active", "blocked_unverified"] as const)(
  "does not submit the recognized non-executable update action %s",
  async (action) => {
    vi.spyOn(desktopApi, "planGameUpdate").mockResolvedValue({
      ...plan,
      plan: { ...plan.plan, action },
    });
    const apply = vi.spyOn(desktopApi, "applyGameUpdate");
    await act(async () =>
      root.render(
        <GameUpdateControl
          portId="sample"
          generation={9}
          policy="notify"
          busy={false}
          perform={perform}
        />,
      ),
    );
    await click("Review game update");
    expect(container.querySelector(".install-plan button.primary")).toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      action === "already_active" ? "already active" : "unverified local copy",
    );
    expect(apply).not.toHaveBeenCalled();
  },
);

it.each(["use_staged", "reuse_retained"] as const)(
  "retains exact confirmation for the verified local action %s",
  async (action) => {
    vi.spyOn(desktopApi, "planGameUpdate").mockResolvedValue({
      ...plan,
      plan_sha256: `reviewed-${action}`,
      plan: { ...plan.plan, action },
    });
    const apply = vi.spyOn(desktopApi, "applyGameUpdate").mockResolvedValue(undefined!);
    await act(async () =>
      root.render(
        <GameUpdateControl
          portId="sample"
          generation={9}
          policy="notify"
          busy={false}
          perform={perform}
        />,
      ),
    );
    await click("Review game update");
    expect(apply).not.toHaveBeenCalled();
    await click("Stage verified update for later");
    expect(apply).toHaveBeenCalledExactlyOnceWith(
      "sample",
      false,
      `reviewed-${action}`,
      9,
      expect.any(Function),
    );
  },
);

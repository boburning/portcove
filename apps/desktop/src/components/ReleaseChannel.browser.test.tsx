import { controlledAct as act } from "../../test/controlled-react-act";
import { render as renderComponent, cleanup, type RenderResult } from "vitest-browser-react";
import { fixtureValue } from "../test-fixtures";

import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { portStatus } from "../test-fixtures";
import type { PortStatus, ReleaseChannel } from "../types";
import { ReleaseChannelControl } from "./ReleaseChannel";

let root: RenderResult;
let container: HTMLDivElement;
beforeEach(async () => {
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
async function openChannelSelect() {
  const trigger = container.querySelector<HTMLButtonElement>('[data-slot="select-trigger"]');
  expect(trigger).not.toBeNull();
  await act(async () => trigger?.click());
}
async function chooseChannel(text: string) {
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (item) => item.textContent === text,
  );
  expect(option).toBeDefined();
  await act(async () => option?.click());
}
const saved = { ...portStatus(), channel: "rolling" as const };

it.each([false, true])(
  "preserves a user's moved focus after a pending channel save (blur=%s)",
  async (blur) => {
    let resolve!: (value: PortStatus) => void;
    const change = vi.fn(
      () =>
        new Promise<PortStatus>((done) => {
          resolve = done;
        }),
    );
    await root.rerender(
      <>
        <ReleaseChannelControl
          channels={["stable", "rolling"]}
          selected="stable"
          busy={false}
          change={change}
          refresh={vi.fn().mockResolvedValue(true)}
        />
        <button id="elsewhere">Elsewhere</button>
      </>,
    );
    const trigger = container.querySelector<HTMLButtonElement>('[data-slot="select-trigger"]')!;
    await userEvent.click(trigger);
    await expect
      .poll(() => document.activeElement?.matches('[role="option"][aria-selected="true"]'))
      .toBe(true);
    const rolling = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (option) => option.textContent === "Rolling",
    )!;
    await userEvent.keyboard("{ArrowDown}");
    await expect.poll(() => document.activeElement).toBe(rolling);
    await userEvent.keyboard("{Enter}");
    await expect.poll(() => trigger.disabled).toBe(true);
    await expect
      .poll(
        () => document.querySelector('[data-slot="select-content"]')?.getClientRects().length ?? 0,
      )
      .toBe(0);
    const focus = vi.spyOn(trigger, "focus");
    const elsewhere = container.querySelector<HTMLButtonElement>("#elsewhere")!;
    elsewhere.focus();
    expect(document.activeElement).toBe(elsewhere);
    if (blur) elsewhere.blur();
    const intended = blur ? document.body : elsewhere;
    expect(document.activeElement).toBe(intended);
    await act(async () => resolve(saved));
    await expect.poll(() => trigger.disabled).toBe(false);
    // Observe the next browser focus frame as well as the React completion commit.
    await new Promise<void>((done) => requestAnimationFrame(() => done()));
    expect(focus).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(intended);
    expect(change).toHaveBeenCalledTimes(1);
  },
);

it.each(["stable", "beta", "rolling"] as ReleaseChannel[])(
  "renders %s-only availability without a selector or mutation",
  async (channel) => {
    const change = vi.fn();
    const refresh = vi.fn();
    await root.rerender(
      <ReleaseChannelControl
        channels={[channel]}
        selected={channel}
        busy={false}
        change={change}
        refresh={refresh}
      />,
    );
    expect(container.textContent).toContain(
      `${channel === "beta" ? "Preview" : fixtureValue(channel[0], "channel[0]").toUpperCase() + channel.slice(1)} only`,
    );
    expect(container.querySelector("button")).toBeNull();
    expect(change).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  },
);

it("keeps a busy selector disabled", async () => {
  await root.rerender(
    <ReleaseChannelControl
      channels={["stable", "rolling"]}
      selected="stable"
      busy
      change={vi.fn()}
      refresh={vi.fn()}
    />,
  );
  expect(container.querySelector<HTMLButtonElement>('[data-slot="select-trigger"]')?.disabled).toBe(
    true,
  );
  expect(container.querySelector('[data-slot="select-value"]')?.textContent).toBe("Stable");
});

it("portals choices and restores trigger focus after Escape", async () => {
  const backgroundEscape = vi.fn();
  window.addEventListener("keydown", backgroundEscape);
  await root.rerender(
    <ReleaseChannelControl
      channels={["stable", "rolling"]}
      selected="stable"
      busy={false}
      change={vi.fn()}
      refresh={vi.fn()}
    />,
  );
  const trigger = container.querySelector<HTMLButtonElement>('[data-slot="select-trigger"]');
  await openChannelSelect();
  const popup = document.querySelector<HTMLElement>('[data-slot="select-content"]');
  expect(popup).not.toBeNull();
  expect(container.contains(popup)).toBe(false);
  await act(async () => {
    popup?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  const closedPopup = document.querySelector<HTMLElement>('[data-slot="select-content"]');
  expect(closedPopup === null || closedPopup.hasAttribute("data-closed")).toBe(true);
  expect(document.querySelector('[data-slot="select-content"][data-open]')).toBeNull();
  await expect.poll(() => document.activeElement).toBe(trigger);
  expect(backgroundEscape).not.toHaveBeenCalled();
  window.removeEventListener("keydown", backgroundEscape);
});

it.each(["rolling", "beta"] as const)(
  "saves a real %s choice before refreshing release data",
  async (next) => {
    const calls: string[] = [];
    const change = vi.fn(async () => {
      calls.push("save");
      return { ...saved, channel: next };
    });
    const refresh = vi.fn(async () => {
      calls.push("check");
      return {};
    });
    await root.rerender(
      <ReleaseChannelControl
        channels={["stable", next]}
        selected="stable"
        busy={false}
        change={change}
        refresh={refresh}
      />,
    );
    await openChannelSelect();
    await chooseChannel(next === "rolling" ? "Rolling" : "Preview");
    expect(change).toHaveBeenCalledExactlyOnceWith(next);
    expect(calls).toEqual(["save", "check"]);
    expect(container.textContent).toContain("Release information refreshed");
  },
);

it("keeps failed metadata refresh distinct from a saved channel", async () => {
  const change = vi.fn().mockResolvedValue(saved);
  const refresh = vi.fn().mockResolvedValue(undefined);
  await root.rerender(
    <ReleaseChannelControl
      channels={["stable", "rolling"]}
      selected="stable"
      busy={false}
      change={change}
      refresh={refresh}
    />,
  );
  await openChannelSelect();
  await chooseChannel("Rolling");
  expect(container.textContent).toContain(
    "Rolling saved. Release information could not be refreshed",
  );
});

it("does not refresh after an unsuccessful save and exposes retry state", async () => {
  const change = vi.fn().mockResolvedValue(undefined);
  const refresh = vi.fn();
  await root.rerender(
    <ReleaseChannelControl
      channels={["stable", "rolling"]}
      selected="stable"
      busy={false}
      change={change}
      refresh={refresh}
    />,
  );
  await openChannelSelect();
  await chooseChannel("Rolling");
  expect(refresh).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Channel change was not confirmed");
  expect(container.querySelector<HTMLButtonElement>('[data-slot="select-trigger"]')?.disabled).toBe(
    false,
  );
});

it("disables choices while saving and ignores completion from an old library", async () => {
  let resolve!: (value: PortStatus) => void;
  const change = vi.fn(
    () =>
      new Promise<PortStatus>((done) => {
        resolve = done;
      }),
  );
  const refresh = vi.fn();
  await root.rerender(
    <ReleaseChannelControl
      key="library-1"
      channels={["stable", "rolling"]}
      selected="stable"
      busy={false}
      change={change}
      refresh={refresh}
    />,
  );
  await openChannelSelect();
  await chooseChannel("Rolling");
  expect(container.querySelector<HTMLButtonElement>('[data-slot="select-trigger"]')?.disabled).toBe(
    true,
  );
  await root.rerender(
    <ReleaseChannelControl
      key="library-2"
      channels={["stable", "rolling"]}
      selected="stable"
      busy={false}
      change={change}
      refresh={refresh}
    />,
  );
  await act(async () => resolve(saved));
  expect(refresh).not.toHaveBeenCalled();
  expect(container.textContent).not.toContain("Rolling selected");
});

it.each([
  {
    channels: [] as ReleaseChannel[],
    selected: "beta" as ReleaseChannel,
    label: "Preview",
    reason: "information is unavailable",
  },
  {
    channels: ["stable"] as ReleaseChannel[],
    selected: "beta" as ReleaseChannel,
    label: "Preview",
    reason: "not offered",
  },
  {
    channels: ["stable"] as ReleaseChannel[],
    selected: "future-channel" as ReleaseChannel,
    label: "Unknown channel",
    reason: "not recognized",
  },
])(
  "retains $selected visibly when choices are unavailable",
  async ({ channels, selected, label, reason }) => {
    const change = vi.fn();
    const refresh = vi.fn();
    await root.rerender(
      <ReleaseChannelControl
        channels={channels}
        selected={selected}
        busy={false}
        change={change}
        refresh={refresh}
      />,
    );
    expect(container.textContent).toContain(`Selected channel: ${label}`);
    expect(container.textContent).toContain(reason);
    expect(container.textContent).toContain("Your saved choice has not changed");
    expect(container.querySelector("button")).toBeNull();
    expect(change).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("future-channel");
  },
);

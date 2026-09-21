// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ChoiceSelect } from "./ChoiceSelect";

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("keeps a portaled choice inside its parent dialog dismissal boundary", async () => {
  const change = vi.fn();
  const backgroundEscape = vi.fn();
  window.addEventListener("keydown", backgroundEscape);
  await act(async () =>
    root.render(
      <section role="dialog" aria-modal="true" aria-label="Update review">
        <ChoiceSelect
          label="Update policy"
          value="notify"
          onChange={change}
          options={[
            { value: "notify", label: "Notify me" },
            { value: "stage", label: "Download for later" },
          ]}
        />
      </section>,
    ),
  );
  const trigger = host.querySelector<HTMLButtonElement>('[data-slot="select-trigger"]');
  expect(trigger?.textContent).toContain("Update policy");
  expect(trigger?.textContent).toContain("Notify me");
  await act(async () => trigger?.click());
  const popup = document.querySelector<HTMLElement>('[data-slot="select-content"][data-open]');
  expect(popup).not.toBeNull();
  expect(host.contains(popup)).toBe(false);
  await act(async () => {
    popup?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  const closedPopup = document.querySelector<HTMLElement>('[data-slot="select-content"]');
  expect(closedPopup === null || closedPopup.hasAttribute("data-closed")).toBe(true);
  expect(document.querySelector('[data-slot="select-content"][data-open]')).toBeNull();
  expect(document.activeElement).toBe(trigger);
  expect(backgroundEscape).not.toHaveBeenCalled();
  expect(host.querySelector('[role="dialog"]')).not.toBeNull();

  await act(async () => trigger?.click());
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (item) => item.textContent === "Download for later",
  );
  await act(async () => option?.click());
  expect(change).toHaveBeenCalledExactlyOnceWith("stage");
  expect(document.activeElement).toBe(trigger);
  window.removeEventListener("keydown", backgroundEscape);
});

it("does not expose an unfamiliar stored value as player-facing copy", async () => {
  await act(async () =>
    root.render(
      <ChoiceSelect
        label="Update policy"
        value={"future-policy" as "notify"}
        onChange={vi.fn()}
        options={[{ value: "notify", label: "Notify me" }]}
      />,
    ),
  );
  const trigger = host.querySelector<HTMLButtonElement>('[data-slot="select-trigger"]');
  expect(trigger?.textContent).toContain("Unavailable");
  expect(trigger?.textContent).not.toContain("future-policy");
});

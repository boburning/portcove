import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { ChoiceSelect } from "../components/ChoiceSelect";
import "../styles/index.css";

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

it("keeps a portaled choice inside its parent dialog dismissal boundary", async () => {
  const change = vi.fn();
  const backgroundEscape = vi.fn();
  window.addEventListener("keydown", backgroundEscape);
  try {
    flushSync(() =>
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
    const trigger = page.getByRole("combobox", { name: "Update policy Notify me" });
    await trigger.click();
    const option = page.getByRole("option", { name: "Download for later", exact: true });
    await expect.element(option).toBeVisible();
    expect(host.contains(option.element())).toBe(false);
    await userEvent.keyboard("{Escape}");
    await expect.element(option).not.toBeInTheDocument();
    await expect.element(trigger).toHaveFocus();
    expect(backgroundEscape).not.toHaveBeenCalled();
    await expect.element(page.getByRole("dialog", { name: "Update review" })).toBeVisible();
    await trigger.click();
    await option.click();
    expect(change).toHaveBeenCalledExactlyOnceWith("stage");
    await expect.element(trigger).toHaveFocus();
  } finally {
    window.removeEventListener("keydown", backgroundEscape);
  }
});

it("does not expose an unfamiliar stored value as player-facing copy", async () => {
  flushSync(() =>
    root.render(
      <ChoiceSelect
        label="Update policy"
        value={"future-policy" as "notify"}
        onChange={vi.fn()}
        options={[{ value: "notify", label: "Notify me" }]}
      />,
    ),
  );
  const trigger = page.getByRole("combobox");
  await expect.element(trigger).toHaveAccessibleName("Update policy Unavailable");
  await expect.element(trigger).not.toHaveTextContent("future-policy");
});

it("retains a complete long selected label while disabled without changing its value", async () => {
  const label = "Pikmin USA Rev. 1 or Europe disc; Open Nectar checks it during preparation.";
  const change = vi.fn();
  flushSync(() =>
    root.render(
      <ChoiceSelect
        label="Required files"
        value="pikmin"
        disabled
        onChange={change}
        options={[{ value: "pikmin", label }]}
      />,
    ),
  );
  const trigger = page.getByRole("combobox");
  await expect.element(trigger).toBeDisabled();
  await expect.element(trigger).toHaveAccessibleName(`Required files ${label}`);
  expect(change).not.toHaveBeenCalled();
  await expect.element(page.getByRole("listbox")).not.toBeInTheDocument();
});

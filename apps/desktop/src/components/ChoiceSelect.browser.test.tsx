import { useState } from "react";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react";
import { ChoiceSelect } from "./ChoiceSelect";

afterEach(cleanup);

it("keeps the inline label and selected count named while using closed-trigger typeahead", async () => {
  const changed = vi.fn();
  function Fixture() {
    const [value, setValue] = useState("all");
    return (
      <ChoiceSelect
        inline
        label="Readiness"
        value={value}
        options={[
          { value: "all", label: "All (12)" },
          { value: "ready", label: "Ready (9)" },
        ]}
        onChange={(next) => {
          changed(next);
          setValue(next);
        }}
      />
    );
  }
  await render(<Fixture />);
  const trigger = page.getByRole("combobox", { name: "Readiness All (12)" });
  await userEvent.tab();
  await expect.element(trigger).toHaveFocus();
  await expect.poll(() => document.querySelectorAll('[role="option"]').length).toBe(2);
  await userEvent.keyboard("r");
  await expect.element(page.getByRole("combobox", { name: "Readiness Ready (9)" })).toHaveFocus();
  expect(changed).toHaveBeenCalledExactlyOnceWith("ready");
});

it("does not turn a held unmatched key into a preference change when the current option retires", async () => {
  const change = vi.fn();
  const first = [
    { value: "a", label: "Alpha" },
    { value: "b", label: "Beta" },
  ];
  const second = [
    { value: "a", label: "Alpha" },
    { value: "c", label: "Charlie" },
  ];
  const view = await render(
    <ChoiceSelect label="Preference" value="a" options={first} onChange={change} />,
  );
  const trigger = page.getByRole("combobox");
  await userEvent.tab();
  await expect.element(trigger).toHaveFocus();
  await expect.poll(() => document.querySelectorAll('[role="option"]').length).toBe(2);
  await view.rerender(
    <ChoiceSelect label="Preference" value="b" options={first} onChange={change} />,
  );
  await expect.poll(() => trigger.element().textContent).toContain("Beta");
  await userEvent.keyboard("{z>}");
  try {
    await view.rerender(
      <ChoiceSelect label="Preference" value="b" options={second} onChange={change} />,
    );
    await expect.poll(() => trigger.element().textContent).toContain("Unavailable");
    await expect
      .poll(() => [...document.querySelectorAll('[role="option"]')].map((node) => node.textContent))
      .toEqual(["Alpha", "Charlie"]);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    expect(change).not.toHaveBeenCalled();
  } finally {
    await userEvent.keyboard("{/z}");
  }
});

it("preserves closed-trigger typeahead without accepting internal collection changes", async () => {
  const change = vi.fn();
  function Fixture() {
    const [value, setValue] = useState("system");
    return (
      <ChoiceSelect
        label="Language"
        value={value}
        options={[
          { value: "system", label: "System default" },
          { value: "en", label: "English" },
        ]}
        onChange={(next) => {
          change(next);
          setValue(next);
        }}
      />
    );
  }
  await render(<Fixture />);
  const trigger = page.getByRole("combobox");
  await userEvent.tab();
  await expect.element(trigger).toHaveFocus();
  await expect.poll(() => document.querySelectorAll('[role="option"]').length).toBe(2);
  await userEvent.keyboard("e");
  await expect.poll(() => trigger.element().textContent).toContain("English");
  expect(change).toHaveBeenCalledExactlyOnceWith("en");
  expect(trigger.element().getAttribute("aria-expanded")).toBe("false");
});

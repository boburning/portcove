import { useState } from "react";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react";
import { ChoiceSelect } from "./ChoiceSelect";

afterEach(cleanup);

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

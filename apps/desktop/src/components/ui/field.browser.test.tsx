import { afterEach, expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react";
import { Field } from "./field";
import { Input } from "./input";

afterEach(cleanup);

it("associates the external label, help and field-specific error with the control", async () => {
  await render(
    <Field
      label="Destination"
      description="Choose an empty folder."
      fieldError="This folder contains unrelated files."
    >
      <Input value="E:/occupied" readOnly />
    </Field>,
  );
  const input = page.getByRole("textbox", { name: "Destination" });
  await expect.element(input).toHaveAttribute("aria-invalid", "true");
  const ids = input.element().getAttribute("aria-describedby")!.split(" ");
  const text = ids.map((id) => document.getElementById(id)?.textContent).join(" ");
  expect(text).toContain("Choose an empty folder.");
  expect(text).toContain("This folder contains unrelated files.");
  await page.getByText("Destination", { exact: true }).click();
  await expect.element(input).toHaveFocus();
});

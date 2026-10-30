import { useState } from "react";
import { afterEach, expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react";
import { SettingsView } from "./Chrome";
import type { ThemePreference } from "../theme";

afterEach(cleanup);

it("keeps exactly one theme selected through clicks and composite keyboard navigation", async () => {
  function Fixture() {
    const [preference, setPreference] = useState<ThemePreference>("system");
    return <SettingsView appearance={{ preference, setPreference, resolvedTheme: "dark" }} />;
  }
  await render(<Fixture />);
  const group = page.getByRole("radiogroup", { name: "Color theme" });
  const system = group.getByRole("radio", { name: "Follow system" });
  await system.click();
  await expect.element(system).toHaveAttribute("aria-checked", "true");
  await system.click();
  await expect.element(system).toHaveAttribute("aria-checked", "true");
  await userEvent.keyboard("{ArrowRight}");
  await expect
    .element(group.getByRole("radio", { name: "Dark" }))
    .toHaveAttribute("aria-checked", "true");
  await expect.element(group.getByRole("radio", { name: "Dark" })).toHaveFocus();
  expect(group.element().querySelectorAll('[aria-checked="true"]')).toHaveLength(1);
});

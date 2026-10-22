import { useState } from "react";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react";
import { SearchChoice } from "./combobox";
import axe from "axe-core";

afterEach(async () => {
  await cleanup();
  delete document.documentElement.dataset.theme;
});

it.each(["dark", "light"])(
  "includes the open %s Combobox portal in accessibility checks",
  async (theme) => {
    document.documentElement.dataset.theme = theme;
    function Fixture() {
      const [query, setQuery] = useState("");
      return (
        <main aria-label="Game picker">
          <h1>Choose a game and port</h1>
          <SearchChoice
            label="Game and port"
            options={[
              { id: "first", label: "Doom · Chocolate Doom", description: "Original gameplay" },
              { id: "second", label: "Doom · GZDoom", description: "Enhanced port project" },
            ]}
            value="first"
            query={query}
            onQueryChange={setQuery}
            onChange={() => {}}
          />
        </main>
      );
    }
    await render(<Fixture />);
    const input = page.getByRole("combobox", { name: "Game and port" });
    await input.fill("Doom");
    const list = page.getByRole("listbox");
    await expect.element(list).toBeVisible();
    expect(document.querySelector("main")!.contains(list.element())).toBe(false);
    expect(input.element().getAttribute("aria-controls")?.split(" ")).toContain(list.element().id);
    await userEvent.keyboard("{ArrowDown}");
    const activeId = input.element().getAttribute("aria-activedescendant");
    expect(activeId).toBeTruthy();
    expect(list.element().contains(document.getElementById(activeId!))).toBe(true);
    const results = await axe.run(document.body, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
    });
    expect(results.violations).toEqual([]);
  },
);

it("selects stable identities by keyboard and retains the choice while searching no results", async () => {
  const change = vi.fn();
  function Fixture() {
    const [query, setQuery] = useState("");
    const [value, setValue] = useState("");
    return (
      <>
        <SearchChoice
          label="Game and port"
          options={[
            { id: "first", label: "Doom · Chocolate Doom", description: "First port project" },
            { id: "second", label: "Doom · GZDoom", description: "Second port project" },
          ]}
          value={value}
          query={query}
          onQueryChange={setQuery}
          onChange={(id) => {
            change(id);
            setValue(id);
          }}
        />
        <output aria-label="Selected identity">{value}</output>
      </>
    );
  }
  await render(<Fixture />);
  const input = page.getByRole("combobox", { name: "Game and port" });
  await input.fill("GZDoom");
  await expect.element(page.getByRole("option", { name: /GZDoom/ })).toBeVisible();
  await userEvent.keyboard("{ArrowDown}{Enter}");
  expect(change).toHaveBeenCalledExactlyOnceWith("second");
  await input.fill("nothing matches");
  await expect.element(page.getByText("No game or port matches this search.")).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(input).toHaveFocus();
  await expect.element(input).toHaveValue("nothing matches");
  await page.getByRole("status", { name: "Selected identity" }).click();
  await expect.element(input).toHaveValue("nothing matches");
  await expect
    .element(page.getByRole("status", { name: "Selected identity" }))
    .toHaveTextContent("second");
  expect(change).toHaveBeenCalledTimes(1);
});

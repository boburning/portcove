import { useState } from "react";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react";
import { SearchChoice } from "./combobox";

afterEach(cleanup);

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

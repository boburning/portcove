import { useState } from "react";
import { afterEach, expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react";
import { Button } from "./button";

afterEach(async () => {
  await cleanup();
  document.documentElement.removeAttribute("data-theme");
});

function Toggle() {
  const [selected, setSelected] = useState(false);
  return (
    <Button
      variant={selected ? "selected" : "outline"}
      aria-pressed={selected}
      onClick={() => setSelected(!selected)}
    >
      Favorites
    </Button>
  );
}

it.for(["dark", "light"])(
  "keeps %s pressed cues structural without moving the control",
  async (theme) => {
    document.documentElement.dataset.theme = theme;
    await render(<Toggle />);
    const button = page.getByRole("button", { name: "Favorites" });
    const before = button.element().getBoundingClientRect();
    await button.click();
    await expect.element(button).toHaveAttribute("aria-pressed", "true");
    const after = button.element().getBoundingClientRect();
    expect({ width: after.width, height: after.height }).toEqual({
      width: before.width,
      height: before.height,
    });
    expect(getComputedStyle(button.element(), "::after").borderTopStyle).toBe("double");
  },
);

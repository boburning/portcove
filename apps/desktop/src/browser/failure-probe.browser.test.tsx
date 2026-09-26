import { expect, it } from "vitest";
import { page } from "vitest/browser";

it.skipIf(import.meta.env.VITE_PORTCOVE_BROWSER_TRACE_PROBE !== "1")(
  "retains an intentional browser UI failure trace",
  async () => {
    const button = document.body.appendChild(document.createElement("button"));
    button.textContent = "Visible browser probe";
    await expect.element(page.getByRole("button", { name: "Missing browser probe" })).toBeVisible();
  },
);

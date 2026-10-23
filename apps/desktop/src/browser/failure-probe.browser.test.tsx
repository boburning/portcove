import { expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

it.skipIf(import.meta.env.VITE_PORTCOVE_BROWSER_TRACE_PROBE !== "1")(
  "retains an intentional browser UI failure trace",
  async () => {
    const button = document.body.appendChild(document.createElement("button"));
    button.textContent = "Visible browser probe";
    await expect.element(page.getByRole("button", { name: "Visible browser probe" })).toBeVisible();
    await page.screenshot({ save: true });
    expect.fail("PORTCOVE_EXPECTED_BROWSER_TRACE_FAILURE");
  },
);

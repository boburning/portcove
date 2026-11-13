import { afterEach, expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react";
import type { LibraryOrganization } from "../../types";
import { OrganizationControls, type Organization } from "./OrganizationControls";
import "../../styles/index.css";

const snapshot: LibraryOrganization = {
  revision: 1,
  collections: { weekend: { name: "Weekend {{name}}", port_ids: ["a", "b"] } },
  followed_port_ids: [],
  followed_release_acknowledgments: {},
  hidden_port_ids: [],
  saved_game_ids: [],
  update_notices: {},
  setup_confirmations: [],
};
const organization: Organization = {
  snapshot,
  busy: false,
  failure: undefined,
  refresh: async () => true,
  commit: async () => true,
};

afterEach(async () => {
  await cleanup();
});

it("lists exact collection names with counts in the current language", async () => {
  const { initializeLocalization } = await import("../../localization");
  const localization = initializeLocalization(["en-US"]);
  try {
    await localization.changeLanguage("ar-XB");
    await render(
      <OrganizationControls
        organization={organization}
        selected="all"
        onSelect={() => {}}
        discover={false}
      />,
    );
    await page.getByRole("button", { name: "المجموعات", exact: true }).click();
    const group = page.getByRole("group", { name: "مجموعات المكتبة", exact: true });
    await expect.element(group.getByRole("button", { name: "كل الألعاب" })).toBeVisible();
    const collection = document.querySelector<HTMLElement>(
      '[data-organization-controls="library"] button[aria-pressed="false"] bdi',
    );
    expect(collection?.textContent).toBe("Weekend {{name}}");
    expect(collection?.parentElement?.textContent).toBe("Weekend {{name}} (2)");
    expect(document.body.textContent).toContain("تعديل المجموعات");
  } finally {
    await localization.changeLanguage("en");
  }
});

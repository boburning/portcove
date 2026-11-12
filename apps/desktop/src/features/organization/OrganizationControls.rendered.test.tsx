import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { portDefinition } from "../../test-fixtures";
import type { LibraryOrganization } from "../../types";
import { OrganizationControls, SaveGameButton, type Organization } from "./OrganizationControls";

const snapshot: LibraryOrganization = {
  revision: 1,
  collections: { favourites: { name: "Weekend {{name}}", port_ids: ["a", "b"] } },
  followed_port_ids: [],
  followed_release_acknowledgments: {},
  hidden_port_ids: [],
  saved_game_ids: [],
  update_notices: {},
  setup_confirmations: [],
};
const organization = (failure?: Organization["failure"]): Organization => ({
  snapshot,
  busy: false,
  failure,
  refresh: async () => true,
  commit: async () => true,
});

function controls(discover: boolean, failure?: Organization["failure"], selected = "all") {
  return renderToStaticMarkup(
    <OrganizationControls
      organization={organization(failure)}
      selected={selected}
      onSelect={() => {}}
      discover={discover}
    />,
  );
}

async function inArabicPreview(render: () => string): Promise<string> {
  const { initializeLocalization } = await import("../../localization");
  const localization = initializeLocalization(["en-US"]);
  try {
    await localization.changeLanguage("ar-XB");
    return render();
  } finally {
    await localization.changeLanguage("en");
  }
}

describe("organization controls localization", () => {
  it("keeps English copy, exact collection names and a stable focus hook", () => {
    const discover = controls(true, "write");
    expect(discover).toContain('aria-label="Discover collections"');
    expect(discover).toContain('data-organization-controls="discover"');
    expect(discover).toContain("Portcove couldn’t confirm the changes.");
    expect(controls(false, undefined, "collection:favourites")).toContain(
      "Collections · <bdi>Weekend {{name}}</bdi>",
    );
    expect(controls(false, undefined, "collection:missing")).toContain(
      "Collections · Unavailable collection",
    );
    expect(controls(false, undefined, "hidden")).toContain("Collections · Hidden");
  });

  it("renders the controls and save action in the current language", async () => {
    const markup = await inArabicPreview(() =>
      [
        controls(true, "read"),
        controls(false, undefined, "collection:favourites"),
        controls(false, undefined, "hidden"),
        renderToStaticMarkup(
          <SaveGameButton port={portDefinition()} organization={organization()} />,
        ),
      ].join(""),
    );
    expect(markup).toContain('aria-label="مجموعات الاستكشاف"');
    expect(markup).toContain('data-organization-controls="discover"');
    expect(markup).toContain("كل الألعاب");
    expect(markup).toContain("تعذر تحديث الاختيارات المحفوظة.");
    expect(markup).toContain("المجموعات · <bdi>Weekend {{name}}</bdi>");
    expect(markup).toContain("المجموعات · المخفية");
    expect(markup).toContain('title="حفظ لوقت لاحق"');
    expect(markup).not.toContain("Collections");
    expect(markup).not.toContain("Save for later");
  });
});

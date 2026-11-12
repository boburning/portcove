import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { GameSettingsControl } from "../../components/GameSettingsControl";
import { portDefinition } from "../../test-fixtures";
import type { LibraryOrganization } from "../../types";
import type { Organization } from "../organization/OrganizationControls";
import { GroupedLibrary } from "./GroupedLibrary";

const first = {
  ...portDefinition(),
  id: "first-port",
  name: "First project",
  presentation: {
    original_game_title: "Original game",
    original_game: {
      format_version: 1,
      id: "original-game",
      evidence_urls: [],
      source_editions: [],
    },
  },
};
const second = { ...first, id: "second-port", name: "Second project" };
const snapshot: LibraryOrganization = {
  revision: 0,
  collections: {},
  followed_port_ids: [],
  followed_release_acknowledgments: {},
  hidden_port_ids: [],
  saved_game_ids: [],
  update_notices: {},
  setup_confirmations: [],
  preferred_port_by_game: { "original-game": "second-port" },
};
const organization: Organization = {
  snapshot,
  busy: false,
  failure: "read",
  refresh: async () => true,
  commit: async () => true,
};

function library(matching = [first, second]) {
  return renderToStaticMarkup(
    <GroupedLibrary
      all={[first, second]}
      matching={matching}
      statuses={new Map()}
      organization={organization}
      onSelect={() => {}}
      renderPort={(port) => <span>{port.name}</span>}
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

describe("grouped library and game settings localization", () => {
  it("keeps complete English messages with exact project names", () => {
    const markup = library([second]);
    expect(markup).toContain("All 2 ports · 1 matching");
    expect(markup).toContain("<bdi>Second project</bdi> · Your choice");
    expect(markup).toContain("<bdi>First project</bdi> · Outside current filters");
    expect(markup).toContain("View <bdi>First project</bdi>");
    expect(markup).toContain("Your implementation choice could not be read.");
  });

  it("renders the grouped library and settings prompt in the current language", async () => {
    const markup = await inArabicPreview(() =>
      [
        library([second]),
        renderToStaticMarkup(
          <GameSettingsControl portId="first-port" installId="i" generation={1} busy={false} />,
        ),
      ].join(""),
    );
    expect(markup).toContain("المنفذان (2) · المطابقة: 1");
    expect(markup).toContain("<bdi>Second project</bdi> · اختيارك");
    expect(markup).toContain("<bdi>First project</bdi> · خارج عوامل التصفية الحالية");
    expect(markup).toContain("تعذرت قراءة اختيارك للتنفيذ.");
    expect(markup).toContain('aria-label="إعدادات اللعبة"');
    expect(markup).toContain("قراءة إعدادات اللعبة");
    expect(markup).not.toContain("Read game settings");
    expect(markup).not.toContain("Outside current filters");
  });
});

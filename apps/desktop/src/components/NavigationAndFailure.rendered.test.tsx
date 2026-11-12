import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { arrowKeysName, enterKeyName, escapeKeyName } from "../keyboard-shortcuts";
import type { FailureDisplay } from "../view-model";
import { FailureDetails } from "./FailureDetails";
import { NavigationHints } from "./ui";

const presentation = (mutation_state: string): FailureDisplay =>
  ({
    mutation_state,
    phase: "verify",
    presentation_key: "fixture",
    recovery_actions: [],
    summary: "Core summary",
    technical_context: {},
    technical_message: "Core technical message",
    tone: "error",
  }) as FailureDisplay;

async function inArabicPreview(render: () => string): Promise<string> {
  const { initializeLocalization } = await import("../localization");
  const localization = initializeLocalization(["en-US"]);
  try {
    await localization.changeLanguage("ar-XB");
    return render();
  } finally {
    await localization.changeLanguage("en");
  }
}

describe("navigation hints and technical details localization", () => {
  it("keeps keyboard key names literal while translating the actions", async () => {
    const english = renderToStaticMarkup(<NavigationHints workspace />);
    expect(english).toContain(`${arrowKeysName}: Move`);
    expect(english).toContain(`${enterKeyName}: Select`);
    expect(english).toContain(`${escapeKeyName}: Menu`);

    const markup = await inArabicPreview(() => renderToStaticMarkup(<NavigationHints />));
    expect(markup).toContain("مساعدة التنقل");
    expect(markup).toContain('aria-label="اختصارات التنقل"');
    expect(markup).toContain(`${arrowKeysName}: تحريك`);
    expect(markup).toContain(`${enterKeyName}: تحديد`);
    expect(markup).toContain(`${escapeKeyName}: رجوع`);
    expect(markup).not.toContain("Navigation help");
  });

  it("translates outcome copy and labels but keeps Core values verbatim", async () => {
    const markup = await inArabicPreview(() =>
      renderToStaticMarkup(
        <FailureDetails
          code="fixture_code"
          contextLabel={() => undefined}
          presentation={presentation("no_changes")}
        />,
      ),
    );
    expect(markup).toContain("لم تتغير أي ملفات بسبب هذه العملية.");
    expect(markup).toContain("عرض التفاصيل التقنية");
    expect(markup).toContain("رمز الخطأ");
    expect(markup).toContain("fixture_code");
    expect(markup).toContain("no_changes");
    expect(markup).toContain("Core technical message");
    expect(markup).not.toContain("View technical details");
  });

  it("reads an unrecognized mutation state as unknown", () => {
    const markup = renderToStaticMarkup(
      <FailureDetails presentation={presentation("future_state")} />,
    );
    expect(markup).toContain("confirm whether anything changed. Check the result");
  });
});

import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vite-plus/test";
import { AuthoredSetupWarnings } from "./AuthoredSetupWarnings";
import { InvocationAnnouncements } from "./InvocationAnnouncements";

it("translates the setup-warning heading and task label but keeps authored warnings verbatim", async () => {
  const { initializeLocalization } = await import("../localization");
  const localization = initializeLocalization(["en-US"]);
  const warning = "Use the 1.0.2 build named {{file}} exactly.";
  try {
    await localization.changeLanguage("ar-XB");
    const warnings = renderToStaticMarkup(<AuthoredSetupWarnings warnings={[warning]} />);
    expect(warnings).toContain("قبل أن تبدأ");
    expect(warnings).toContain(warning);
    expect(renderToStaticMarkup(<InvocationAnnouncements messages={[]} />)).toContain(
      'aria-label="تحديثات المهام"',
    );
  } finally {
    await localization.changeLanguage("en");
  }
  expect(renderToStaticMarkup(<AuthoredSetupWarnings warnings={[warning]} />)).toContain(
    "Before you begin",
  );
});

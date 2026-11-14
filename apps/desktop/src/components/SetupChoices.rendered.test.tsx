import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vite-plus/test";
import type { GameFileRoot } from "../types";
import { FolderSetupChoice } from "./FolderSetupChoice";
import { SetupIntentChoice } from "./SetupIntentChoice";

it("renders setup choices in the current language", async () => {
  const { initializeLocalization } = await import("../localization");
  const localization = initializeLocalization(["en-US"]);
  const folder = () =>
    renderToStaticMarkup(
      <FolderSetupChoice
        root={{ id: "root" } as GameFileRoot}
        generation={1}
        ports={[]}
        candidates={[]}
      />,
    );
  const intent = () => renderToStaticMarkup(<SetupIntentChoice portId="p" generation={1} />);
  expect(folder()).toContain("Automatic setup from this folder");
  expect(folder()).toContain("Don&#x27;t set up games from this folder automatically");
  expect(intent()).toContain("When this game&#x27;s files are ready");
  expect(intent()).toContain("Tell me when it&#x27;s ready");
  // aria-label is prohibited on a role-less <label> (axe aria-prohibited-attr);
  // each choice names its own control instead. The keep-a-local-copy checkbox
  // renders only after consent loads, so this static render covers the radios.
  for (const markup of [folder(), intent()]) {
    expect(markup).not.toMatch(/<label\b[^>]*aria-label=/u);
    const inputs = markup.match(/<input\b[^>]*>/gu) ?? [];
    expect(inputs.length).toBeGreaterThan(1);
    for (const input of inputs) expect(input).toMatch(/\saria-label="[^"]+"/u);
  }
  try {
    await localization.changeLanguage("ar-XB");
    expect(folder()).toContain("الإعداد التلقائي من هذا المجلد");
    expect(folder()).toContain("إعداد الألعاب المضافة لاحقًا فقط");
    expect(intent()).toContain("عندما تصبح ملفات هذه اللعبة جاهزة");
    expect(intent()).toContain("تجاهل هذه اللعبة");
  } finally {
    await localization.changeLanguage("en");
  }
});

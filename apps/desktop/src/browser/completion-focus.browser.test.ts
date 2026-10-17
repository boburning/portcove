import { expect, test, afterEach } from "vite-plus/test";
import { observeCompletionReturnFocus } from "../../scripts/desktop-completion-focus.mts";
afterEach(() => document.body.replaceChildren());

type FocusCase = [
  string,
  string,
  false | { tag: string; id: string; origin: boolean },
  ((origin: HTMLElement, document: Document) => void)?,
];
const cases: FocusCase[] = [
  ["origin", "article", { tag: "ARTICLE", id: "", origin: true }],
  ["continue", "#continue", { tag: "BUTTON", id: "continue", origin: false }],
  ["outside", "#outside", false],
  ["body", "body", false],
  ["disabled", "#disabled", false],
  [
    "hidden",
    "article",
    false,
    (origin) => {
      origin.hidden = true;
    },
  ],
  ["inert", "article", false, (origin) => origin.setAttribute("inert", "")],
  [
    "hidden-continuation",
    "article",
    false,
    (_origin, document) => {
      document.querySelector("section")!.hidden = true;
    },
  ],
  ["missing", "article", false, (_origin, document) => document.querySelector("section")!.remove()],
  ["missing-origin", "article", false, (origin) => origin.removeAttribute("data-detail-origin")],
  ["detached", "article", false, (origin) => origin.remove()],
  ["detail", "#detail", false],
];
for (const [focus, selector, expected, mutate] of cases) {
  test(`completion return focus follows the stable setup origin: ${focus}`, () => {
    document.body.innerHTML = `
      <button id="outside">Settings</button>
      <div data-detail-workspace><button id="detail">Play</button></div>
      <article data-detail-origin="game-file-libraries-setup" tabindex="-1">
        <section aria-label="Continue to a game"><button id="continue">Open details</button></section>
        <button id="disabled" aria-disabled="true">Unavailable</button>
      </article>`;
    const origin = document.querySelector("article")!;
    document.querySelector<HTMLElement>(selector)!.focus();
    mutate?.(origin, document);
    expect(observeCompletionReturnFocus()).toEqual(expected);
    document.body.replaceChildren();
  });
}

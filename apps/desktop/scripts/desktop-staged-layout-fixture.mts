import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { executeBrowserScript } from "./browser-script.mts";
import { readStagedLayout } from "./desktop-staged-layout.mts";

export const validStagedLayout = {
  play: { left: 20, right: 95, top: 20, bottom: 60, enabled: true, visible: true },
  activate: { left: 20, right: 223, top: 200, bottom: 240, enabled: true, visible: true },
  header: { left: 20, right: 900, top: 10, bottom: 160 },
  panel: { left: 20, right: 900, top: 180, bottom: 600 },
  versionsSelected: true,
  state: "Ready to play",
  attention: "Update saved for later · 2.0.0-fixture",
  viewport: { width: 960, height: 640 },
  documentOverflow: false,
};

const valid = validStagedLayout;

// Exercise the actual imported callback through the production WebDriver adapter.
// This is a synthetic browser realm, not an installed/native observation.
export function stagedDocument() {
  const documentElement = { scrollWidth: 960, clientWidth: 960 };
  const style = () => ({ visibility: "visible", display: "block", opacity: "1" });
  type Bounds = { left: number; right: number; top: number; bottom: number };
  interface Node {
    parentElement: Node | null;
    style: { visibility: string; display: string; opacity: string };
    hidden: boolean;
    inert: boolean;
    shown: boolean;
    disabled: boolean;
    ariaDisabled: string | null;
    textContent: string;
    bounds: Bounds;
    getBoundingClientRect(): Bounds;
    getClientRects(): Bounds[];
    getAttribute(name: string): string | null;
    closest(selector: string): Node | null;
  }
  function element(bounds: Bounds, parentElement: Node | null = null): Node {
    return {
      parentElement,
      style: style(),
      hidden: false,
      inert: false,
      shown: true,
      disabled: false,
      ariaDisabled: null as string | null,
      textContent: "",
      bounds,
      getBoundingClientRect() {
        return this.bounds;
      },
      getClientRects() {
        return this.shown ? [this.bounds] : [];
      },
      getAttribute(name: string) {
        return name === "aria-disabled" ? this.ariaDisabled : null;
      },
      closest(selector: string): Node | null {
        if (selector === "[hidden], [inert]" && (this.hidden || this.inert)) return this;
        if (selector === ".detail-hero" && this === header) return this;
        return this.parentElement?.closest(selector) ?? null;
      },
    };
  }
  const detail = element({ left: 0, right: 960, top: 0, bottom: 640 });
  const header = element(valid.header, detail);
  const panel = element(valid.panel, detail);
  const play = element(valid.play, header);
  play.textContent = "Play";
  const activate = element(valid.activate, panel);
  activate.textContent = "Apply update · 2.0.0-fixture";
  const unrelated = element(valid.activate, panel);
  unrelated.textContent = "Apply update · another-version";
  const controls = [unrelated, activate];
  const text = {
    state: "Ready to play",
    reason: "",
    attention: valid.attention,
    selectedTab: "Versions & updates",
  };
  const panelQueries = Object.assign(panel, {
    querySelectorAll: (selector: string) => (selector === "button" ? controls : []),
  });
  const detailQueries = {
    querySelector(selector: string) {
      switch (selector) {
        case ".detail-header-actions [data-confirmed-play]":
          return play;
        case "[role=tabpanel]:not([hidden]):not([inert])":
          return panel.hidden || panel.inert ? null : panelQueries;
        case "[role=tab][aria-selected=true]":
          return { textContent: text.selectedTab };
        case "[data-detail-readiness]":
          return { textContent: text.state };
        case "[data-detail-reason]":
          return { textContent: text.reason };
        case "[data-update-attention]":
          return { textContent: text.attention };
        default:
          throw new Error(`Unexpected observation selector: ${selector}`);
      }
    },
  };
  const realm = {
    document: {
      querySelector: (selector: string) =>
        selector === "[data-detail-workspace]" ? detailQueries : null,
      documentElement,
    },
    innerWidth: 960,
    innerHeight: 640,
    getComputedStyle: (element: Node) => element.style,
  };
  let executions = 0;
  async function observe(callback: unknown = readStagedLayout, version = "2.0.0-fixture") {
    const browser = {
      async executeScript(script: unknown, ...args: unknown[]) {
        assert.equal(script, callback, "The adapter must forward the actual callback");
        assert.equal(typeof script, "function");
        executions++;
        const result: unknown = runInNewContext(
          `(${Function.prototype.toString.call(script)})(...args)`,
          { ...realm, args },
          { timeout: 1000 },
        );
        // WebDriver transports JSON values, not foreign-realm prototypes.
        const transported: unknown = JSON.parse(JSON.stringify(result));
        return transported;
      },
    };
    const result: unknown = await Reflect.apply(executeBrowserScript, undefined, [
      browser,
      callback,
      version,
    ]);
    return result;
  }
  return {
    detail,
    header,
    panel,
    play,
    activate,
    controls,
    text,
    documentElement,
    observe,
    executions: () => executions,
  };
}

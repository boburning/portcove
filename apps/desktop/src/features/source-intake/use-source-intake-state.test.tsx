// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { portDefinition, sourceProfile } from "../../test-fixtures";
import type { CatalogDocument } from "../../types";
import { useSourceIntakeState } from "./use-source-intake-state";

const gameProfile = { ...sourceProfile(), id: "game", label: "Game source" };
const biosProfile = { ...sourceProfile(), id: "bios", label: "BIOS" };
const port = {
  ...portDefinition(),
  id: "lighthouse",
  name: "Lighthouse",
  source_profile: gameProfile.id,
  bios_source_profile: biosProfile.id,
};
const catalog = { ports: [port], source_profiles: [gameProfile, biosProfile] } as CatalogDocument;
let root: Root;
let state: ReturnType<typeof useSourceIntakeState>;

function Fixture({ value = catalog }: { value?: CatalogDocument }) {
  state = useSourceIntakeState(value);
  return null;
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  root = createRoot(document.createElement("div"));
  await act(async () => root.render(createElement(Fixture)));
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

describe("source intake state", () => {
  it.each([
    ["missing-port", gameProfile.id],
    [port.id, "missing-profile"],
  ])("refuses an unknown catalog identity: %s / %s", async (portId, profileId) => {
    await act(async () => state.open(portId, profileId));
    expect(state.request).toBeUndefined();
  });

  it.each([
    [gameProfile.id, "game"],
    [biosProfile.id, "bios"],
  ] as const)("opens the %s profile with %s purpose", async (profileId, purpose) => {
    const paths = ["D:/incoming/source.bin"];
    await act(async () => state.open(port.id, profileId, paths));

    expect(state.request).toMatchObject({
      portId: port.id,
      portName: port.name,
      profile: { id: profileId },
      purpose,
      paths,
    });
  });

  it("closes the current request", async () => {
    await act(async () => state.open(port.id, gameProfile.id));
    expect(state.request).toBeDefined();

    await act(async () => state.close());
    expect(state.request).toBeUndefined();
  });
});

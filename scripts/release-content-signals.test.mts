import assert from "node:assert/strict";
import test from "node:test";
import { HEAD_BYTES, headCandidates, packageSignals } from "./release-content-signals.mts";

// Synthetic fixtures only: each head reproduces a public header shape, never game data.
const head = (offset: number, hex: string, size = HEAD_BYTES) => {
  const bytes = Buffer.alloc(size);
  Buffer.from(hex, "hex").copy(bytes, offset);
  return bytes;
};

void test("a code-only package with fonts, icons and libraries has no signals", () => {
  const entries = [
    { path: "Game/game.exe", size: 40_000_000 },
    { path: "Game/SDL2.dll", size: 2_000_000 },
    { path: "Game/assets/fonts/Chiaro.otf", size: 200_000 },
    { path: "Game/assets/icon.png", size: 50_000 },
    { path: "Game/bios/openbios.bin", size: 512 * 1024 },
  ];
  const heads = new Map([
    [
      "Game/bios/openbios.bin",
      Buffer.concat([Buffer.from("Sony Computer Entertainment Inc. OpenBios"), Buffer.alloc(64)]),
    ],
  ]);
  assert.deepEqual(packageSignals(entries, heads), []);
  assert.deepEqual(
    headCandidates(entries).map((entry) => entry.path),
    ["Game/bios/openbios.bin"],
  );
});

void test("ROM, disc and original executable files are flagged by name", () => {
  const signals = packageSignals([
    { path: "data/baserom.z64", size: 8 * 1024 * 1024 },
    { path: "disc/Game.ISO", size: 700_000_000 },
    { path: "game/default.xex", size: 6_000_000 },
    { path: "patch/default.xexp", size: 100_000 },
    { path: "empty.nds", size: 0 },
  ]);
  assert.deepEqual(
    signals.map((signal) => [signal.path, signal.kind]),
    [
      ["data/baserom.z64", "rom-or-disc-image"],
      ["disc/Game.ISO", "rom-or-disc-image"],
      ["game/default.xex", "original-executable"],
      ["patch/default.xexp", "original-executable"],
    ],
  );
});

void test("copied cartridge headers, ROM magic, shader caches and BIOS images are flagged by content", () => {
  const entries = [
    { path: "header.bin", size: 352 },
    { path: "gba.bin", size: 192 },
    { path: "gb.bin", size: 0x150 },
    { path: "rom.bin", size: 8 * 1024 * 1024 },
    { path: "cache/534507EF.xsh", size: 127_448 },
    { path: "scph.bin", size: 512 * 1024 },
    { path: "disc.img", size: 1_000_000 },
  ];
  const heads = new Map([
    ["header.bin", head(0xc0, "24ffae51699aa2213d84820a84e409ad", 352)],
    ["gba.bin", head(0x04, "24ffae51699aa2213d84820a84e409ad", 192)],
    ["gb.bin", head(0x104, "ceed6666cc0d000b", 0x150)],
    ["rom.bin", head(0, "80371240")],
    ["cache/534507EF.xsh", Buffer.from("XESH....")],
    [
      "scph.bin",
      Buffer.concat([Buffer.alloc(0x108), Buffer.from("Sony Computer Entertainment Inc.")]),
    ],
    ["disc.img", head(0x8001, Buffer.from("CD001").toString("hex"))],
  ]);
  assert.deepEqual(
    packageSignals(entries, heads).map((signal) => [signal.path, signal.kind]),
    [
      ["header.bin", "cartridge-header"],
      ["gba.bin", "cartridge-header"],
      ["gb.bin", "cartridge-header"],
      ["rom.bin", "rom-or-disc-image"],
      ["cache/534507EF.xsh", "shader-cache"],
      ["scph.bin", "console-bios"],
      ["disc.img", "rom-or-disc-image"],
    ],
  );
});

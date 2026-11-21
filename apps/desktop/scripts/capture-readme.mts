import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite-plus";
import { comparisonEntries } from "../src/dev-scenarios/interactive/comparison-scene.ts";
import { collectionArtwork } from "../src/dev-scenarios/interactive/collection-artwork.ts";

const desktop = fileURLToPath(new URL("../", import.meta.url));
const root = path.resolve(desktop, "../..");
const work = path.join(root, "work");
process.env.PLAYWRIGHT_BROWSERS_PATH ??= path.join(work, "browser-cache");
const { chromium } = await import("playwright");
const server = await createServer({
  root: desktop,
  configFile: path.join(desktop, "vite.config.ts"),
  server: { host: "127.0.0.1", port: 0, hmr: false, open: false },
});
try {
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === "string") throw new Error("Missing local preview port");
  const origin = "http://127.0.0.1:" + address.port;
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
      colorScheme: "dark",
      reducedMotion: "reduce",
      locale: "en-US",
      serviceWorkers: "block",
    });
    const unexpected: string[] = [];
    const art = new Set([
      origin + "/brand/icons/portcove-mascot-transparent.png",
      origin + "/brand/logo/portcove-logo-v2-transparent.png",
      ...collectionArtwork.map((png) => "data:image/png;base64," + png),
    ]);
    page.on("pageerror", (error) => unexpected.push(error.message));
    await page.route("**/*", async (route) => {
      const request = route.request();
      const url = request.url();
      if (art.has(url) || (new URL(url).origin === origin && request.resourceType() !== "image")) {
        await route.continue();
      } else {
        unexpected.push("Unexpected resource: " + url.slice(0, 160));
        await route.abort();
      }
    });
    await page.goto(origin + "/scenarios.html?mode=interactive&journey=comparison&embed=1");
    await page.getByRole("heading", { name: "Your library", exact: true }).waitFor();
    const selectedIds = [0, 10, 4, 5, 3, 2];
    for (const [index, id] of selectedIds.entries()) {
      const game = comparisonEntries[id]!;
      await page
        .getByRole("button", { name: `Favorite ${game.title} · ${game.port}`, exact: true })
        .click();
      await page
        .getByRole("radio", {
          name: `Favorites ${index + 1} ${index === 0 ? "game" : "games"}`,
          exact: true,
        })
        .waitFor();
    }
    await page.getByRole("radio", { name: "Favorites 6 games", exact: true }).click();
    await page.waitForFunction(() => globalThis.document.querySelectorAll("article").length === 6);

    async function capture() {
      await page.evaluate(() => globalThis.document.fonts.ready.then(() => undefined));
      await page.waitForFunction(() =>
        [...globalThis.document.images].every((img) => img.complete),
      );
      const sources = await page.evaluate(() =>
        [...globalThis.document.images].map((img) => (img.naturalWidth > 0 ? img.currentSrc : "")),
      );
      if (await page.locator(".scenario-controls").isVisible())
        throw new Error("Unexpected scenario controls in README capture");
      if (sources.some((src) => !art.has(src)))
        throw new Error("Unrecognized image in README capture");
      await page.mouse.move(0, 0);
      return page.screenshot({ animations: "disabled" });
    }

    const library = await capture();
    await page
      .getByRole("button", {
        name: "View details for Harbor Adventure Harbor desktop port",
        exact: true,
      })
      .click();
    await page.getByRole("heading", { name: "Harbor Adventure", exact: true }).waitFor();
    await page.getByRole("tab", { name: "Overview", selected: true }).waitFor();
    const details = await capture();
    if (unexpected.length) throw new Error(unexpected.join("\n"));

    await mkdir(work, { recursive: true });
    const output = await mkdtemp(path.join(work, "readme-capture-"));
    await writeFile(path.join(output, "library.png"), library);
    await writeFile(path.join(output, "game-details.png"), details);
    const revision = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    const localChanges = execFileSync(
      "git",
      ["status", "--porcelain", "--", "apps/desktop", "pnpm-lock.yaml"],
      { cwd: root, encoding: "utf8" },
    ).trim();
    console.log(
      `Review both images in ${output}\nCaptured ${new Date().toISOString().slice(0, 10)} from ${revision}${localChanges ? " (with local changes)" : ""}`,
    );
  } finally {
    await browser.close();
  }
} finally {
  await server.close();
}

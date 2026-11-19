import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, writeFile } from "node:fs/promises";
import path from "node:path";
import { By, Key, until, type IRectangle, type WebDriver } from "selenium-webdriver";
import {
  INTERFACE_SIZES,
  INTERFACE_SIZE_KEY,
  type InterfaceSize,
} from "../src/interface-size-controller.ts";
import type {
  OutputDesktopWorkspaceSnapshot,
  IgdbArtwork,
} from "../src/transport-types.generated.d.ts";
import type { ScenarioContext, ScenarioInvoke } from "./desktop-scenario-context.mts";
import { executeBrowserScript } from "./browser-script.mts";
import { captureKeyboardTarget } from "./desktop-capture-target.mts";
import {
  clickVisible,
  selectCatalogPort,
  selectPrimaryNavigation,
} from "./desktop-review-controls.mts";
import { transportValue } from "./transport-values.mts";
import { fixtureSuccess } from "./desktop-scenario-state.mts";
import { errorMessage, isRecord } from "../../../scripts/runtime-values.mts";
import { readBoundedEvidenceFile } from "../../../scripts/development-evidence.mts";

const scenarioId = "native-collection-artwork-presentation";
const subjects = [
  { id: "andreyvelsk-com-mobilerpgpack-phone", count: 2 },
  { id: "crownpark-xbox360-native-ports-collection", count: 4 },
] as const;
const pngHeader = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const maximumPngBytes = 1024 * 1024;
const digest = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const maximumCatalogDiagnosticBytes = 2 * 1024 * 1024;

/** Diagnostic transport identities, not Core's canonical definition/trust identities.
 * Object-key normalization distinguishes ordering from changed values; arrays retain order. */
export function collectionCatalogDiagnostic(snapshot: OutputDesktopWorkspaceSnapshot) {
  assert.ok(snapshot.catalog && snapshot.listing_catalog);
  const identity = (value: unknown) => {
    const json = JSON.stringify(value);
    assert.ok(typeof json === "string");
    const sorted = JSON.stringify(value, (_key, entry: unknown) =>
      isRecord(entry)
        ? Object.fromEntries(
            Object.keys(entry)
              .sort()
              .map((key) => [key, entry[key]]),
          )
        : entry,
    );
    assert.ok(typeof sorted === "string");
    return {
      json_bytes: Buffer.byteLength(json),
      json_sha256: digest(json),
      object_keys_sorted_sha256: digest(sorted),
    };
  };
  const entries = (values: readonly { id: string }[]) => {
    assert.ok(values.length <= 10_000, "Catalog diagnostic entry bound exceeded");
    return values.map((value, index) => ({ index, id: value.id, ...identity(value) }));
  };
  return {
    catalog_digest: snapshot.catalog_digest,
    catalog: {
      ...identity(snapshot.catalog),
      schema_version: snapshot.catalog.schema_version,
      source_catalog: identity(snapshot.catalog.source_catalog ?? null),
      ports: entries(snapshot.catalog.ports),
      source_profiles: entries(snapshot.catalog.source_profiles ?? []),
    },
    listing_catalog: {
      ...identity(snapshot.listing_catalog),
      format_version: snapshot.listing_catalog.format_version,
      listings: entries(snapshot.listing_catalog.listings),
    },
  };
}

/** Retain early dispatch/request IDs from the existing private host log, never payloads.
 * Fixed session/rotation names bound discovery. Limits/read errors remain explicit;
 * host logging is best effort and is not proof that every IPC request was observed. */
export async function collectionCommandDiagnostic(runtimeRoot: string, startedAt: number) {
  const records: object[] = [];
  const errors: string[] = [];
  const files: object[] = [];
  let matched = 0;
  let bytes = 0;
  const endedAt = Date.now();
  const root = path.join(runtimeRoot, "diagnostics");
  const slots = ["", ...Array.from({ length: 8 }, (_, index) => `session-0${index}`)];
  for (const slot of slots) {
    const directory = path.join(root, slot);
    try {
      const metadata = await lstat(directory);
      assert.ok(metadata.isDirectory() && !metadata.isSymbolicLink());
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT") continue;
      errors.push(`Cannot inspect ${slot || "root"}: ${errorMessage(error)}`);
      continue;
    }
    for (let rotation = 0; rotation <= 5; rotation++) {
      const name = `portcove-desktop.jsonl${rotation ? `.${rotation}` : ""}`;
      const file = path.join(directory, name);
      try {
        const metadata = await lstat(file);
        if (metadata.size === 0 && metadata.isFile()) continue;
        assert.ok(bytes + metadata.size <= 16 * 1024 * 1024, "Host log read bound exceeded");
        const observed = await readBoundedEvidenceFile(file, 4 * 1024 * 1024);
        bytes += observed.bytes.length;
        files.push({ slot, name, bytes: observed.bytes.length, sha256: observed.identity.sha256 });
        for (const line of observed.bytes.toString("utf8").split("\n")) {
          if (!line) continue;
          const value: unknown = JSON.parse(line);
          if (!isRecord(value) || typeof value.timestamp_ms !== "number") continue;
          if (value.timestamp_ms < startedAt || value.timestamp_ms > endedAt) continue;
          const fields = value.fields;
          if (!isRecord(fields) || typeof fields.message !== "string") continue;
          const named =
            /^(?:IPC command dispatched: |blocking worker queued for )([a-z][a-z0-9_:|]{0,127})$/u.exec(
              fields.message,
            );
          const worker = /^blocking worker (started|completed)$/u.exec(fields.message);
          if (!named && !worker) continue;
          matched++;
          if (records.length >= 1_024) continue;
          records.push({
            timestamp_ms: value.timestamp_ms,
            process_id:
              typeof value.process_id === "number" && Number.isSafeInteger(value.process_id)
                ? value.process_id
                : null,
            session_id:
              typeof value.session_id === "string" ? value.session_id.slice(0, 128) : null,
            phase: typeof fields.phase === "string" ? fields.phase.slice(0, 32) : null,
            request_id:
              typeof fields.request_id === "number" && Number.isSafeInteger(fields.request_id)
                ? fields.request_id
                : null,
            command: named?.[1] ?? null,
            event: worker?.[1] ?? (fields.phase === "command" ? "dispatched" : "queued"),
          });
        }
      } catch (error) {
        if (isRecord(error) && error.code === "ENOENT") continue;
        errors.push(`${slot || "root"}/${name}: ${errorMessage(error)}`);
      }
    }
  }
  return {
    started_at_ms: startedAt,
    ended_at_ms: endedAt,
    matched_records: matched,
    omitted_records: Math.max(0, matched - records.length),
    complete_available_records: errors.length === 0 && matched > 0 && matched === records.length,
    files,
    records,
    errors,
    limits:
      "Existing best-effort host JSONL; no args, replies, credentials or complete-IPC claim. 1024 records; 16MiB input; fixed 9 namespaces/6 rotations.",
  };
}

/** Same finite bound as the sidecar writer; a failure never permits a full workspace dump. */
export function collectionCatalogDiagnosticJson(value: unknown) {
  const json = JSON.stringify(value, null, 2) + "\n";
  assert.ok(
    Buffer.byteLength(json) <= maximumCatalogDiagnosticBytes,
    "Catalog diagnostic exceeds 2MiB",
  );
  return json;
}

/** Selection from the real workspace; it never manufactures an operational port. */
export function collectionArtworkSubjects(snapshot: OutputDesktopWorkspaceSnapshot) {
  assert.ok(snapshot.catalog && snapshot.listing_catalog, "A full actual catalog read is required");
  assert.match(snapshot.catalog_digest ?? "", /^[a-f0-9]{64}$/u);
  assert.equal(snapshot.sources.length, 0, "Use a fresh source-free isolated library");
  assert.ok(!snapshot.statuses.some((status) => status.active || status.external_runtime));
  assert.equal(snapshot.pending_setups?.length ?? 0, 0);
  return subjects.map(({ id, count }) => {
    assert.ok(
      !snapshot.catalog!.ports.some((port) => port.id === id),
      "This case observes listings only",
    );
    const listing = snapshot.listing_catalog!.listings.find((entry) => entry.id === id);
    assert.ok(listing, `Actual collection listing missing: ${id}`);
    const members = listing.collection_covers;
    assert.equal(members?.length, count, `Actual collection membership changed: ${id}`);
    assert.ok(members);
    assert.equal(new Set(members.map((member) => member.image_sha256)).size, count);
    for (const member of members) assert.match(member.image_sha256, /^[a-f0-9]{64}$/u);
    return { id, name: listing.name, availability: listing.availability, members };
  });
}

/** Verify the public native thumbnail identity without retaining its payload in JSON. */
export function collectionThumbnailIdentity(value: unknown, sha256: string, revision: number) {
  assert.ok(isRecord(value));
  assert.equal(value.asset_sha256, sha256);
  assert.equal(value.choice_revision, revision);
  const encoded = value.png_base64;
  assert.ok(typeof encoded === "string" && encoded.length > 0);
  assert.ok(encoded.length <= 4 * Math.ceil(maximumPngBytes / 3));
  assert.equal(encoded.length % 4, 0);
  assert.match(encoded, /^[A-Za-z0-9+/]*={0,2}$/u);
  const bytes = Buffer.from(encoded, "base64");
  assert.ok(bytes.length <= maximumPngBytes && bytes.subarray(0, 8).equals(pngHeader));
  return {
    member_sha256: sha256,
    choice_revision: revision,
    png_sha256: digest(bytes),
    bytes: bytes.length,
  };
}

/** Serialized read-only DOM observation; no renderer cache or fetch replacement. */
export function observeCollectionArtwork(selector: string) {
  const art = document.querySelector<HTMLElement>(selector);
  const rectangle = (element: Element) => {
    const box = element.getBoundingClientRect();
    return { x: box.x, y: box.y, width: box.width, height: box.height };
  };
  return {
    source: art?.dataset.artworkSource ?? null,
    layout: art?.querySelector("[data-cover-collection]")
      ? "tiles"
      : art?.querySelector("[data-companion-cover]")
        ? "pair"
        : "single-or-fallback",
    rect: art ? rectangle(art) : null,
    images: [...(art?.querySelectorAll("img") ?? [])].map((image) => ({
      src: image.currentSrc || image.src,
      complete: image.complete && image.naturalWidth > 0,
      natural_width: image.naturalWidth,
      natural_height: image.naturalHeight,
      object_fit: getComputedStyle(image).objectFit,
      rect: rectangle(image),
    })),
    viewport: { width: innerWidth, height: innerHeight },
    scroll_width: document.documentElement.scrollWidth,
    client_width: document.documentElement.clientWidth,
    theme: document.documentElement.dataset.theme,
  };
}

type Thumbnail = ReturnType<typeof collectionThumbnailIdentity>;
type Surface = Awaited<ReturnType<typeof observeCollectionArtwork>>;
export function verifiedCollectionSurface(surface: Surface, thumbnails: readonly Thumbnail[]) {
  assert.ok(surface.rect && surface.rect.width > 0 && surface.rect.height > 0);
  assert.ok(
    surface.scroll_width <= surface.client_width + 1,
    "Workspace must not overflow horizontally",
  );
  assert.ok(surface.images.length <= 4);
  const images = surface.images.map(({ src, ...image }) => {
    assert.ok(
      src.startsWith("data:image/png;base64,"),
      "Only public native PNG previews are expected",
    );
    assert.ok(src.length <= "data:image/png;base64,".length + 4 * Math.ceil(maximumPngBytes / 3));
    const bytes = Buffer.from(src.slice("data:image/png;base64,".length), "base64");
    assert.ok(bytes.length <= maximumPngBytes && bytes.subarray(0, 8).equals(pngHeader));
    const identity = thumbnails.find((thumbnail) => thumbnail.png_sha256 === digest(bytes));
    assert.ok(identity, "Rendered image is not one of the observed native collection thumbnails");
    assert.equal(image.object_fit, "contain");
    const frame = surface.rect!;
    assert.ok(image.rect.x >= frame.x - 1 && image.rect.y >= frame.y - 1);
    assert.ok(image.rect.x + image.rect.width <= frame.x + frame.width + 1);
    assert.ok(image.rect.y + image.rect.height <= frame.y + frame.height + 1);
    return { ...image, member_sha256: identity.member_sha256, png_sha256: identity.png_sha256 };
  });
  assert.equal(new Set(images.map((image) => image.member_sha256)).size, images.length);
  return { ...surface, images };
}

interface Context extends ScenarioContext {
  invoke: ScenarioInvoke;
  library: string;
  setTheme: (theme: "dark" | "light") => Promise<unknown>;
  runtimeRoot?: string;
}

/** Actual WebView dimensions and the preference confirmed by its native sizing owner. */
export function observeCollectionViewport(preference: string) {
  return {
    width: innerWidth,
    height: innerHeight,
    device_pixel_ratio: devicePixelRatio,
    interface_size: localStorage.getItem(preference),
    theme: document.documentElement.dataset.theme,
  };
}

/** Same production Ctrl+0/Ctrl++ route used by native Library/interface-size qualification. */
export async function selectCollectionInterfaceSize(browser: WebDriver, size: InterfaceSize) {
  assert.ok(INTERFACE_SIZES.includes(size));
  const measure = () =>
    executeBrowserScript(browser, observeCollectionViewport, INTERFACE_SIZE_KEY);
  const shortcut = (key: string) =>
    browser.actions().keyDown(Key.CONTROL).sendKeys(key).keyUp(Key.CONTROL).perform();
  await shortcut("0");
  await browser.wait(async () => (await measure()).interface_size === "100", 10_000);
  const baseline = await measure();
  for (const step of INTERFACE_SIZES.slice(1, INTERFACE_SIZES.indexOf(size) + 1)) {
    await shortcut("+");
    await browser.wait(
      async () => {
        const state = await measure();
        return (
          state.interface_size === String(step) &&
          Math.abs(state.width - (baseline.width * 100) / step) <= 2 &&
          Math.abs(state.height - (baseline.height * 100) / step) <= 2
        );
      },
      10_000,
      `Native collection interface size ${step}% did not settle`,
    );
  }
  return { requested: size, baseline, applied: await measure() };
}

/** Join every owned presentation restoration before publishing the final failure. */
export async function finishCollectionArtworkObservation(
  context: Pick<Context, "browser" | "output" | "artifacts" | "setTheme">,
  state: {
    originalWindow: IRectangle;
    originalTheme: string | undefined;
    originalSize?: InterfaceSize | undefined;
    restoreSize: boolean;
    observations: readonly unknown[];
    failures: readonly unknown[];
    failure?: Error | undefined;
  },
) {
  let failure = state.failure;
  const cleanup: unknown[] = [];
  const cleanupFailures: string[] = [];
  const retainFailure = (error: unknown) => {
    cleanupFailures.push(errorMessage(error));
    failure ??= error instanceof Error ? error : new Error(errorMessage(error), { cause: error });
  };
  await Promise.resolve()
    .then(async () => {
      await context.browser.manage().window().setRect(state.originalWindow);
      const outer = await context.browser.manage().window().getRect();
      assert.equal(outer.width, state.originalWindow.width);
      assert.equal(outer.height, state.originalWindow.height);
      cleanup.push({ phase: "restored-window", outer });
    })
    .catch(retainFailure);
  if (state.restoreSize && state.originalSize !== undefined)
    await selectCollectionInterfaceSize(context.browser, state.originalSize)
      .then((geometry) => cleanup.push({ phase: "restored-interface-size", geometry }))
      .catch(retainFailure);
  const originalTheme = state.originalTheme;
  if (originalTheme === "dark" || originalTheme === "light")
    await Promise.resolve()
      .then(() => context.setTheme(originalTheme))
      .catch(retainFailure);
  const report = path.join(context.output, "native-collection-artwork-observations.json");
  await writeFile(
    report,
    JSON.stringify(
      {
        format_version: 1,
        scenario: scenarioId,
        observations: state.observations,
        failures: state.failures,
        cleanup,
        cleanup_failures: cleanupFailures,
        failure: failure ? errorMessage(failure) : null,
        scope:
          "Actual catalog, public native thumbnails, Discover/detail/credits only; isolated theme/interface-size preference writes; Library/Manage and installations are not covered",
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  )
    .then(() => context.artifacts.push(report))
    .catch(retainFailure);
  return failure;
}

/** Real listing/thumbnail IPC only; no original files, installs, credentials or catalog writes. */
export async function collectionArtworkScenario(context: Context) {
  await context.scenario(scenarioId, async () => {
    const { browser, invoke, library, output, artifacts } = context;
    const diagnosticStartedAt = Date.now();
    const catalogDiagnostics: object[] = [];
    const observations: unknown[] = [];
    const failures: unknown[] = [];
    const originalWindow = await browser.manage().window().getRect();
    const originalViewport = await executeBrowserScript(
      browser,
      observeCollectionViewport,
      INTERFACE_SIZE_KEY,
    );
    const originalSize = INTERFACE_SIZES.find(
      (size) => String(size) === originalViewport.interface_size,
    );
    observations.push({
      phase: "original-window-and-zoom",
      outer: originalWindow,
      ...originalViewport,
    });
    let restoreSize = false;
    let primary: Error | undefined;
    const retainFailure = (error: unknown) => {
      primary ??= error instanceof Error ? error : new Error(errorMessage(error), { cause: error });
    };
    const observeCatalog = async (
      phase: "before" | "after",
      snapshot: OutputDesktopWorkspaceSnapshot,
      generation: number,
    ) => {
      // These are read-only observations. Failure must not skip any original
      // preservation assertion or replace its error with a diagnostic failure.
      const status = async (command: "get_catalog_status" | "get_listing_delivery_status") => {
        try {
          const value = fixtureSuccess(await invoke(command));
          if (command === "get_catalog_status") {
            const parsed = transportValue("catalog_status", value);
            return {
              command,
              at_ms: Date.now(),
              provenance: parsed.provenance,
              state_sha256: parsed.state_sha256,
              updates_enabled: parsed.updates_enabled,
            };
          }
          return {
            command,
            at_ms: Date.now(),
            value: transportValue("listing_delivery_status", value),
          };
        } catch (error) {
          return { command, at_ms: Date.now(), error: errorMessage(error) };
        }
      };
      try {
        catalogDiagnostics.push({
          phase,
          observed_at_ms: Date.now(),
          generation,
          documents: collectionCatalogDiagnostic(snapshot),
          status: await Promise.all([
            status("get_catalog_status"),
            status("get_listing_delivery_status"),
          ]),
        });
      } catch (error) {
        catalogDiagnostics.push({ phase, error: errorMessage(error) });
      }
    };
    try {
      const bootstrap = transportValue(
        "desktop_bootstrap_status",
        fixtureSuccess(await invoke("get_bootstrap_status")),
      );
      assert.ok(bootstrap.ready && bootstrap.library_root);
      assert.equal(path.relative(path.resolve(library), path.resolve(bootstrap.library_root)), "");
      const generation = bootstrap.generation;
      const snapshot = transportValue(
        "desktop_workspace_snapshot",
        fixtureSuccess(await invoke("get_workspace_snapshot", { generation })),
      );
      const collections = collectionArtworkSubjects(snapshot);
      await observeCatalog("before", snapshot, generation);
      assert.ok(
        originalSize !== undefined,
        "The native interface size must be confirmed before changing it",
      );
      observations.push({
        phase: "catalog",
        generation,
        catalog_digest: snapshot.catalog_digest,
        listing_format: snapshot.listing_catalog!.format_version,
        collections,
        listing_statuses: snapshot.listing_statuses?.filter((status) =>
          collections.some(({ id }) => id === status.port_id),
        ),
      });
      const previews = new Map<string, Thumbnail[]>();
      const choices = new Map<string, unknown>();
      const capture = async (
        name: string,
        selector: string,
        members: readonly IgdbArtwork[],
        thumbnails: readonly Thumbnail[],
      ) => {
        const target = await browser.wait(until.elementLocated(By.css(selector)), 15_000);
        await executeBrowserScript(
          browser,
          (element) =>
            element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" }),
          target,
        );
        await browser.wait(
          async () => {
            const surface = await executeBrowserScript(browser, observeCollectionArtwork, selector);
            return (
              surface.images.every((image) => image.complete) &&
              (thumbnails.length < members.length || surface.images.length === members.length)
            );
          },
          30_000,
          "Collection images did not reach their observed loaded/fallback state",
        );
        const surface = verifiedCollectionSurface(
          await executeBrowserScript(browser, observeCollectionArtwork, selector),
          thumbnails,
        );
        if (thumbnails.length === members.length) {
          assert.equal(surface.images.length, members.length);
          assert.equal(surface.source, "igdb_cover_collection");
          assert.equal(surface.layout, members.length === 2 ? "pair" : "tiles");
        }
        observations.push({
          phase: name,
          generation,
          ...surface,
          complete_collection: surface.images.length === members.length,
        });
        await captureKeyboardTarget(context, name, target, scenarioId);
        const after = verifiedCollectionSurface(
          await executeBrowserScript(browser, observeCollectionArtwork, selector),
          thumbnails,
        );
        assert.deepEqual(
          after,
          surface,
          "Collection pixels/geometry changed across settled capture",
        );
      };
      for (const variant of [
        { theme: "dark", width: 960, height: 640, size: 100, compact: false },
        { theme: "light", width: 960, height: 640, size: 100, compact: false },
        { theme: "dark", width: 960, height: 640, size: 200, compact: true },
      ] as const) {
        await browser.manage().window().setRect({ width: variant.width, height: variant.height });
        const outer = await browser.manage().window().getRect();
        assert.equal(outer.width, variant.width);
        assert.equal(outer.height, variant.height);
        await context.setTheme(variant.theme);
        restoreSize = true;
        const geometry = await selectCollectionInterfaceSize(browser, variant.size);
        observations.push({ phase: "native-window-and-zoom", outer, ...geometry });
        for (const collection of variant.compact ? collections.slice(1) : collections) {
          const { id, name, members } = collection;
          const label = `collection-${variant.theme}-${variant.width}-${variant.size}-${members.length}`;
          await selectPrimaryNavigation(browser, "Discover");
          const search = await browser.wait(until.elementLocated(By.id("port-search")), 10_000);
          await search.sendKeys(Key.chord(Key.CONTROL, "a"), Key.BACK_SPACE, name);
          const card = `.discover-game[data-discover-primary-port-id="${id}"]`;
          const art = `${card} .collection-art`;
          const frame = await browser.wait(until.elementLocated(By.css(art)), 15_000);
          await executeBrowserScript(
            browser,
            (element) => element.scrollIntoView({ block: "center", behavior: "instant" }),
            frame,
          );
          const { images, ...initial } = await executeBrowserScript(
            browser,
            observeCollectionArtwork,
            art,
          );
          observations.push({
            phase: `${label}-initial`,
            outer,
            ...initial,
            images: images.map(({ src: _src, ...image }) => image),
          });
          if (!previews.has(id)) {
            const state = transportValue(
              "artwork_state",
              fixtureSuccess(
                await invoke("get_artwork", { portId: id, slot: "cover", generation }),
              ),
            );
            assert.equal(
              state.choice.asset_sha256,
              null,
              "The isolated default must not override collection art",
            );
            choices.set(id, state.choice);
            const thumbnails: Thumbnail[] = [];
            for (const member of members) {
              try {
                const reply = fixtureSuccess(
                  await invoke("get_collection_cover_thumbnail", {
                    portId: id,
                    expectedSha256: member.image_sha256,
                    expectedRevision: state.choice.revision,
                    generation,
                  }),
                );
                thumbnails.push(
                  collectionThumbnailIdentity(reply, member.image_sha256, state.choice.revision),
                );
              } catch (error) {
                failures.push({
                  id,
                  member,
                  generation,
                  choice_revision: state.choice.revision,
                  message: errorMessage(error),
                });
              }
            }
            previews.set(id, thumbnails);
            observations.push({
              phase: "public-native-thumbnails",
              id,
              generation,
              choice_revision: state.choice.revision,
              artwork: {
                choice: state.choice,
                availability: state.availability,
                resolved_source: state.resolved_source,
                reason: state.reason,
              },
              thumbnails,
            });
          }
          const thumbnails = previews.get(id)!;
          await capture(`${label}-discover`, art, members, thumbnails);
          await selectCatalogPort(browser, id);
          assert.equal(
            (await browser.findElements(By.css(".detail-panel [data-launch-action]"))).length,
            0,
            "Listing artwork must not manufacture Play",
          );
          observations.push({
            phase: `${label}-capabilities`,
            id,
            availability: collection.availability,
            actions: await executeBrowserScript(browser, () =>
              [...document.querySelectorAll<HTMLButtonElement>(".detail-panel button")]
                .filter(
                  (button) =>
                    button.getClientRects().length > 0 && !button.closest("[hidden],[inert]"),
                )
                .map((button) => ({
                  label: button.getAttribute("aria-label") || button.textContent?.trim(),
                  disabled: button.matches(":disabled,[aria-disabled=true]"),
                })),
            ),
          });
          await capture(
            `${label}-detail`,
            ".detail-panel .game-hero-collection",
            members,
            thumbnails,
          );
          const credits = await browser.findElement(
            By.css(".detail-panel .game-hero-credits summary"),
          );
          await clickVisible(browser, credits);
          const creditRegion = await browser.findElement(
            By.css(".detail-panel .game-hero-credits"),
          );
          const text = await creditRegion.getText();
          for (const member of members) {
            assert.ok(text.includes(`IGDB game ${member.game_id}`));
            assert.ok(text.includes(`Cover ${member.cover_id} · image ${member.image_id}`));
            assert.equal(
              await creditRegion
                .findElement(By.css(`a[href="https://www.igdb.com/games/${member.game_slug}"]`))
                .getAttribute("href"),
              `https://www.igdb.com/games/${member.game_slug}`,
            );
          }
          await captureKeyboardTarget(
            context,
            `${label}-credits`,
            variant.compact ? credits : creditRegion,
            scenarioId,
          );
          await clickVisible(
            browser,
            await browser.findElement(By.css(".detail-panel [data-detail-back]")),
          );
          await browser.wait(
            () =>
              executeBrowserScript(
                browser,
                (id) => document.activeElement?.getAttribute("data-detail-game-id") === id,
                id,
              ),
            10_000,
            "Back must restore the exact Discover opener focus",
          );
          observations.push({ phase: `${label}-back`, id, focus_restored: true, credits: text });
        }
      }
      const finalBootstrap = transportValue(
        "desktop_bootstrap_status",
        fixtureSuccess(await invoke("get_bootstrap_status")),
      );
      assert.equal(finalBootstrap.generation, generation);
      assert.equal(finalBootstrap.library_root, bootstrap.library_root);
      const after = transportValue(
        "desktop_workspace_snapshot",
        fixtureSuccess(await invoke("get_workspace_snapshot", { generation })),
      );
      await observeCatalog("after", after, generation);
      assert.equal(after.catalog_digest, snapshot.catalog_digest);
      assert.deepEqual(collectionArtworkSubjects(after), collections);
      assert.deepEqual(after.sources, snapshot.sources);
      assert.deepEqual(after.statuses, snapshot.statuses);
      for (const { id } of collections) {
        const state = transportValue(
          "artwork_state",
          fixtureSuccess(await invoke("get_artwork", { portId: id, slot: "cover", generation })),
        );
        assert.deepEqual(
          state.choice,
          choices.get(id),
          "Public previews must preserve the actual artwork choice",
        );
      }
      assert.equal(
        failures.length,
        0,
        "Public collection downloads failed; retained captures are partial/fallback observations, not complete collection acceptance",
      );
    } catch (error) {
      retainFailure(error);
    } finally {
      const diagnosticFile = path.join(output, "native-collection-catalog-diagnostics.json");
      try {
        const commands = context.runtimeRoot
          ? await collectionCommandDiagnostic(context.runtimeRoot, diagnosticStartedAt)
          : { available: false, reason: "Owned host diagnostics root was not supplied" };
        await writeFile(
          diagnosticFile,
          collectionCatalogDiagnosticJson({
            format_version: 1,
            scenario: scenarioId,
            started_at_ms: diagnosticStartedAt,
            states: catalogDiagnostics,
            commands,
            scope:
              "Read-only diagnostic transport hashes and existing selection status, not Core canonical identity or trust. Array order is preserved. Status reads are separately timestamped, not an atomic workspace snapshot. Original digest/source/status/choice invariants remain authoritative.",
          }),
          { flag: "wx" },
        );
        artifacts.push(diagnosticFile);
      } catch (error) {
        observations.push({
          phase: "catalog-diagnostic-retention-failed",
          error: errorMessage(error),
        });
        retainFailure(error);
      }
      primary = await finishCollectionArtworkObservation(context, {
        originalWindow,
        originalTheme: originalViewport.theme,
        originalSize,
        restoreSize,
        observations,
        failures,
        failure: primary,
      });
    }
    if (primary) throw primary;
  });
}

import { errorMessage } from "../../../scripts/runtime-values.mts";
import { executeBrowserScript } from "./browser-script.mts";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import type { WebDriver } from "selenium-webdriver";

interface ArtworkReadObservation {
  availability: unknown;
  revision: unknown;
  asset_sha256: unknown;
  png_encoded_bytes: number | undefined;
  png_bytes: number | undefined;
}
interface ArtworkFailureObservation {
  code: unknown;
  message: string;
  summary: string | undefined;
  mutation_state: unknown;
}
interface ArtworkRequestObservation {
  command: string;
  started_at: string;
  completed: boolean;
  response_ms?: number;
  result?: string | null;
  completed_ms?: number;
  observation?: ArtworkReadObservation;
  failure?: ArtworkFailureObservation;
  observation_error?: string;
  transport_error?: string;
}
interface ArtworkProbe {
  original: typeof fetch;
  requests: ArtworkRequestObservation[];
  omitted: number;
}
// This single optional slot is created/restored by the serialized callbacks below.
// It is local to this probe, not an ambient browser API or IPC payload authority.
type ArtworkProbeWindow = Window & { __portcoveArtworkProbe?: ArtworkProbe };

/** Bounded observations from the owned renderer; never record IPC headers or image bytes. */
export function artworkObservations({
  browser,
  output,
  artifacts,
}: {
  browser: Pick<WebDriver, "executeScript">;
  output: string;
  artifacts: string[];
}) {
  type Capture = NonNullable<Awaited<ReturnType<typeof observe>>>;
  const documents: (
    | (Capture & { phase: string })
    | { phase: string; observation_error: string }
  )[] = [];
  const observe = () =>
    executeBrowserScript(browser, () => {
      const ownedWindow = window as ArtworkProbeWindow;
      const probe = ownedWindow.__portcoveArtworkProbe;
      if (!probe) return null;
      window.fetch = probe.original;
      const result = {
        requests: probe.requests,
        omitted_requests: probe.omitted,
        restored: window.fetch === probe.original,
        slots: [...document.querySelectorAll(".artwork-slot")].map((slot) => ({
          label: slot.getAttribute("aria-label"),
          busy: slot.getAttribute("aria-busy"),
          notices: [
            ...slot.querySelectorAll('[role="alert"], [role="status"], .artwork-notice'),
          ].map((node) => node.textContent),
          buttons: [...slot.querySelectorAll("button")].map((button) => ({
            label: button.textContent,
            disabled: button.disabled,
          })),
        })),
        images: [
          ...document.querySelectorAll<HTMLImageElement>(
            ".wide-artwork img, .game-hero-detail .game-hero-image",
          ),
        ].map((img) => ({
          complete: img.complete,
          width: img.naturalWidth,
          height: img.naturalHeight,
        })),
      };
      delete ownedWindow.__portcoveArtworkProbe;
      return result;
    });
  const capture = async (phase: string) => {
    try {
      const observed = await observe();
      if (observed) documents.push({ phase, ...observed });
    } catch (error) {
      documents.push({ phase, observation_error: errorMessage(error) });
    }
  };
  const begin = () =>
    executeBrowserScript(browser, () => {
      function pngBytes(encoded: unknown) {
        if (typeof encoded !== "string") return undefined;
        const padding = encoded.endsWith("==") ? 2 : Number(encoded.endsWith("="));
        return (encoded.length / 4) * 3 - padding;
      }
      function object(value: unknown): Record<string, unknown> {
        if (value === null || value === undefined) return {};
        function isObject(candidate: unknown): candidate is Record<string, unknown> {
          return candidate !== null && typeof candidate === "object" && !Array.isArray(candidate);
        }
        if (!isObject(value)) throw new Error("Artwork observation requires an object");
        return value;
      }
      function observation(value: unknown): ArtworkReadObservation {
        const body = object(value);
        const choice = object(body.choice);
        return {
          availability: body.availability,
          revision: choice.revision,
          asset_sha256: choice.asset_sha256,
          png_encoded_bytes:
            typeof body.png_base64 === "string" ? body.png_base64.length : undefined,
          png_bytes: pngBytes(body.png_base64),
        };
      }
      function failure(value: unknown): ArtworkFailureObservation {
        const body = object(value);
        const presentation = object(body.presentation);
        if (presentation.summary !== undefined && typeof presentation.summary !== "string")
          throw new Error("Artwork failure summary must be text");
        return {
          code: body.code,
          message: String(body.message).slice(0, 512),
          summary: presentation.summary?.slice(0, 512),
          mutation_state: presentation.mutation_state,
        };
      }
      function message(error: unknown) {
        return error !== null &&
          typeof error === "object" &&
          "message" in error &&
          typeof error.message === "string"
          ? error.message
          : String(error);
      }
      const original = window.fetch;
      const probe: ArtworkProbe = { original, requests: [], omitted: 0 };
      const ownedWindow = window as ArtworkProbeWindow;
      ownedWindow.__portcoveArtworkProbe = probe;
      window.fetch = function (input, ...args) {
        const url = new URL(
          typeof input === "string"
            ? input
            : input !== null &&
                (typeof input === "object" || typeof input === "function") &&
                "url" in input &&
                typeof input.url === "string"
              ? input.url
              : // oxlint-disable-next-line typescript/no-base-to-string -- Preserve native fetch coercion for foreign-realm URLs; covered by the serialized-input control.
                String(input),
          location.href,
        );
        const command = decodeURIComponent(url.pathname.slice(1));
        if (
          url.hostname !== "ipc.localhost" ||
          !["get_artwork", "get_artwork_thumbnail", "import_artwork", "reset_artwork"].includes(
            command,
          )
        )
          return original.call(window, input, ...args);
        if (probe.requests.length >= 256) {
          probe.omitted++;
          return original.call(window, input, ...args);
        }
        const started = performance.now();
        const record: ArtworkRequestObservation = {
          command,
          started_at: new Date().toISOString(),
          completed: false,
        };
        probe.requests.push(record);
        return original.call(window, input, ...args).then(
          (response) => {
            record.response_ms = performance.now() - started;
            record.result = response.headers.get("Tauri-Response");
            response
              .clone()
              .json()
              .then((value: unknown) => {
                record.completed = true;
                record.completed_ms = performance.now() - started;
                if (record.result === "ok") record.observation = observation(value);
                else record.failure = failure(value);
              })
              .catch((error: unknown) => {
                record.observation_error = message(error);
              });
            return response;
          },
          (error: unknown) => {
            record.completed = true;
            record.completed_ms = performance.now() - started;
            record.transport_error = message(error);
            throw error;
          },
        );
      };
    });
  const finish = async (failure?: unknown) => {
    await capture("scenario-finished");
    const report = path.join(output, "artwork-request-observations.json");
    await writeFile(
      report,
      JSON.stringify(
        {
          method: "Owned native renderer fetch observations; no response substitution",
          failure,
          documents,
        },
        null,
        2,
      ),
      { flag: "wx" },
    );
    artifacts.push(report);
  };
  return { begin, capture, finish };
}

import path from "node:path";
import { writeFile } from "node:fs/promises";

/** Bounded observations from the owned renderer; never record IPC headers or image bytes. */
export function artworkObservations({ browser, output, artifacts }) {
  const documents = [];
  const capture = async (phase) => {
    try {
      const observed = await browser.executeScript(() => {
        const probe = window.__portcoveArtworkProbe;
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
          images: [...document.querySelectorAll(".wide-artwork img, .detail-cover img")].map(
            (img) => ({
              complete: img.complete,
              width: img.naturalWidth,
              height: img.naturalHeight,
            }),
          ),
        };
        delete window.__portcoveArtworkProbe;
        return result;
      });
      if (observed) documents.push({ phase, ...observed });
    } catch (error) {
      documents.push({ phase, observation_error: error.message });
    }
  };
  const begin = () =>
    browser.executeScript(() => {
      const original = window.fetch;
      const probe = { original, requests: [], omitted: 0 };
      window.__portcoveArtworkProbe = probe;
      window.fetch = function (input, ...args) {
        const url = new URL(
          typeof input === "string" ? input : (input.url ?? String(input)),
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
        const record = {
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
              .then((value) => {
                record.completed = true;
                record.completed_ms = performance.now() - started;
                if (record.result === "ok")
                  record.observation = {
                    availability: value?.availability,
                    revision: value?.choice?.revision,
                    asset_sha256: value?.choice?.asset_sha256,
                    png_bytes: value?.png?.length,
                  };
                else
                  record.failure = {
                    code: value?.code,
                    message: String(value?.message).slice(0, 512),
                    summary: value?.presentation?.summary?.slice(0, 512),
                    mutation_state: value?.presentation?.mutation_state,
                  };
              })
              .catch((error) => {
                record.observation_error = error.message;
              });
            return response;
          },
          (error) => {
            record.completed = true;
            record.completed_ms = performance.now() - started;
            record.transport_error = error.message;
            throw error;
          },
        );
      };
    });
  const finish = async (failure) => {
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

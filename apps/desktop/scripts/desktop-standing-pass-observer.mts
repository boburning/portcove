/** Transparent HTTP IPC observation. These functions serialize into the actual WebView. */
interface StandingPassSample {
  complete: boolean;
  value?: unknown;
  error?: string;
}
interface StandingObserverWindow extends Window {
  __TAURI_INTERNALS__?: { convertFileSrc(command: string, protocol: string): string };
  __portcoveStandingObserver?: {
    original: typeof fetch;
    wrapper: typeof fetch;
    samples: StandingPassSample[];
    omitted: number;
  };
}

export function installStandingPassObserver() {
  const runtime = window as StandingObserverWindow;
  if (runtime.__portcoveStandingObserver) throw new Error("Standing observer already installed");
  const native = runtime.__TAURI_INTERNALS__;
  if (!native) throw new Error("Native bridge unavailable");
  const target = native.convertFileSrc("run_standing_setup", "ipc");
  const original = window.fetch;
  const samples: StandingPassSample[] = [];
  const observer = {
    original,
    wrapper: original,
    samples,
    omitted: 0,
  };
  const wrapper: typeof fetch = function (this: unknown, ...args) {
    const input = args[0];
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const returned = original.apply(this, args);
    if (url === target) {
      if (samples.length >= 16) observer.omitted++;
      else {
        const sample: StandingPassSample = { complete: false };
        samples.push(sample);
        // Keep the original Promise, Response, error and arguments. Clone only
        // the selected result for evidence; do not delay or replace the caller.
        void returned.then(
          (response) => {
            try {
              void response
                .clone()
                .json()
                .then(
                  (value: unknown) => {
                    sample.value = value;
                    sample.complete = true;
                  },
                  (error: unknown) => {
                    sample.error = String(error);
                    sample.complete = true;
                  },
                );
            } catch (error) {
              sample.error = String(error);
              sample.complete = true;
            }
          },
          (error: unknown) => {
            sample.error = String(error);
            sample.complete = true;
          },
        );
      }
    }
    return returned;
  };
  observer.wrapper = wrapper;
  runtime.__portcoveStandingObserver = observer;
  window.fetch = wrapper;
}

export function readStandingPassObservations() {
  const observer = (window as StandingObserverWindow).__portcoveStandingObserver;
  if (!observer) throw new Error("Standing observer unavailable");
  return { samples: observer.samples.map((sample) => ({ ...sample })), omitted: observer.omitted };
}

export function restoreStandingPassObserver() {
  const runtime = window as StandingObserverWindow;
  const observer = runtime.__portcoveStandingObserver;
  if (!observer) return false;
  if (window.fetch !== observer.wrapper) throw new Error("Standing observer lost fetch ownership");
  window.fetch = observer.original;
  delete runtime.__portcoveStandingObserver;
  return true;
}

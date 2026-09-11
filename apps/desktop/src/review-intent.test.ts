// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { desktopApi } from "./api";
import { useAdoptionPlanning, useInstallPlanning, type Perform } from "./use-portcove";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

type Plan = Awaited<ReturnType<typeof desktopApi.plan>>;
type Preview = Awaited<ReturnType<typeof desktopApi.previewAdoption>>;
let root: Root;
let install: ReturnType<typeof useInstallPlanning>;
let adoption: ReturnType<typeof useAdoptionPlanning>;
const errors = vi.fn();
const done = vi.fn();
const perform: Perform = async (_name, task) => {
  try {
    return await task();
  } catch (error) {
    errors(error);
    return undefined;
  }
};
function Fixture({
  port = "first",
  channel = "stable",
  path = "A",
  open = true,
  generation = 1,
}: {
  port?: string;
  channel?: "stable" | "beta";
  path?: string;
  open?: boolean;
  generation?: number;
}) {
  install = useInstallPlanning(port, channel, perform);
  adoption = useAdoptionPlanning(path, port, open, generation, perform, done);
  return null;
}
async function render(props: Parameters<typeof Fixture>[0] = {}) {
  await act(async () => {
    root.render(createElement(Fixture, props));
  });
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  root = createRoot(document.createElement("div"));
  errors.mockClear();
  done.mockClear();
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("current review intent", () => {
  it.each([{ port: "second" }, { channel: "beta" as const }])(
    "rejects reverse install completion after %j changes",
    async (props) => {
      const old = deferred<Plan>();
      const next = deferred<Plan>();
      vi.spyOn(desktopApi, "plan")
        .mockReturnValueOnce(old.promise)
        .mockReturnValueOnce(next.promise);
      await render();
      let first!: Promise<void>;
      let second!: Promise<void>;
      await act(async () => {
        first = install.review();
      });
      await render(props);
      await act(async () => {
        second = install.review();
      });
      const current = { port_id: "current" } as Plan;
      await act(async () => {
        next.resolve(current);
        await second;
      });
      await act(async () => {
        old.resolve({ port_id: "old" } as Plan);
        await first;
      });
      expect(install.plan).toBe(current);
    },
  );

  it("invalidates a reviewed install after its output destination changes", async () => {
    const reviewed = { port_id: "first" } as Plan;
    vi.spyOn(desktopApi, "plan").mockResolvedValue(reviewed);
    await render();
    await act(async () => {
      await install.review();
    });
    expect(install.plan).toBe(reviewed);
    await act(async () => {
      install.invalidate();
    });
    expect(install.plan).toBeUndefined();
  });

  it.each([{ path: "B" }, { port: "second" }, { open: false }, { generation: 2 }])(
    "invalidates adoption preview and action on %j",
    async (props) => {
      const old = deferred<Preview>();
      const next = deferred<Preview>();
      vi.spyOn(desktopApi, "previewAdoption")
        .mockReturnValueOnce(old.promise)
        .mockReturnValueOnce(next.promise);
      const adopt = vi.spyOn(desktopApi, "adopt");
      await render();
      let first!: Promise<void>;
      await act(async () => {
        first = adoption.review();
      });
      await render(props);
      await act(async () => {
        old.resolve({ selected_port_id: "first", plan_sha256: "old" } as Preview);
        await first;
        await adoption.adopt();
      });
      expect(adoption.preview).toBeUndefined();
      expect(adopt).not.toHaveBeenCalled();
      adoption.invalidate();
      await render({ ...props, open: true });
      expect(adoption.preview).toBeUndefined();
      let second!: Promise<void>;
      await act(async () => {
        second = adoption.review();
      });
      const current = {
        selected_port_id: "second",
        plan_sha256: "new",
      } as Preview;
      await act(async () => {
        next.resolve(current);
        await second;
      });
      expect(adoption.preview).toBe(current);
    },
  );

  it("keeps the newer adoption preview when requests finish in reverse order", async () => {
    const old = deferred<Preview>();
    const next = deferred<Preview>();
    vi.spyOn(desktopApi, "previewAdoption")
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(next.promise);
    await render();
    let first!: Promise<void>;
    let second!: Promise<void>;
    await act(async () => {
      first = adoption.review();
    });
    await render({ path: "B", port: "second" });
    await act(async () => {
      second = adoption.review();
    });
    const current = {
      selected_port_id: "second",
      plan_sha256: "new",
    } as Preview;
    await act(async () => {
      next.resolve(current);
      await second;
    });
    await act(async () => {
      old.resolve({ selected_port_id: "first", plan_sha256: "old" } as Preview);
      await first;
    });
    expect(adoption.preview).toBe(current);
  });

  it("suppresses stale errors and allows current failures to be retried", async () => {
    const old = deferred<Preview>();
    vi.spyOn(desktopApi, "previewAdoption")
      .mockReturnValueOnce(old.promise)
      .mockRejectedValueOnce(new Error("current"));
    await render();
    let first!: Promise<void>;
    await act(async () => {
      first = adoption.review();
    });
    await render({ path: "B" });
    await act(async () => {
      old.reject(new Error("stale"));
      await first;
    });
    expect(errors).not.toHaveBeenCalled();
    await act(async () => {
      await adoption.review();
    });
    expect(errors).toHaveBeenCalledWith(new Error("current"));
    expect(adoption.preview).toBeUndefined();
  });

  it("does not close a reopened dialog when an earlier adoption finishes", async () => {
    vi.spyOn(desktopApi, "previewAdoption").mockResolvedValue({
      selected_port_id: "first",
      plan_sha256: "reviewed",
    } as Preview);
    const pending = deferred<Awaited<ReturnType<typeof desktopApi.adopt>>>();
    vi.spyOn(desktopApi, "adopt").mockReturnValue(pending.promise);
    await render();
    await act(async () => {
      await adoption.review();
    });
    let mutation!: Promise<void>;
    await act(async () => {
      mutation = adoption.adopt();
    });
    expect(desktopApi.adopt).toHaveBeenCalledWith("A", "reviewed", 1, "first");
    await render({ open: false });
    await render({ path: "B" });
    await act(async () => {
      pending.resolve({} as Awaited<ReturnType<typeof desktopApi.adopt>>);
      await mutation;
    });
    expect(done).not.toHaveBeenCalled();
    expect(adoption.preview).toBeUndefined();
  });

  it("keeps a consumed preview cleared across transient identity changes", async () => {
    const reviewed = {
      selected_port_id: "first",
      plan_sha256: "reviewed",
    } as Preview;
    vi.spyOn(desktopApi, "previewAdoption").mockResolvedValue(reviewed);
    const pending = deferred<Awaited<ReturnType<typeof desktopApi.adopt>>>();
    vi.spyOn(desktopApi, "adopt").mockReturnValue(pending.promise);
    await render();
    await act(async () => {
      await adoption.review();
    });
    let mutation!: Promise<void>;
    await act(async () => {
      mutation = adoption.adopt();
    });
    await render({ generation: 2 });
    await render();
    expect(adoption.preview).toBeUndefined();
    await act(async () => {
      pending.reject(new Error("changed saved data"));
      await mutation;
    });
    expect(adoption.preview).toBeUndefined();
    expect(done).not.toHaveBeenCalled();
  });

  it.each([null, undefined])(
    "requires a fresh adoption review after cancellation or failure: %s",
    async (result) => {
      vi.spyOn(desktopApi, "previewAdoption").mockResolvedValue({
        selected_port_id: "first",
        plan_sha256: "reviewed",
      } as Preview);
      vi.spyOn(desktopApi, "adopt").mockImplementation(async () => {
        if (result === undefined) throw new Error("changed saved data");
        return result;
      });
      await render();
      await act(async () => {
        await adoption.review();
      });
      await act(async () => {
        await adoption.adopt();
      });
      expect(adoption.preview).toBeUndefined();
      expect(done).toHaveBeenCalledTimes(result === null ? 1 : 0);
      expect(adoption.copyFailed).toBe(result === undefined);
      await act(async () => {
        await adoption.adopt();
      });
      expect(desktopApi.adopt).toHaveBeenCalledTimes(1);
    },
  );

  it("commits cleared mutation state before closing after native cancellation", async () => {
    vi.spyOn(desktopApi, "previewAdoption").mockResolvedValue({
      selected_port_id: "first",
      plan_sha256: "reviewed",
    } as Preview);
    vi.spyOn(desktopApi, "adopt").mockResolvedValue(null);
    done.mockImplementation(() => {
      expect(adoption.preview).toBeUndefined();
      expect(adoption.applying).toBe(false);
    });
    await render();
    await act(async () => {
      await adoption.review();
    });
    await act(async () => {
      await adoption.adopt();
    });
    expect(done).toHaveBeenCalledOnce();
  });

  it("allows only one adoption request from duplicate events", async () => {
    vi.spyOn(desktopApi, "previewAdoption").mockResolvedValue({
      selected_port_id: "first",
      plan_sha256: "reviewed",
    } as Preview);
    const pending = deferred<Awaited<ReturnType<typeof desktopApi.adopt>>>();
    vi.spyOn(desktopApi, "adopt").mockReturnValue(pending.promise);
    await render();
    await act(async () => {
      await adoption.review();
    });
    let first!: Promise<void>;
    await act(async () => {
      first = adoption.adopt();
      await adoption.adopt();
    });
    expect(desktopApi.adopt).toHaveBeenCalledTimes(1);
    expect(adoption.preview).toBeUndefined();
    expect(adoption.applying).toBe(true);
    await act(async () => {
      pending.resolve(null);
      await first;
    });
  });
});

import { act, createElement, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { desktopApi } from "../../api";
import { portDefinition, portStatus } from "../../test-fixtures";
import type { SourceRecord, SourceReuseReview } from "../../types";
import { targetInvocationContext } from "../operations/invocation-state";
import type { Perform } from "../operations/use-operation-state";
import {
  usePendingSetupReview,
  useSetupReviewSelection,
} from "../game-file-discovery/setup-review-selection";
import { useAdoptionPlanning, useInstallPlanning } from "./use-installation-planning";

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
  registeredSource,
  sourcePath = "",
}: {
  port?: string | null;
  channel?: "stable" | "beta";
  path?: string;
  open?: boolean;
  generation?: number;
  registeredSource?: SourceRecord;
  sourcePath?: string;
}) {
  install = useInstallPlanning(
    port ?? undefined,
    channel,
    perform,
    port
      ? targetInvocationContext(
          "Review installation",
          { kind: "port", id: port, label: `Game ${port}` },
          generation,
          "library",
        )
      : undefined,
    registeredSource,
    sourcePath,
  );
  adoption = useAdoptionPlanning(path, port ?? undefined, open, generation, perform, done, [
    { ...portDefinition(), id: "first", name: "Game first" },
    { ...portDefinition(), id: "second", name: "Game second" },
  ]);
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
  it("reuses the selected registration only after a matching per-integration Core review", async () => {
    const source: SourceRecord = {
      profile_id: "game",
      path: "D:/original.z64",
      sha256: "a".repeat(64),
      size: 64,
      storage_sha256: "a".repeat(64),
      storage_size: 64,
      updated_at: 1,
    };
    const checked: SourceReuseReview = {
      registration: source,
      reference: { profile_id: "game", reference_sha256: "b".repeat(64) },
      inspection: {
        schema_version: 1,
        profile_id: "game",
        health: "current",
        state_code: "recognized_exact",
        summary: "Checked saved identity",
        next_action: "Review setup",
        applications: [],
        evidence: [],
        legacy: { registration_identity_not_recorded: false, variant_unspecified_records: [] },
      },
      applications: [
        {
          port_id: "first",
          port_name: "First",
          role: "game",
          contract_id: "first-source",
          compatibility: "listed_identity",
          can_review_setup: true,
          summary: "Listed identity, further setup checks remain.",
          additional_checks: [],
        },
      ],
    };
    const check = vi.spyOn(desktopApi, "reviewSourceReuse").mockResolvedValue(checked);
    const plan = vi.spyOn(desktopApi, "plan").mockResolvedValue({} as Plan);
    await render({ registeredSource: source, sourcePath: source.path });
    await act(async () => install.review());
    expect(check).toHaveBeenCalledWith("game", 1);
    expect(plan).toHaveBeenCalledExactlyOnceWith("first", "stable");
    expect(install.sourceReference).toEqual(checked.reference);
    check.mockResolvedValueOnce({
      ...checked,
      applications: [
        {
          ...checked.applications[0]!,
          compatibility: "incompatible",
          can_review_setup: false,
          summary: "This edition is not listed; choose USA 1.0.",
        },
      ],
    });
    await act(async () => install.review());
    expect(plan).toHaveBeenCalledTimes(1);
    expect(install.plan).toBeUndefined();
    expect(String(errors.mock.calls.at(-1)?.[0])).toContain("choose USA 1.0");
    check.mockRejectedValueOnce(new Error("This host does not support review_source_reuse."));
    await act(async () => install.review());
    expect(plan).toHaveBeenCalledTimes(1);
    expect(install.sourceReference).toBeUndefined();
  });

  it.each(["", "D:/previous-choice.z64"])(
    "completes a queued saved-file choice across source draft %j and automatic prefill",
    async (initialPath) => {
      const source: SourceRecord = {
        profile_id: "game",
        path: "D:/saved.z64",
        sha256: "a".repeat(64),
        size: 64,
        storage_sha256: "a".repeat(64),
        storage_size: 64,
        updated_at: 1,
      };
      const reference = { profile_id: "game", reference_sha256: "b".repeat(64) };
      const check = vi.spyOn(desktopApi, "reviewSourceReuse").mockResolvedValue({
        registration: source,
        reference,
        applications: [{ port_id: "first", can_review_setup: true }],
      } as SourceReuseReview);
      const pending = deferred<Plan>();
      const plan = vi.spyOn(desktopApi, "plan").mockReturnValue(pending.promise);
      let choose!: () => void;
      let draft = "";
      function Continuation({
        sourcePath,
        setSourcePath,
      }: {
        sourcePath: string;
        setSourcePath: (path: string) => void;
      }) {
        const selection = useSetupReviewSelection();
        draft = sourcePath;
        // App fills the selected registration in an earlier passive effect when
        // the chosen detail opens. Exercise that same committed-render boundary.
        useEffect(() => {
          if (selection.pendingReview) setSourcePath(source.path);
        }, [selection.pendingReview, setSourcePath]);
        install = useInstallPlanning(
          "first",
          "stable",
          perform,
          targetInvocationContext(
            "Review installation",
            { kind: "port", id: "first", label: "First" },
            1,
            "library",
          ),
          source,
          sourcePath,
        );
        usePendingSetupReview(
          selection,
          "first",
          "first",
          {
            ...portStatus(),
            port_id: "first",
            port_actions: [
              {
                action: "install",
                availability: "allowed",
                reason: "available",
                summary: "Available",
              },
            ],
          },
          undefined,
          install.reviewSource,
          sourcePath,
          setSourcePath,
        );
        choose = () => selection.requestReview("first", "stable", reference);
        return null;
      }
      // The draft owner is separate from the model prefill, as in App.
      function DraftOwner() {
        const [sourcePath, setSourcePath] = useState(initialPath);
        return createElement(Continuation, { sourcePath, setSourcePath });
      }
      await act(async () => root.render(createElement(DraftOwner)));
      await act(async () => choose());
      expect(["", source.path]).toContain(draft);
      expect(check).toHaveBeenCalledExactlyOnceWith("game", 1);
      expect(plan).toHaveBeenCalledExactlyOnceWith("first", "stable");
      const result = {} as Plan;
      await act(async () => {
        pending.resolve(result);
      });
      expect(install.plan).toBe(result);
      expect(install.sourceReference).toEqual(reference);
      expect(errors).not.toHaveBeenCalled();
    },
  );

  it.each(["healthy", "missing", "incompatible"])(
    "preserves an explicit replacement independently of the %s saved registration",
    async (state) => {
      const source: SourceRecord = {
        profile_id: "game",
        path: "D:/previous.z64",
        sha256: "a".repeat(64),
        size: 64,
        storage_sha256: "a".repeat(64),
        storage_size: 64,
        updated_at: 1,
      };
      const check = vi.spyOn(desktopApi, "reviewSourceReuse").mockImplementation(async () => {
        if (state === "missing") throw new Error("The saved file is missing.");
        return {
          reference: { profile_id: "game", reference_sha256: "b".repeat(64) },
          registration: source,
          applications: [{ port_id: "first", can_review_setup: state === "healthy" }],
        } as SourceReuseReview;
      });
      const plan = vi.spyOn(desktopApi, "plan").mockResolvedValue({} as Plan);
      await render({ registeredSource: source, sourcePath: "D:/replacement.z64" });
      await act(async () => install.review());
      expect(check).not.toHaveBeenCalled();
      expect(plan).toHaveBeenCalledExactlyOnceWith("first", "stable");
      expect(install.plan).toBeDefined();
      expect(install.sourceReference).toBeUndefined();
      expect(errors).not.toHaveBeenCalled();
    },
  );

  it("discards an install review completed after the explicit source selection changes", async () => {
    const pending = deferred<Plan>();
    vi.spyOn(desktopApi, "plan").mockReturnValue(pending.promise);
    await render({ sourcePath: "D:/first.z64" });
    let review!: Promise<void>;
    await act(async () => {
      review = install.review();
    });
    await render({ sourcePath: "D:/second.z64" });
    await act(async () => {
      pending.resolve({} as Plan);
      await review;
    });
    expect(install.plan).toBeUndefined();
    expect(install.sourceReference).toBeUndefined();
  });

  it("binds an ambiguous detected choice to a fresh plan and its native authorization", async () => {
    const ambiguous = {
      detected_port_ids: ["first", "second"],
      selected_port_id: null,
      plan_sha256: "unbound",
    } as Preview;
    const selected = {
      detected_port_ids: ["second"],
      selected_port_id: "second",
      plan_sha256: "bound",
    } as Preview;
    const preview = vi
      .spyOn(desktopApi, "previewAdoption")
      .mockResolvedValueOnce(ambiguous)
      .mockResolvedValueOnce(selected);
    const adopt = vi.spyOn(desktopApi, "adopt").mockResolvedValue(null);
    await render({ port: null });
    await act(async () => {
      await adoption.review();
    });
    expect(preview).toHaveBeenCalledWith("A", 1, undefined);
    await act(async () => {
      await adoption.review("unlisted");
      await adoption.adopt();
    });
    expect(preview).toHaveBeenCalledTimes(1);
    expect(adopt).not.toHaveBeenCalled();
    expect(adoption.preview).toBe(ambiguous);
    await act(async () => {
      await adoption.review("second");
    });
    expect(preview).toHaveBeenLastCalledWith("A", 1, "second");
    expect(adoption.preview).toBe(selected);
    await act(async () => {
      await adoption.adopt();
    });
    expect(adopt).toHaveBeenCalledExactlyOnceWith("A", "bound", 1, "second");
  });

  it.each([{ port: "second" }, { channel: "beta" as const }, { generation: 2 }])(
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

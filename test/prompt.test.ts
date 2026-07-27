import type { SyncChange } from "../src/engine/sync";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { colorEnabled, confirmViaStdin, createBatchDecider, createInteractiveDecider, stdinIsInteractive } from "../src/engine/prompt";

interface TTY { isTTY?: boolean }
const stdin = process.stdin as TTY;
const stdout = process.stdout as TTY;
const origIn = stdin.isTTY;
const origOut = stdout.isTTY;
const origNoColor = process.env.NO_COLOR;

afterEach(() => {
  stdin.isTTY = origIn;
  stdout.isTTY = origOut;
  if (origNoColor === undefined) {
    delete process.env.NO_COLOR;
  } else {
    process.env.NO_COLOR = origNoColor;
  }
});

describe("stdinIsInteractive", () => {
  it("is true only when both stdin and stdout are TTYs", () => {
    stdin.isTTY = true;
    stdout.isTTY = true;
    expect(stdinIsInteractive()).toBe(true);

    stdout.isTTY = false;
    expect(stdinIsInteractive()).toBe(false);

    stdin.isTTY = false;
    stdout.isTTY = true;
    expect(stdinIsInteractive()).toBe(false);
  });
});

describe("colorEnabled", () => {
  it("is false on a TTY when NO_COLOR is set, true otherwise", () => {
    stdout.isTTY = true;
    delete process.env.NO_COLOR;
    expect(colorEnabled()).toBe(true);

    process.env.NO_COLOR = "1";
    expect(colorEnabled()).toBe(false);
  });

  it("is false on a non-TTY", () => {
    stdout.isTTY = false;
    delete process.env.NO_COLOR;
    expect(colorEnabled()).toBe(false);
  });
});

describe("confirmViaStdin", () => {
  /** Drive the prompt against a fake stdin of `chunks`. Pass none for an immediate EOF. */
  async function confirmWith(chunks: string[], defaultYes?: boolean): Promise<boolean> {
    const fake = Readable.from(chunks) as Readable & { isTTY?: boolean };
    fake.isTTY = true;
    const original = Object.getOwnPropertyDescriptor(process, "stdin");
    const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    Object.defineProperty(process, "stdin", { value: fake, configurable: true });
    try {
      return await confirmViaStdin("Proceed?", defaultYes);
    } finally {
      writeSpy.mockRestore();
      if (original) {
        Object.defineProperty(process, "stdin", original);
      }
    }
  }

  const answer = async (input: string, defaultYes?: boolean): Promise<boolean> => confirmWith([input], defaultYes);

  it("defaults to NO: only an explicit yes returns true", async () => {
    expect(await answer("y\n")).toBe(true);
    expect(await answer("yes\n")).toBe(true);
    expect(await answer("n\n")).toBe(false);
    expect(await answer("\n")).toBe(false);
  });

  it("with defaultYes: empty / anything-but-no returns true", async () => {
    expect(await answer("\n", true)).toBe(true);
    expect(await answer("yes\n", true)).toBe(true);
    expect(await answer("whatever\n", true)).toBe(true);
    expect(await answer("n\n", true)).toBe(false);
    expect(await answer("no\n", true)).toBe(false);
  });

  // readline never invokes the question callback on EOF, so this promise used to
  // hang unsettled: the event loop drained and the process exited 0 mid-command with
  // no report at all. The 2s cap keeps that regression a failure, not a stalled suite.
  it("treats EOF (Ctrl-D) as a decline", async () => {
    expect(await confirmWith([])).toBe(false);
  }, 2000);

  it("an abort is not consent: EOF declines a default-YES prompt too", async () => {
    // The distinction that matters: an EMPTY ANSWER takes the default (true), EOF
    // must not. Resolving EOF as "" would silently turn Ctrl-D into a yes.
    expect(await answer("\n", true)).toBe(true);
    expect(await confirmWith([], true)).toBe(false);
  }, 2000);

  it("treats EOF after an unsubmitted partial line as a decline", async () => {
    // "y" with no Enter. This declines because the pending `question` callback is
    // bypassed on close, NOT because the buffer is dropped: readline does flush it
    // as a `line` event.
    //
    // So the decline is contingent on using `rl.question`. Rework `confirmViaStdin`
    // to `rl.on("line")` and the flushed "y" WOULD be delivered, silently turning
    // Ctrl-D-after-partial-input into an accept. Keep this green through any such
    // refactor.
    expect(await confirmWith(["y"])).toBe(false);
  }, 2000);

  it("carries EOF through the interactive decider as a skip", async () => {
    // The decider is unchanged, it just sees `false`. Pinning the whole chain is
    // what proves EOF can no longer strand a run with no decision at all.
    const decider = createInteractiveDecider({
      confirm: async () => confirmWith([]),
      renderDiff: () => "",
      write: () => {},
    });
    const conflict: SyncChange = { path: "f", strategy: "full", kind: "conflict", before: "a", after: "b" };
    expect(await decider(conflict)).toBe("skip");
  }, 2000);
});

describe("createInteractiveDecider", () => {
  const conflict: SyncChange = { path: "f", strategy: "full", kind: "conflict", before: "a", after: "b" };
  const reconcile: SyncChange = { path: "g", strategy: "merge", kind: "reconcile", before: "a", after: "b" };

  it("renders a preview and accepts on yes", async () => {
    const out: string[] = [];
    let question = "";
    const decider = createInteractiveDecider({
      confirm: async (q) => {
        question = q;
        return true;
      },
      renderDiff: () => "DIFF\n",
      write: t => out.push(t),
    });

    expect(await decider(conflict)).toBe("accept");
    expect(out.join("")).toContain("DIFF");
    expect(out.join("")).toContain("[CONFLICT] f");
    expect(question).toContain("Overwrite");
  });

  it("skips on no", async () => {
    const decider = createInteractiveDecider({ confirm: async () => false, renderDiff: () => "", write: () => {} });
    expect(await decider(reconcile)).toBe("skip");
  });
});

describe("createBatchDecider", () => {
  const safe: SyncChange[] = [
    { path: "a", strategy: "block", kind: "reconcile", before: "x", after: "y" },
    { path: "b", strategy: "merge", kind: "create", before: null, after: "z" },
  ];

  it("previews each change, asks ONE default-YES question, and accepts", async () => {
    const out: string[] = [];
    let question = "";
    let defaultYes: boolean | undefined;
    const decider = createBatchDecider({
      confirm: async (q, d) => {
        question = q;
        defaultYes = d;
        return true;
      },
      renderDiff: () => "DIFF\n",
      write: t => out.push(t),
    });

    expect(await decider(safe)).toBe("accept");
    expect(out.join("")).toContain("[reconcile] a");
    expect(out.join("")).toContain("[create] b");
    expect(out.filter(t => t === "DIFF\n")).toHaveLength(2);
    expect(question).toContain("Apply 2 safe managed-file updates?");
    expect(defaultYes).toBe(true);
  });

  it("declines on no, skipping the whole safe set", async () => {
    const decider = createBatchDecider({ confirm: async () => false, renderDiff: () => "", write: () => {} });
    expect(await decider(safe)).toBe("skip");
  });

  it("uses a singular noun for a single change", async () => {
    let question = "";
    const decider = createBatchDecider({
      confirm: async (q) => {
        question = q;
        return true;
      },
      renderDiff: () => "",
      write: () => {},
    });
    await decider([safe[0] as SyncChange]);
    expect(question).toContain("Apply 1 safe managed-file update?");
  });
});

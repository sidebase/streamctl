import { vi } from "vitest";

/**
 * Capture a stream instead of discarding it. Command test files stub both stdout and
 * stderr to `() => true` in `beforeEach`; call one of these from a test that needs to
 * read the writes back. The later `vi.spyOn` replaces the earlier stub, and
 * `vi.restoreAllMocks()` in `afterEach` undoes both.
 */
function capture(stream: "stdout" | "stderr"): string[] {
  const writes: string[] = [];
  vi.spyOn(process[stream], "write").mockImplementation((chunk: unknown) => {
    writes.push(String(chunk));
    return true;
  });
  return writes;
}

export function captureStdout(): string[] {
  return capture("stdout");
}

export function captureStderr(): string[] {
  return capture("stderr");
}

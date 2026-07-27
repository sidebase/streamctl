import type { StreamctlErrorCode } from "./errors";

/** Maps an error `code` to its process exit code. Success (`0`) is handled by the reporter, not here. */
export function exitCodeFor(code: StreamctlErrorCode | string): number {
  switch (code) {
    case "CONFLICTS_PENDING":
      return 2;
    case "DRIFT_DETECTED":
      return 3;
    case "OUTDATED":
      return 4;
    default:
      return 1;
  }
}

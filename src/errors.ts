export type StreamctlErrorCode
  = | "ALREADY_INITIALIZED"
    | "PROFILE_DETECT_FAILED"
    | "REGISTRY_AUTH_FAILED"
    | "NOT_A_REPO"
    | "CONFLICTS_PENDING"
    | "CONFIG_PKG_MISSING"
    | "CONFIG_VERSION_MISMATCH"
    | "CONFIG_INVALID"
  // Missing, unreadable or malformed `presets/manifest.json` or preset files.
  // Structural zod failures surface as CONFIG_INVALID instead.
    | "PAYLOAD_INVALID"
  // Payload manifest `schemaVersion` this CLI does not understand: the CLI/payload
  // contract broke, so upgrade one side or the other. Thrown by the manifest loader.
    | "SCHEMA_UNSUPPORTED"
    | "NOT_INITIALIZED"
  // Reserved. A profile / detected-framework mismatch is a soft `logger.warn` and
  // never thrown, because payload-declared detection can be absent or wrong and
  // hard-failing would block valid setups.
    | "PROFILE_MISMATCH"
    | "WRITE_FAILED"
  // The package-manager install during `upgrade` failed (nypm throws a raw Error),
  // so the new payload never landed. The transactional flow rolls the bump back and
  // re-throws this tagged `rolledBack`. Exit code 1.
    | "INSTALL_FAILED"
  // A transactional `upgrade` rollback could not restore the pre-upgrade tree: the
  // snapshot restore itself failed, so the repo needs a manual `git restore`.
  // `details` carries the per-file restore status plus a recovery command. Thrown
  // only by `engine/upgrade.ts`. Exit code 1.
    | "ROLLBACK_FAILED"
  // A managed file could not be read for a non-ENOENT reason (EACCES, EISDIR, ELOOP).
  // Carries the relativized path + errno code, never the raw fs message (which embeds
  // the absolute path). Exit code 1.
    | "READ_FAILED"
    | "DRIFT_DETECTED"
    | "OUTDATED"
    | "NO_NEWER_VERSION"
    | "TARGET_NOT_FOUND";

/** Carries a stable `code` and optional `details`, which feed the `--json` error shape. */
export class StreamctlError extends Error {
  readonly code: StreamctlErrorCode;
  readonly details?: unknown;

  constructor(code: StreamctlErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "StreamctlError";
    this.code = code;
    this.details = details;
  }
}

/** True for Node fs errors carrying a string `.code` (ENOENT, EACCES, and so on). */
export function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

/**
 * An fs error's errno code (`ENOENT`, `EACCES`, …); `"unreadable"` for anything
 * unrecognized. Use this instead of the raw `error.message`, which embeds the
 * absolute path and would leak into `--json` output.
 */
export function errnoCode(error: unknown): string {
  return isErrnoException(error) && error.code !== undefined ? error.code : "unreadable";
}

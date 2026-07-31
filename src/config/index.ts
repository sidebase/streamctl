import type { StreamctlConfig } from "./types";

export * from "./types";

/**
 * Identity helper for `streamctl.config.ts`: gives editor inference and flags
 * unknown keys while returning the config unchanged. Generic over `T` so a payload
 * can build its own typed wrapper and keep its narrower field types.
 */
export function defineStreamctlConfig<T extends StreamctlConfig>(config: T): T {
  return config;
}

import type { StreamctlConfig } from "../config/types";
import { StreamctlError } from "../errors";
import { readConfigPath } from "./render";

/**
 * Truthiness of a directive condition: `true`, a non-empty string or a non-empty
 * array. Absent, `false`, `""` and `[]` are false; any other type is an error.
 */
export function evaluateCondition(config: StreamctlConfig | undefined, path: string, filePath: string): boolean {
  const value = readConfigPath(config, path);
  if (value === undefined || typeof value === "boolean") {
    return value === true;
  }
  if (typeof value === "string") {
    return value !== "";
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  const found = value === null ? "null" : typeof value;
  throw new StreamctlError(
    "CONFIG_INVALID",
    `${filePath}: condition "${path}" has a ${found} value in the config, which cannot be used as a condition (boolean, string or string[] expected).`,
    { file: filePath, condition: path, reason: "unevaluable-value", found },
  );
}

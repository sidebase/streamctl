// Public payload-authoring contract, re-exported at the CLI package's `./manifest`
// subpath so a payload package validates its own presets against the same source
// of truth the CLI loads them with.
export * from "./schema";

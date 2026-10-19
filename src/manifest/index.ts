// Public payload-authoring contract, re-exported at the CLI package's `./manifest`
// subpath so a payload package validates its own presets against the same source
// of truth the CLI loads them with, including scanning templates for directives.
export type { CommentSyntax } from "../comment-syntax";
export { commentSyntaxFor } from "../comment-syntax";
export type { DirectiveBlock, DirectiveErrorDetails, DirectiveReason } from "../directives";
export { scanDirectives } from "../directives";
export * from "./schema";

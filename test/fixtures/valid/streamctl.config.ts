export default {
  package: "@acme/payload",
  base: "nuxt-app",
  version: "1.2.3",
  profile: "nuxt-4",
  versionSync: true,
  versionSyncExclude: ["devDependencies.typescript"],
  eslint: { zod: "full", trpcGuard: true },
  aptPackages: ["openssl"],
  ci: { unitTests: true, deploy: ["staging", "production"] },
  files: { ".vscode/settings.json": "off" },
};

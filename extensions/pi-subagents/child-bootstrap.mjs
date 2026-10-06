// JavaScript entry point: Node cannot strip TypeScript inside installed node_modules.
// Reuse the selected Pi SDK's jiti dependency; no build or second SDK installation.
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const sdkPath = process.argv[2];
const require = createRequire(sdkPath);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, {
  alias: { "@earendil-works/pi-coding-agent": sdkPath },
});
try {
  const { runChild } = await jiti.import(new URL("./child-runner.ts", import.meta.url).href);
  // These are not public SDK exports. Reuse the selected installation's CLI
  // built-ins and canonical trust policy instead of maintaining copies or
  // accepting the SDK's default projectTrusted=true. Package tests gate both
  // internal dependencies until upstream exposes them publicly.
  const { resolveProjectTrusted } = await import(new URL("./core/project-trust.js", pathToFileURL(sdkPath)));
  const { builtInExtensions } = await import(new URL("./extensions/index.js", pathToFileURL(sdkPath)));
  await runChild({ resolveProjectTrust: resolveProjectTrusted, builtInExtensions });
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
// Extensions may retain resources even after shutdown; the parent sweeps the group.
process.exit(process.exitCode ?? 0);

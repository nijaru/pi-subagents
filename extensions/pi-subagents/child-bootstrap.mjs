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
  // Pi 0.87 does not export its trust resolver from the public SDK. Use the
  // selected installation's canonical policy rather than duplicating it or
  // accepting the SDK's default projectTrusted=true. Package tests gate this
  // pinned internal dependency until upstream exposes the resolver publicly.
  const { resolveProjectTrusted } = await import(new URL("./core/project-trust.js", pathToFileURL(sdkPath)));
  await runChild(resolveProjectTrusted);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
// Extensions may retain resources even after shutdown; the parent sweeps the group.
process.exit(process.exitCode ?? 0);

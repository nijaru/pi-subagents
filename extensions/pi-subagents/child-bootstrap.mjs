// JavaScript entry point: Node cannot strip TypeScript inside installed node_modules.
// Reuse the selected Pi SDK's jiti dependency; no build or second SDK installation.
import { createRequire } from "node:module";
const sdkPath = process.argv[2];
const require = createRequire(sdkPath);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, {
  alias: { "@earendil-works/pi-coding-agent": sdkPath },
});
try {
  const { runChild } = await jiti.import(new URL("./child-runner.ts", import.meta.url).href);
  await runChild();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
// Extensions may retain resources even after shutdown; the parent sweeps the group.
process.exit(process.exitCode ?? 0);

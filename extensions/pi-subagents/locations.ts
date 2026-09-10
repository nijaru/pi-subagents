import * as fs from "node:fs";

export function existingDirectory(directory: string): string {
  try {
    if (fs.statSync(directory).isDirectory()) return fs.realpathSync.native(directory);
  } catch { /* Report one actionable diagnostic for missing and invalid paths. */ }
  throw new Error(`Working directory does not exist: ${directory}`);
}

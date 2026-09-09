import * as fs from "node:fs";
import * as path from "node:path";

export function existingDirectory(directory: string): string {
  try {
    if (fs.statSync(directory).isDirectory()) return fs.realpathSync.native(directory);
  } catch { /* Report one actionable diagnostic for missing and invalid paths. */ }
  throw new Error(`Working directory does not exist: ${directory}`);
}

/** Subdirectories and symlink aliases still share a repository's write domain. */
export function projectRoot(cwd: string): string {
  let current = cwd;
  let packageRoot: string | undefined;
  while (true) {
    if ([".git", ".hg", ".jj"].some((name) => fs.existsSync(path.join(current, name)))) return current;
    if (!packageRoot && ["package.json", "Cargo.toml", "go.mod", "pyproject.toml", "deno.json", "deno.jsonc"].some((name) => fs.existsSync(path.join(current, name)))) packageRoot = current;
    const parent = path.dirname(current);
    if (parent === current) return packageRoot ?? cwd;
    current = parent;
  }
}

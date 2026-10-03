/**
 * Locating what the suites need, on any machine.
 *
 * jiti is a devDependency, so `npm install` is the normal path. The fallbacks
 * exist so the suites also run against pi's bundled copy without an install.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** Absolute path to jiti's CommonJS entry point. */
export function findJiti() {
  // 1. A local devDependency (the documented path: `npm install`).
  try {
    return require.resolve("jiti/lib/jiti.cjs");
  } catch {
    // fall through
  }

  // 2. An explicit override.
  if (process.env.PI_JITI_PATH) {
    return path.join(process.env.PI_JITI_PATH, "lib", "jiti.cjs");
  }

  // 3. The copy inside pi's managed install, which is version-directoried.
  for (const root of candidateRoots()) {
    const candidate = path.join(root, "jiti", "lib", "jiti.cjs");
    if (existsSync(candidate)) return candidate;
  }

  throw new Error(
    "Cannot find jiti. Run `npm install`, or point PI_JITI_PATH at pi's node_modules directory.",
  );
}

/** Directories that may hold pi's bundled dependencies. */
function candidateRoots() {
  const roots = [];
  if (process.env.PI_ROOT) roots.push(process.env.PI_ROOT);

  const bin = findPiBin();
  if (path.isAbsolute(bin)) {
    // The managed layout is <agent-dir>/bin/pi with releases under
    // <agent-dir>/install/releases/<version>/node_modules.
    // PATH may expose ~/.local/bin/pi as a symlink to the managed launcher.
    const resolvedBin = existsSync(bin) ? realpathSync(bin) : bin;
    const agentDir = path.resolve(path.dirname(resolvedBin), "..");
    const releases = path.join(agentDir, "install", "releases");
    const current = path.join(agentDir, "install", "current-version");
    if (existsSync(current)) {
      roots.push(path.join(releases, readFileSync(current, "utf8").trim(), "node_modules"));
    }
    if (existsSync(releases)) {
      for (const version of readdirSync(releases)) {
        roots.push(path.join(releases, version, "node_modules"));
      }
    }
    roots.push(path.join(agentDir, "npm", "node_modules"));
  }

  roots.push(path.join(homedir(), ".pi", "agent", "npm", "node_modules"));
  return roots;
}

/** Installed Pi package entry point for isolated registration/SDK tests. */
export function findPiPackage(name) {
  try {
    return require.resolve(name);
  } catch {
    for (const root of candidateRoots()) {
      try {
        return require.resolve(name, { paths: [root] });
      } catch {
        // Pi's public entry can be import-only, which require.resolve rejects.
        const manifest = path.join(root, name, "package.json");
        if (existsSync(manifest)) {
          const pkg = JSON.parse(readFileSync(manifest, "utf8"));
          const entry = path.resolve(path.dirname(manifest), pkg.main ?? "index.js");
          if (existsSync(entry)) return entry;
        }
      }
    }
  }
  throw new Error(`Cannot find ${name}; set PI_ROOT to pi's node_modules directory. Searched: ${candidateRoots().join(", ")} (pi: ${findPiBin()})`);
}

/** The pi binary: from the environment, or resolved from PATH. */
export function findPiBin() {
  if (process.env.PI_BIN) return process.env.PI_BIN;
  try {
    const found = execFileSync("sh", ["-c", "command -v pi"], { encoding: "utf8" }).trim();
    return found || "pi";
  } catch {
    return "pi";
  }
}

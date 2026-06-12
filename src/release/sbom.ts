// Phase 6: SBOM generation.
//
// A release should ship with a bill of materials: every file that shipped (with its
// content hash) and, if a package manifest is present, the declared dependencies.
// Deterministic CycloneDX-shaped output so two builds of the same tree produce an
// identical SBOM.

import { sha256hex } from "../core/canonical.ts";
import type { Sbom, SbomComponent } from "../objects/types.ts";

export interface FileEntry {
  path: string;
  content: string;
}

export function generateSbom(files: FileEntry[]): Sbom {
  const components: SbomComponent[] = [];

  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    components.push({ type: "file", name: f.path, hash: sha256hex(f.content) });

    // Declared dependencies from a package.json count as library components.
    if (f.path.endsWith("package.json")) {
      try {
        const pkg = JSON.parse(f.content) as {
          dependencies?: Record<string, string>;
          devDependencies?: Record<string, string>;
        };
        for (const [name, version] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies }).sort())
          components.push({ type: "library", name, version });
      } catch {
        // malformed manifest → skip its deps, keep the file component
      }
    }
  }

  return { bomFormat: "CycloneDX", specVersion: "1.5", components };
}

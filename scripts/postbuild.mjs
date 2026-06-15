// Post-build fixups for the published artifact (run after `tsc -p tsconfig.build.json`).
//
// The source CLI shebang requests type-stripping (`-S node --experimental-strip-types`)
// so the raw `src/cli.ts` is directly executable in development. The COMPILED bin
// (dist/cli.js) is plain JS, so it must use a clean `node` shebang — otherwise every
// consumer who runs `avcs` would force-enable an experimental TS flag that does not exist
// on older Node and is pointless on JS. We also set the executable bit npm expects on a bin.
import { readFile, writeFile, chmod } from "node:fs/promises";

const bin = new URL("../dist/cli.js", import.meta.url);
const src = await readFile(bin, "utf8");
const fixed = src.startsWith("#!")
  ? src.replace(/^#!.*\r?\n/, "#!/usr/bin/env node\n")
  : `#!/usr/bin/env node\n${src}`;
await writeFile(bin, fixed);
await chmod(bin, 0o755);
console.log("postbuild: normalized dist/cli.js shebang + chmod 755");

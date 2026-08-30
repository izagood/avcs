// Resolve the config home in an ORDINARY process (not under `node --test`), so the guard
// in issue #107 can be shown not to affect normal use. Prints the path and exits.
import { configHome } from "../../src/api/keystore.ts";
console.log(configHome());

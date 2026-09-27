/**
 * A one-place shim for `node:sqlite`.
 *
 * ## Why this exists
 *
 * The ledger wants SQLite with no native build step, and Node 22.5+ ships it as
 * a builtin. But the test runner cannot resolve it:
 *
 * ```
 * Error: Failed to load url sqlite (resolved id: sqlite). Does the file exist?
 * ```
 *
 * The cause is a stale list, not a missing module. Vite 5 decides what is a
 * builtin from Node's `builtinModules` (`vite/dist/node/chunks/dep-*.js`,
 * `const nodeBuiltins = builtinModules.filter(id => !id.includes(":"))`), and on
 * Node 22.22 that array does **not** contain `sqlite` — `node:sqlite` is still
 * flagged experimental, so it is absent from the list. The runner therefore
 * strips the `node:` prefix and looks for an npm package called `sqlite`.
 *
 * Declaring it external in `vitest.config.ts` does not help: the prefix is
 * stripped during transform, before externalisation is consulted.
 *
 * ## The fix
 *
 * `createRequire` hands resolution back to Node, which has always known about
 * the module:
 *
 * ```js
 * node -e "require('node:module').createRequire(process.cwd()+'/x')('node:sqlite')"
 * ```
 *
 * One shim, so every other file imports `node:sqlite` normally and the
 * workaround stays greppable. If a future Vite fixes its list this file becomes
 * deletable without touching a single call site.
 */

import { createRequire } from "node:module";
import type * as NodeSqlite from "node:sqlite";

const nodeRequire = createRequire(import.meta.url);

/** `DatabaseSync`, resolved by Node rather than by the bundler's builtin list. */
export const DatabaseSync: typeof NodeSqlite.DatabaseSync = (
  nodeRequire("node:sqlite") as typeof NodeSqlite
).DatabaseSync;

/** True when this runtime has `node:sqlite`. Lets callers degrade politely. */
export function hasSqlite(): boolean {
  try {
    nodeRequire("node:sqlite");
    return true;
  } catch {
    return false;
  }
}

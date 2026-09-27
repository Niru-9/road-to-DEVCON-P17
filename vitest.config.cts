/**
 * Test configuration.
 *
 * Note the extension: this file is `.cts`, not `.ts`, and it must stay that
 * way. This is not a style preference - it works around a real failure.
 *
 * Vite loads a config file by bundling it with esbuild and then importing the
 * result. On the ESM path that means writing a temporary `.mjs` file into
 * `node_modules/.vite-temp/`, importing it, and unlinking it. On a network
 * drive that write intermittently fails with `EPERM` (antivirus or the SMB
 * layer holding the file open), and the failure happens *before any test runs*:
 *
 *   Error: Vite received EPERM writing its temporary config bundle.
 *
 * The CJS path - which a `.cts` extension selects - uses `require` with an
 * esbuild `_compile` hook and writes no temporary file at all. See
 * `loadConfigFromBundledFile` in `vite/dist/node/chunks/config.js`: the
 * `isESM` branch does the `writeFile`/`unlink` dance, the `else` branch does not.
 *
 * Renaming this to `vitest.config.ts` will reintroduce the bug. If the suite
 * starts failing on config load, check this first.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The live suite needs real testnet credentials and real funds. It is
    // excluded from the default run and opted into with `npm run test:live`.
    // Note: `tests/live.test.ts` and `vitest.live.config.cts` are not written
    // yet, so `npm run test:live` currently fails on a missing config rather
    // than skipping. That is deliberate and visible: a silent skip would read
    // as a passing live run.
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/live.test.ts", "node_modules/**"],
    environment: "node",
    testTimeout: 20_000,
    server: {
      deps: {
        // Vite 5's builtin list predates `node:sqlite`, so it strips the `node:`
        // prefix and tries to resolve a package called "sqlite". Declaring it
        // external keeps the import intact and lets Node load the builtin.
        // The runtime is unaffected - this only affects how the test runner
        // transforms the module.
        external: ["node:sqlite"],
      },
    },
  },
});

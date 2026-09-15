/**
 * Ambient declarations for the Node APIs used by this module's vitest test
 * files (fixture replay reads the oracle goldens from tests/fixtures/).
 *
 * The runtime code in this package stays runtime-agnostic: only Web
 * Standard APIs. These declarations keep the test files type-checkable
 * under the package tsconfig, which does not include Node's ambient types,
 * without adding a dependency the implementer is not allowed to install.
 */
declare module 'node:fs' {
  export function readFileSync(path: string | URL, encoding: string): string
  export function existsSync(path: string | URL): boolean
  export function readdirSync(path: string | URL): string[]
}

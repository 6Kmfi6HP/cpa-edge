/**
 * @cpa-edge/translators - package root.
 *
 * Direction modules live at their own subpaths (`@cpa-edge/translators/<dir>`);
 * the contract suites import them there. This root re-exports the MERGED
 * direction facades as namespaces so platform runtimes can compose them
 * without reaching into package internals. Namespacing keeps colliding
 * helper names (e.g. `HeaderList` per direction) unambiguous. The
 * integrator adds one line per direction as it merges.
 */
export * as oai2cla from './oai2cla/index'
export * as gem2oai from './gem2oai/index'
export * as gem2cla from './gem2cla/index'

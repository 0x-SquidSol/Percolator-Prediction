/**
 * Percolator prediction-markets SDK additions.
 *
 * Staging package for the TypeScript surface that ships with prediction
 * markets — instruction builders for the new on-chain tags, the V13
 * `MarketConfig` parser, shared discriminated-union types for resolution
 * outcomes and market kinds, and helpers for computing slippage-bounded
 * `limit_price_e6` values from a live mark plus a slippage tolerance.
 *
 * Merges into `@percolatorct/sdk` 3.0 at launch. Until then this package is
 * private and is consumed only from sibling workspaces inside
 * `Percolator-Prediction` (the keeper / indexer / integration tests).
 *
 * The current commit is an empty placeholder so the TS toolchain can verify
 * `tsc --noEmit` against the workspace. Subsequent commits add real exports.
 */

export {};

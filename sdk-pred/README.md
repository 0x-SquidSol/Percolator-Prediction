# sdk-pred

Staging TypeScript package for the Percolator prediction-markets SDK surface. Merges into `@percolatorct/sdk` 3.0 at launch.

This package holds the client-side code that any off-chain consumer (the launch frontend, the keeper, the indexer, the integration tests) needs in order to interact with the new on-chain prediction-market instructions and the extended slab layout.

## Scope

| Surface | What it does |
|---|---|
| Instruction builders | Produce ready-to-sign Solana `TransactionInstruction`s for the new on-chain tags — resolve, init, dispute, claim, settle. |
| V13 `MarketConfig` parser | Decodes the 64-byte prediction-markets tail appended to the slab's `MarketConfig` struct on `dcccrypto/percolator-prog`. |
| Shared types | `MarketKind`, `ResolutionOutcome`, `ResolverMode`, plus the discriminated-union payload shapes returned by the indexer's `/api/prediction/*` routes. |
| Slippage helpers | `computeLimitPriceE6` and direction-aware helpers used by every wallet-signing path to translate "I'll accept X bps of slippage" into a `limit_price_e6` field on the trade instruction. |

## What's here

| File | Role |
|---|---|
| `package.json` | npm manifest (workspace member). Private — does not publish independently. |
| `tsconfig.json` | Strict TypeScript config. `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, and the rest of the paranoid flag set. |
| `src/index.ts` | Package entrypoint. Placeholder today; real exports land in subsequent commits. |

## Status

Placeholder scaffold. Subsequent commits add the instruction builders, V13 parser, shared types, and slippage helpers. Each surface ships as its own atomic commit with unit tests against fixtures generated from the matcher and the wrapper.

## Related

- Repo root [README](../README.md) — overall workspace layout and roadmap.
- Spec — [`PREDICTION-MARKETS-PROPOSAL.md`](../PREDICTION-MARKETS-PROPOSAL.md), section 8.3 (API surface) and section 2 (on-chain instruction layouts the builders target).

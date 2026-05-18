# match-pred

LMSR matcher binary for Percolator prediction markets. Sibling to the upstream [`percolator-match`](https://github.com/dcccrypto/percolator-match) reference matcher.

This is a Solana BPF program. It implements a bounded automated market maker using the Logarithmic Market Scoring Rule for binary-outcome (YES / NO) markets:

- LP maximum loss is finite — bounded by `b × ln(2)` for the LMSR liquidity parameter `b`.
- Prices are bounded to the open interval `(0, 1)`.
- Quotes are well-defined at zero open interest.

The matcher conforms to the same `MatcherCall` / `MatcherReturn` CPI ABI as the reference matcher, so the upstream `percolator-prog` `TradeCpi` path invokes it without changes.

## What's here

| File | Role |
|---|---|
| `Cargo.toml` | Crate manifest (workspace member). |
| `src/lib.rs` | Library entrypoint. Placeholder today; implementation lands in subsequent commits. |

## Status

Placeholder scaffold. Subsequent commits add:

- Fixed-point exponential / logarithm primitives (Remez polynomial approximation).
- The LMSR cost function `C(q) = b · ln(exp(q_yes/b) + exp(q_no/b))`.
- `MatcherCall` / `MatcherReturn` parsing.
- The Solana BPF target wiring — `cdylib` crate type, `#![no_std]`, `solana-program` dependency, `entrypoint!` registration.
- Property tests for math invariants.

## Related

- Repo root [README](../README.md) — overall workspace layout and roadmap.
- Spec — [`PREDICTION-MARKETS-PROPOSAL.md`](../PREDICTION-MARKETS-PROPOSAL.md), section 3 (matcher math, curve choice, ABI conformance).

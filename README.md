# Percolator-Prediction

Prediction markets integration for the [Percolator](https://github.com/dcccrypto) protocol. Solana-native event markets, settled on-chain, ultimately launchable by anyone.

## Status

**Phase 0 — Design.** This repo currently contains the integration proposal only. Implementation begins after team review and sign-off.

## What's here today

- [`PREDICTION-MARKETS-PROPOSAL.md`](./PREDICTION-MARKETS-PROPOSAL.md) — full integration proposal covering on-chain architecture, risk-engine reuse, the LMSR matcher curve, fee economics, user journeys, the V1 admin-gated rollout, the V2 permissionless transition, resolution oracle design, audit scope, and a 16-18 week timeline.

## What will live here once implementation begins

| Component | Description |
|---|---|
| `match-pred/` | LMSR matcher binary (Solana BPF) — bounded AMM for binary outcomes |
| `keeper-pred/` | Off-chain TypeScript services for resolution + settlement crank |
| `indexer-pred/` | Off-chain TypeScript services for resolution-event indexing + Supabase migrations |
| `sdk-pred/` | SDK additions (instruction builders for tags 35-38, V13 config parser) |
| `tests/` | End-to-end devnet integration tests across the full lifecycle |

The wrapper changes to [`percolator-prog`](https://github.com/dcccrypto/percolator-prog) (4 new instruction tags, `MarketConfig` V13 extension, `TradeCpi` band-check carve-out) and the risk-engine changes to [`percolator`](https://github.com/dcccrypto/percolator) (`resolve_market_refund_not_atomic`) live as feature branches on those upstream repos rather than in this repo. See Section 14 of the proposal for the merge plan.

## Related repos

- [`dcccrypto/percolator-prog`](https://github.com/dcccrypto/percolator-prog) — Solana BPF program wrapper
- [`dcccrypto/percolator`](https://github.com/dcccrypto/percolator) — risk engine (`no_std` Rust crate)
- [`dcccrypto/percolator-matcher`](https://github.com/dcccrypto/percolator-matcher) — reference matcher (CPI target)
- [`dcccrypto/percolator-stake`](https://github.com/dcccrypto/percolator-stake) — insurance LP staking layer
- [`dcccrypto/percolator-keeper`](https://github.com/dcccrypto/percolator-keeper) — off-chain keeper bot
- [`dcccrypto/percolator-indexer`](https://github.com/dcccrypto/percolator-indexer) — off-chain indexer
- [`dcccrypto/percolator-launch`](https://github.com/dcccrypto/percolator-launch) — Next.js frontend + 3 backend services

## License

To be aligned with the upstream Percolator protocol license at implementation kickoff.

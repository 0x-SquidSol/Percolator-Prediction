# tests/ — Integration test harness

End-to-end devnet-targeted scripts that exercise full prediction-market lifecycles. **Not** unit tests — those live alongside the code they test (Rust `#[cfg(test)]` modules in `match-pred/`, vitest in `sdk-pred/`, frontend tests in the upstream `percolator-launch` feature branch).

## Scope

| Scenario | Verifies |
|---|---|
| Lifecycle | Launch → trade → resolve → dispute-window → settle → claim works end-to-end |
| Multi-trader | Concurrent fills don't corrupt accounts-bitmap or matcher state |
| INVALID / refund | `resolution_outcome = 3` returns collateral net of fees, not 0/1 settlement |
| Multisig-stuck | After `resolution_deadline_unix + 7d` without a sig, `ResolvePermissionless` settles at 24h-EWMA |
| Dispute upheld | Disputer bond returned + reward; original resolver flagged |
| Dispute rejected | Disputer bond forfeited to insurance fund |
| Simulation harness | 1000 random trades + resolve + walk every position → sum-of-payouts identity within ε |

## Running

(Pending: scenario implementations. The package is set up and typechecks today; scripts land in subsequent commits.)

Once deps are installed:

```
pnpm typecheck
pnpm test
```

## Requirements when tests are real

- Devnet RPC URL with sufficient quota.
- Burner keypair with devnet SOL.
- Active deployment of `feat/prediction-markets` programs (engine + wrapper + matcher binary) at known program IDs — pinned in a fixture file.
- Supabase devnet project (the indexer's prediction tables must exist).

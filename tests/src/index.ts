/**
 * End-to-end integration test harness for Percolator prediction markets.
 *
 * This package holds devnet-targeted scripts that exercise full prediction-
 * market lifecycles against deployed feature-branch programs:
 *
 *   - launch -> trade -> resolve -> dispute-window -> settle -> claim
 *   - multi-trader concurrent fills
 *   - INVALID / refund resolution
 *   - multisig-stuck -> permissionless-resolution failsafe
 *   - simulation harness: N random trades, resolve at terminal price,
 *     verify sum-of-payouts identity (Sum(payout_i) <= Sum(collateral_i)
 *     + b * ln(2))
 *
 * Rust property tests live inside the `match-pred` crate as `#[cfg(test)]`
 * modules — they exercise the LMSR math invariants and run as part of
 * `cargo test`. The integration harness here is purely off-chain
 * orchestration.
 *
 * The current commit is a placeholder so `tsc --noEmit` runs cleanly
 * against the workspace. Subsequent commits add the scenario scripts.
 */

export {};

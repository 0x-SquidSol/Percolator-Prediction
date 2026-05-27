# Prediction Markets on Percolator — Integration Proposal

**Status:** Draft v2 — for internal review
**Scope:** End-to-end proposal for integrating leveraged perpetual futures on Polymarket prediction markets into the Percolator protocol. Covers product positioning, on-chain mechanics, the Polymarket oracle bridge, risk-engine reuse, fee economics, off-chain services, and a phased rollout (V1 team-launched → V2 permissionless).

---

## TL;DR (executive summary)

1. **Percolator provides Solana-native leverage on Polymarket prediction markets.** Traders open up to 5x perpetual positions on the implied probability of any Polymarket market — long if they think the probability will move up, short if down. They can close anytime, get liquidated if the underlying moves against them past their margin buffer, or hold to Polymarket's terminal resolution where the position snaps to 0 or 1.

2. **The matcher and engine are reused.** No new matcher binary, no native prediction-market resolution authority, no dispute system on our side. The active `dcccrypto/percolator-match` oracle-anchored spread quoter is fed a Polymarket-derived probability and behaves exactly as it does today for any other perp. The `dcccrypto/percolator` risk engine's existing `resolve_market_refund_not_atomic` method (already shipped on the `feat/prediction-markets` branch) handles Polymarket-INVALID inheritance and oracle-death emergency unwind on the same code path.

3. **One new on-chain primitive: the Polymarket oracle adapter.** A keeper-signed snapshot mechanism fed by a hybrid oracle source — Pyth where available, custom keeper for the long tail, Switchboard as a middle-ground option. The wrapper verifies signer + monotonic timestamp + deviation guard before the engine consumes the price.

4. **V1: team-launched perps on Polymarket's largest markets.** Phase 1 targets markets whose underlying is a Pyth-feed price threshold (e.g., "BTC closes above $X on date Y") — Pyth provides the oracle, no custom infrastructure required. ~6-12 launch markets, hand-curated.

5. **V2: permissionless launches with up to 8% creator fees.** Anyone bonds 10 SOL plus a market seed deposit and launches a perp on any Polymarket market. Creator earns up to 8% of trading fees. The bond is slashable on protocol-defined misbehavior (binding to a manipulable underlying, sudden launch-then-bail patterns) but NOT on Polymarket-side resolution outcomes.

6. **Leverage cap: 5x.** Bounded-domain math gives closed-form worst-case loss per unit. The engine enforces an asymmetric leverage clamp: full 5x at implied `p ∈ [0.20, 0.80]`, 2x at `p ∈ [0.10, 0.20] ∪ [0.80, 0.90]`, opens rejected entirely outside `[0.10, 0.90]`.

7. **Net new on-chain code: ~700 lines.** Wrapper-side oracle adapter + four new instructions (`LinkPolymarketMarket`, `PushOracleSnapshot`, `TerminalSnap`, `EmergencyUnwind`, plus a Council-gated `EmergencyRelink`). Engine and matcher unchanged from existing production code.

8. **Audit scope is small.** ~3-4 weeks single senior auditor for the new wrapper surface, plus a one-time `percolator-match` conformance audit for the bounded `[0, 1]` price domain. Materially smaller than a native-prediction-markets build because the resolver / dispute / matcher attack surface lives at Polymarket, not at us.

---

## Section 1 — Product positioning & strategy

### 1.1 The pitch

**External:** *"Up to 5x perpetual leverage on any Polymarket market. Launch your own perp on any market and earn fees."*

Percolator is a coin-margined perpetual futures protocol on Solana. We give traders leverage on price-shaped, derivative-shaped, and event-shaped underlyings. Prediction markets are a natural next category — Polymarket has thousands of markets with multi-billion-dollar historical volume, and there is no leverage layer on top of them today. We provide that layer.

**Competitive frame:**

- **vs. Polymarket directly:** we add leverage and Solana speed onto the same markets. Traders keep using Polymarket for spot exposure; they use Percolator when they want leveraged exposure to the *path* the probability takes between launch and resolution.
- **vs. coin-margined SOL/USD perps (Drift, dYdX, Hyperliquid):** we trade what they can't — markets whose underlying is an event, an opinion, or a soft signal rather than a unit-of-account price.

We are not displacing Polymarket; we are extending their universe of underlyings onto a leverage primitive they do not natively offer.

### 1.2 One product, one launchable shape

Single product, single launchable shape: a perp slab with `market_kind = 2` (PerpOnPolymarket) bound to a specific Polymarket market via the oracle adapter. The trader UI is a single trade page; the launcher UI is a single discovery + wizard flow. No native prediction-spot product, no native LMSR matcher, no native resolution authority.

The slab is the matcher's home; the matcher feeds it a Polymarket-derived probability; the engine handles margin and liquidation as it does today for any other perp.

### 1.3 Brand-risk framing

Polymarket is CFTC-regulated and US-geofenced. We provide a Solana-side derivative on their markets. The brand-risk story is meaningfully different from a native-prediction-markets product:

- **We do not resolve.** Polymarket resolves; UMA handles disputes. Our protocol inherits whatever outcome Polymarket finalizes. We have no resolver-as-attacker surface, no dispute-bond-gaming surface, no fee-farm-then-INVALID surface.
- **We do have a curated-launch V1.** Even though we don't resolve, we choose which Polymarket markets get a perp listed against them. V1 is team-curated; V2 is permissionless with a bond + cooling-pool soft moderation.
- **Counsel sign-off required before V1 launch.** A leveraged derivative on a CFTC-watched venue that is globally accessible from Solana has non-zero regulatory exposure. The framing "we are a leverage layer on Polymarket, Polymarket runs the underlying" helps but is not a shield. V1 geofencing decisions should mirror Polymarket's geofencing where possible.

---

## Section 2 — On-chain architecture

### 2.1 Recommended shape: a configuration variant of the perp slab

Add `market_kind = 2` (PerpOnPolymarket) to the existing `MarketConfig` discriminator. A PerpOnPolymarket slab is a standard perp slab with three differences:

- The matcher is fed a Polymarket-derived probability (via the oracle adapter, §3) instead of a SOL/USD oracle reading.
- The slab is bound to a specific Polymarket market via `polymarket_condition_id`.
- Margin parameters are tuned for the bounded `[0, 1]` probability domain (5x cap, asymmetric clamp — see §4.3).

Engine code, matcher binary, insurance fund, and ADL machinery are unchanged. The new work is concentrated in the wrapper (`percolator-prog`) — primarily the oracle adapter — and in the off-chain stack (`percolator-keeper`, `percolator-indexer`) that feeds it. Engine and matcher reuse is the load-bearing architectural property.

### 2.2 `MarketConfig` field set under the pivot

An earlier wrapper commit on `feat/prediction-markets` introduced the V13 `MarketConfig` layout for a then-planned native-prediction-markets product. Under the current scope several fields are retained for layout compatibility but flagged as deprecated:

| Field | Status under pivot |
|---|---|
| `market_kind: u8` | KEEP — discriminator (0 = Perp, 1 = reserved for future native prediction, 2 = PerpOnPolymarket) |
| `resolution_oracle: [u8; 32]` | REPURPOSE as `oracle_keeper_authority` — the multisig signer authorized to push oracle snapshots for `market_kind = 2` |
| `resolution_open_unix`, `resolution_deadline_unix` | DEPRECATE — Polymarket controls timing; we read these from the oracle adapter, not from on-chain config |
| `creator_bond_lamports` | KEEP — V2 launcher bond (10 SOL) |
| `resolution_outcome: u8` | KEEP — mirrors Polymarket's terminal outcome locally (0 = unresolved, 1 = NO, 2 = YES, 3 = INVALID/refund) |
| `resolution_outcome_pending`, `ratification_deadline_unix`, `dispute_window_slots` | DEPRECATE — no native ratification or dispute under the pivot |

Three new fields land in a follow-up wrapper commit:

```rust
/// Polymarket condition-id this perp is bound to. Set at LinkPolymarketMarket
/// time, immutable thereafter (except via the Council-gated EmergencyRelink
/// admin path).
pub polymarket_condition_id: [u8; 32],

/// Oracle source discriminator. 0 = Pyth, 1 = custom keeper, 2 = Switchboard.
/// Determines which oracle-pusher's signature the wrapper accepts at
/// PushOracleSnapshot time.
pub oracle_source: u8,
pub _pad_oracle_source: [u8; 7],

/// Symbolic-bounded ring buffer of the last 60 oracle snapshots for TWAP
/// computation. Each entry is { p_yes_e6: u64, source_timestamp: i64,
/// on_chain_slot: u64 }. Tail-padded to keep MarketConfig 16-byte aligned.
pub oracle_ring_buf: [OracleSnapshotEntry; 60],
```

The ring buffer lives in-config rather than in a separate PDA so the matcher CPI can read it without an extra account-meta entry, matching the existing single-account read pattern for `last_effective_price_e6`. A 60-entry ring at 5-second nominal cadence gives a 5-minute TWAP window — long enough to defeat single-block manipulation, short enough that genuine news moves through quickly.

### 2.3 New instruction tags

The wrapper tag table has holes; we claim **40, 41, 42, 43, 44**:

| Tag | Name | V1 | V2 | Purpose |
|---|---|:-:|:-:|---|
| 40 | `LinkPolymarketMarket` | ✓ | ✓ | Bind a perp slab to a Polymarket condition-id + oracle source. Admin-only in V1, permissionless-with-bond in V2. One-shot per slab. |
| 41 | `PushOracleSnapshot` | ✓ | ✓ | Keeper-multisig-signed write of a fresh Polymarket-derived probability into the slab's ring buffer. Wrapper verifies signer + monotonic timestamp + deviation guard. |
| 42 | `TerminalSnap` | ✓ | ✓ | Permissionless cranker. Fires when Polymarket reports a finalized outcome. Translates outcome → `resolved_price` and routes to the existing `ResolveMarket` (tag 19) settlement path. |
| 43 | `EmergencyUnwind` | ✓ | ✓ | Permissionless cranker. Fires when the oracle is stale beyond the configured threshold. Settles every position at the last valid TWAP minus a 200 bps conservativeness haircut routed to insurance. |
| 44 | `EmergencyRelink` | ✓ | ✓ | Council 3-of-5 timelocked tag for repointing a slab to a different oracle source if the original one becomes unreliable. 48h timelock waived under attested oracle-failure conditions. |

Tags 35-39 (previously reserved on the same branch for native-prediction-markets handlers `InitPredictionMarket`, `ResolvePredictionMarket`, `DisputeResolution`, `ClaimBond`, `ResolveInvalidFinalize`) are released back to the unclaimed pool.

### 2.4 Existing wrapper hot-path changes

Two surgical edits in the existing `TradeCpi` (tag 10) handler:

1. **Band-check carve-out (~30 lines)** — band floor widened to 200 bps for `market_kind = 2` markets. Probability extremes need wider absolute-tolerance bands; a 1% band at `p ≈ 0.99` is barely above rounding.
2. **Oracle source for `read_price_and_stamp`** when `market_kind = 2` — read the TWAP-clamped value from `oracle_ring_buf` instead of an external Pyth/Hyperp source.

Both changes are local and isolated to dispatch-time branching on `market_kind`.

### 2.5 `PushOracleSnapshot` handler (tag 41)

The load-bearing new instruction. Pseudocode:

```rust
Instruction::PushOracleSnapshot { p_yes_e6, source_timestamp } => {
    accounts::expect_len(accounts, 4)?;
    let a_keeper_signer = &accounts[0];
    let a_slab = &accounts[1];
    let a_clock = &accounts[2];
    let a_second_source = &accounts[3]; // indexer-maintained second-source feed

    accounts::expect_signer(a_keeper_signer)?;
    accounts::expect_writable(a_slab)?;
    let mut data = state::slab_data_mut(a_slab)?;
    slab_guard(program_id, a_slab, &data)?;
    require_initialized(&data)?;

    let mut config = state::read_config(&mut data);
    if config.market_kind != 2 {
        return Err(ProgramError::InvalidInstructionData);
    }

    // Signer must match the registered oracle keeper authority.
    let expected = Pubkey::new_from_array(config.resolution_oracle);
    if a_keeper_signer.key != &expected {
        return Err(PercolatorError::ExpectedSigner.into());
    }

    let clock = Clock::from_account_info(a_clock)?;

    // Monotonicity: the source timestamp must be strictly greater than the
    // most recent entry in the ring buffer.
    let last_entry = ring_buf_last(&config.oracle_ring_buf);
    if source_timestamp <= last_entry.source_timestamp {
        return Err(PercolatorError::NonMonotonicTimestamp.into());
    }

    // Domain clamp: p_yes_e6 must be in [10_000, 990_000] for engine math.
    let clamped = p_yes_e6.clamp(POLY_CLAMP_LO, POLY_CLAMP_HI);

    // Deviation guard: reject snapshots that deviate from the rolling TWAP by
    // more than the configured threshold (default 300 bps). Combined with
    // the second-source-disagreement check below, this is the primary
    // defense against a compromised keeper.
    let twap = ring_buf_twap(&config.oracle_ring_buf);
    if abs_deviation_bps(clamped, twap) > MAX_ORACLE_DEVIATION_BPS {
        return Err(PercolatorError::OracleDeviation.into());
    }

    // Second-source sanity check: the indexer maintains an independent
    // Polymarket REST poll in a separate PDA; if it disagrees with the
    // keeper-submitted price by more than the threshold, halt and require
    // Council EmergencyRelink before further writes accepted.
    let second_source = read_second_source_pda(a_second_source)?;
    if abs_deviation_bps(clamped, second_source.p_yes_e6) > MAX_SECOND_SOURCE_DEVIATION_BPS {
        return Err(PercolatorError::SecondSourceDisagreement.into());
    }

    // Append the new entry, displacing the oldest.
    ring_buf_push(&mut config.oracle_ring_buf, OracleSnapshotEntry {
        p_yes_e6: clamped,
        source_timestamp,
        on_chain_slot: clock.slot,
    });
    state::write_config(&mut data, &config);
    Ok(())
}
```

`LinkPolymarketMarket`, `TerminalSnap`, `EmergencyUnwind`, and `EmergencyRelink` are each ~30-60 lines and follow the same pattern: signer verification, state transition, write.

### 2.6 Polymarket terminal-outcome inheritance

Polymarket markets terminate with one of three states:

- **YES** — the CTF token redeems for 1.0. Our perp's `TerminalSnap` translates to `resolved_price = 1_000_000` (engine e6 units) and routes through the existing `ResolveMarket` settlement path.
- **NO** — CTF redeems for 0.0. `resolved_price = 1` (we avoid 0 to keep the existing `InvalidAccountData` guard semantic intact).
- **INVALID** — UMA dispute outcome resolves the market as ambiguous; Polymarket sets `0.5/0.5` and traders redeem at half-and-half.

For YES/NO our perp behaves like any other terminal-snap perp. For INVALID we cannot terminal-snap to a single price because the underlying split. The engine's existing `resolve_market_refund_not_atomic` method (already shipped on `feat/prediction-markets`) handles this — it detaches every open position at zero unrealized PnL, preserves trader collateral, and leaves protocol fees with LPs and the protocol. The same method also services the emergency-unwind path when our oracle becomes unreliable independent of any Polymarket resolution event.

The refund-mode engine work plus its Kani harness suite (covering empty market, single-account-no-position, single-account-with-position, two-account-bilateral, preservation-of-untouched-fields, and the four precondition-rejection cases) already cover this lifecycle. No new engine code is needed for terminal inheritance.

### 2.7 Insurance fund coverage

Unchanged from the existing perp design. The engine handles "payout exceeds LP collateral" via `engine.insurance_fund.balance` → ADL via `adl_mult_long` / `adl_mult_short`. Insurance fund is sized at perp launch per §4.5.

---

## Section 3 — Polymarket oracle bridge

This is the load-bearing new piece. The matcher needs a probability value to quote off; that value has to come from Polymarket, which runs on Polygon, while we run on Solana. The oracle bridge is how we cross that gap.

### 3.1 The fundamental problem

Polymarket markets are conditional tokens (CTFs) on Polygon. Their implied probability at any moment is the marginal price of the YES CTF token in Polymarket's AMM. There is no native Pyth feed for "the implied probability of Polymarket market X" because Pyth's publishers do not (today) publish that quantity.

We therefore need to bridge Polygon → Solana for the price signal. Three approaches, each with trust trade-offs:

### 3.2 Source A: Pyth (price-threshold markets)

For Polymarket markets whose underlying is a measurable on-Pyth quantity (price thresholds — "BTC closes above $150k on Dec 31"), we do not need to mirror Polymarket at all. We read the Pyth feed directly and compute the implied probability from the time-decay-toward-threshold function. The Polymarket market still exists; it just isn't the oracle.

Coverage: ~10-50 Polymarket markets at any time. Limited to the price-threshold genre. Fully trust-decentralized; Pyth's publisher set is the security model.

Default for V1 launch slate.

### 3.3 Source B: Custom keeper (sentiment / event markets)

For markets whose underlying is sentiment ("Trump wins 2028 at p ≈ 0.42") there is no native Pyth feed. We run a keeper bot — a 2-of-3 Squads-multisigned service — that polls Polymarket's REST API and pushes a signed snapshot to the slab via `PushOracleSnapshot` every 5 seconds.

Trust model: the keeper signer is fully trusted to submit a Polymarket-faithful price. Mitigations:

- **2-of-3 Squads multisig** required as `oracle_keeper_authority`, one external co-signer, monthly rotation.
- **HSM-backed signing where feasible** (Turnkey, Fireblocks).
- **On-chain per-slot move clip** (`max_price_move_bps_per_slot = 500` for keeper-sourced markets, tighter than Pyth's 2000).
- **Indexer-maintained second-source PDA** (§7.2) that independently polls Polymarket; `PushOracleSnapshot` rejects any submission deviating by >300 bps from the second source.
- **Canary trades** from a separate watcher account proving the keeper is honest (small, regular, scripted).

This is the highest-risk surface in the protocol under the pivot.

### 3.4 Source C: Switchboard (middle ground)

Switchboard On-Demand can run a custom oracle job that scrapes Polymarket REST. Trust is improved relative to a 1-of-1 keeper (federated quorum of off-chain runners), but worse than Pyth's publisher economics. Latency is acceptable for our 5-minute TWAP window.

Used in V2 as the default oracle for community-launched perps. Creators can upgrade to a custom keeper by posting an additional 25 SOL keeper-bond on top of the launch bond.

### 3.5 Hybrid routing summary

| Phase | Oracle defaults |
|---|---|
| V1 (team-launched, 6-12 markets) | Pyth for price-threshold markets, custom keeper for the rest. All 2-of-3 multisig. |
| V2 (permissionless) | Switchboard On-Demand by default. Custom keeper available as a creator-upgrade with additional bond. |

### 3.6 Emergency-unwind protocol (oracle-source-agnostic)

When the oracle becomes unreliable — regardless of source — the protocol must execute this sequence:

1. **Detection.** Any of: staleness > `MAX_ORACLE_STALENESS_SLOTS` (~12 seconds), deviation > 300 bps vs second-source PDA, Pyth confidence-interval > 100 bps, Switchboard quorum below threshold, custom-keeper deviation alarm fires.
2. **Halt.** `EmergencyUnwind` (tag 43) becomes permissionlessly callable; on call, the slab transitions to `EmergencyHalted` and new opens are rejected. Existing positions remain open at the last valid TWAP minus a 100 bps preliminary haircut.
3. **15-minute grace window.** If the oracle resumes and the new reading agrees with the pre-halt TWAP within 100 bps, the slab auto-resumes.
4. **Escalation at 15 minutes.** Council 3-of-5 has 2 hours to either (a) re-source the oracle via `EmergencyRelink` (tag 44), or (b) trigger orderly unwind.
5. **Orderly unwind.** Every position closes at the last valid 24h EWMA minus a 200 bps conservativeness haircut routed to insurance. Never settle at zero. Never settle at last-trade. Never wait indefinitely.
6. **Post-incident postmortem.** Mandatory within 7 days. The oracle source for that market type is reviewed and potentially downgraded for new markets.

The non-negotiable property: **the protocol always has a terminal exit, even when its oracle is dead.** The 24h-EWMA-minus-haircut path is the deterministic exit, and the insurance fund eats the haircut. This is the single most important property of the protocol under the pivot — without it, a Polymarket-side hack would become a Percolator-side bank run.

### 3.7 LP UX implications

Perp LPs (junior + senior tranches of the existing `dcccrypto/percolator-stake` infra) deposit USDC and earn a share of trading fees. Capital is locked for the lifetime of the underlying Polymarket market plus a 48-hour buffer (mirrors Polymarket's UMA dispute window plus our orderly-unwind grace) and the existing per-tranche cooldown extends accordingly. Free withdrawal during this window would give LPs a free option versus locked traders.

---

## Section 4 — Risk engine adaptations

### 4.1 Funding rate: zero, hard-coded

For `market_kind = 2`, the perp's oracle IS the underlying matcher mid (Polymarket-derived). There is no external "true price" to anchor a basis against, and holding the perp long is economically equivalent to holding YES CTF spot — funding would be a pure leverage tax on traders. Mirror the existing zero-funding pattern: `funding_k_bps = 0`, `funding_max_premium_bps = 0`, `funding_max_e9_per_slot = 0`. Engine funding code becomes a no-op for this market kind.

The UI keeps the funding row visible (`Funding: 0.00% / 8h`) so we can enable it later — for example to discourage long-dated open interest pinning LP capital — without a frontend release.

### 4.2 Liquidation: existing machinery, tightened price-move bound

The existing liquidation engine (`KeeperCrank` with `LiquidationPolicy::FullClose`) is the right primitive. Configuration tightens for the bounded-domain product:

- `max_price_move_bps_per_slot = 2_000` (20% per slot) — tighter than the perp default but looser than would suit a SOL/USD perp. The 5-minute TWAP smooths legitimate news; this clip catches manipulation attempts.

### 4.3 Margin parameters & the bounded-domain insight

Standard perps oracle off an unbounded price. A PerpOnPolymarket oracles off `p ∈ [10_000, 990_000]` e6. Three consequences shape every parameter below.

1. **Worst-case loss per unit is closed-form, not stochastic.** A long opened at entry `p₀` loses at most `p₀` per unit notional (mark → 0). A short opened at `p₀` loses at most `1 − p₀` per unit. The engine integrates max loss exactly across the OI book without statistical tail estimation.
2. **Margin should be asymmetric near the bounds.** A long at `p = 0.95` has upside 0.05 and downside 0.95 — symmetric `initial_margin_bps` over-funds upside and under-funds downside. We solve this with a leverage-cap shaping function (banded clamp), not a notional tweak, because shaping leverage preserves the existing `initial_margin_bps` field semantics.
3. **Per-unit-time volatility is bounded.** `p` cannot legitimately move more than 1.0 over the market's entire life. Funding math that assumes log-returns is meaningless; we hard-zero funding (§4.1).

Base margin params:

| Param | Coin-margined SOL perp | `PerpOnPolymarket` |
|---|---:|---:|
| `initial_margin_bps` | 500 (20x) | **2_000 (5x)** |
| `maintenance_margin_bps` | 250 | **1_300** |
| `max_price_move_bps_per_slot` | 500 | **2_000** |
| `max_active_positions_per_side` | matcher LP `b` × 100% | underlying Polymarket OI × 20% |

The MM ratio (1_300 / 2_000 = 65%) sits in the industry-standard band (Drift, dYdX, Hyperliquid all 1.4-1.6:1).

**Asymmetric overlay — engine-enforced, not UI-restricted.** The UI exposes the 5x slider unconditionally; the engine recomputes the cap from `p₀` at trade time and rejects if requested leverage exceeds it:

```
denom = max(p₀, 1 − p₀)
if denom ≤ 0.80:    cap = 5x          # full 5x in [0.20, 0.80]
elif denom ≤ 0.90:  cap = 2x          # soft asymmetry zone
else:               reject_open       # outside [0.10, 0.90], no new opens
```

Closes are always permitted regardless of `p`. Effective `initial_margin_bps` is `10_000 / cap`, so the 2x band requires 5_000 bps IM and the engine raises `MarginShortfall` if the wallet does not post.

### 4.4 Liquidation trigger

Side-conditional notional, bounded by the domain:

```
notional_long(p)  = position_size × p           # max loss per unit = p
notional_short(p) = position_size × (1 − p)     # max loss per unit = 1 − p
```

Liquidation inequality:

```
equity < (maintenance_margin_bps / 10_000) × notional_side(p_mark)
```

Two clean properties fall out: (a) liquidation price for a long collapses smoothly to 0 (not asymptotically infinite), and (b) maintenance requirement automatically shrinks as the position moves into the money, releasing margin without an explicit reduce-only path.

### 4.5 Insurance fund sizing

Bounded-domain math collapses the seed formula to closed form:

```
max_aggregate_loss = Σ_longs  (entry_pᵢ × sizeᵢ)
                   + Σ_shorts ((1 − entry_pᵢ) × sizeᵢ)
```

With 5x leverage cap, max OI per side ≤ `5 × LP_collateral`. Worst-case entry `max(p, 1 − p) ≤ 0.90` (entries outside `[0.10, 0.90]` are rejected per §4.3). Conservative seed: **`insurance_seed = 1.0 × LP_collateral`** at perp launch.

This covers the one-sided-OI worst case (cluster of longs at `p = 0.10` or cluster of shorts at `p = 0.90`) rather than the uniform-distribution expected case. Slightly over-provisioned at launch, which is the correct direction.

---

## Section 5 — User journeys

### 5.1 V1 team launching a perp

Audience: Percolator core team. Route: `/admin/predict/new` (gated by `isAdmin(connectedWallet)`).

**Wizard steps:**

1. **Pick the Polymarket market.** Search bar accepts Polymarket URLs, short URLs, condition-ids, or natural-language queries. Selected market displays Polymarket question, condition-id, current implied probability, 7-day Polymarket volume, UMA resolution rules (read-only, pulled from Polymarket).
2. **Oracle source.** Pyth (auto, for price-threshold markets), custom keeper (default for sentiment markets), Switchboard (V2). V1 admin defaults: Pyth where available, custom keeper otherwise.
3. **Engine parameters.** Slab tier (default: medium, 1024 slots, V13 layout). `trading_fee_bps` (default 50 = 0.50%, slider 10-200). Collateral mint (USDC only in V1).
4. **Margin parameters.** 5x leverage cap (hard ceiling). Asymmetric clamp parameters at defaults (§4.3).
5. **Fee split.** V1: Protocol 70 / LP 30 (creator = treasury for team-launched markets). Hard min on LP: 15%.
6. **Review & sign.** Full diff view, edit affordance per row. Two-signature requirement: launch tx wraps in Squads multisig proposal.

### 5.2 V2 anonymous user launching a perp

Lives at `/create` with `Perp | Polymarket-perp` toggle (or as a dedicated `/discover` flow).

**Differences from V1:**

- **Bond: 10 SOL** at launch, sent to a `LauncherBond` PDA. Plus a creator-defined `market_seed_deposit` in USDC (sets the initial LP buffer).
- **Oracle source picker.** Pyth (auto, free), Switchboard On-Demand (default for sentiment markets, free), custom keeper (creator-multisig signed, requires additional 25 SOL keeper-bond).
- **Creator fee bps slider.** 0–800 bps (capped at 8% of trading fees). Default 200 bps (2%). The fee splits the existing trading-fee pool — protocol and LP shares are reduced when creator takes more, within hard mins per §6.1.
- **Permissionless gate at the wrapper.** `LinkPolymarketMarket` checks at tx time: Polymarket market age ≥ 14 days, Polymarket 24h volume ≥ $25k for 7 consecutive days, Polymarket open interest ≥ $50k, max single-LP share ≤ 30% of underlying liquidity. Failing any check rejects the launch.
- **6-hour cooling pool** before the perp appears in default `/discover` listings. During cooling it's only reachable by direct link. Any flag from the team multisig hides it from defaults permanently (the perp keeps trading; we can't halt it).

### 5.3 Trader leveraging a Polymarket view

1. Lands on `/discover` (browse Polymarket markets with available perps) or follows a direct link.
2. Sees the trade page. Polymarket question rendered at top with a small "On Polymarket" subtitle and a logomark (muted, monochrome — we own the chrome, Polymarket gets the attribution).
3. Chart of `p_yes` over time, with the trader's potential liquidation line overlaid as a red dashed horizontal.
4. Order ticket on the right (mobile: bottom sheet):
   - Long / Short toggle (probability-side, not YES/NO — this is a perp).
   - Leverage chips `1x | 2x | 3x | 5x` (no 4x; bigger chip targets; default 2x).
   - Size in USDC.
   - Live readouts: mark, liquidation price, max loss, funding (currently 0.00%), and an "if you hold to Polymarket resolution" callout with YES and NO terminal payouts.
5. First trade per wallet → blocking disclosure modal (§5.6).
6. Signs. Tx flows through `TradeCpi` (tag 10) → `percolator-match` matcher → engine updates position.

### 5.4 Settlement & claim

**Notifications (user opts in at first trade):**

- In-app banner on `/portfolio` once the underlying Polymarket market enters `RESOLVING`. Clears on claim click.
- Email if user added one in `/settings`: one on `RESOLVING`, one on `SETTLED`.
- Optional Discord webhook.

**Claim flow:** after the underlying Polymarket market finalizes and our `TerminalSnap` lands (or after `EmergencyUnwind` settles), the position panel becomes a single `Claim $X` button. One tx → existing `ForceCloseResolved` (tag 30). If the user never claims, after 30 days admin can call `AdminForceCloseAccount` and funds sweep to the user's wallet automatically.

### 5.5 Market lifecycle states (UI)

Five user-visible states:

- `LIVE` — normal trading.
- `HALTED` — last 4 hours before underlying Polymarket trading closes; close-only, no new positions. Banner: *"Trading halts in 47:02. Polymarket trading closes 47:02 after that. Settlement once Polymarket resolves."*
- `SETTLING` — Polymarket has reported a finalized outcome but our settlement crank hasn't fired yet. Existing positions auto-snap on `TerminalSnap` call. Banner: *"Polymarket resolved YES. Your position will close at $1.00."*
- `SETTLED` — terminal. `Claim $X` buttons.
- `FORCE_UNWIND` — emergency path with a sub-reason (oracle stale / Polymarket delisted / underlying paused). Red banner: *"This perp was unwound at last good price ($0.420). [Read the postmortem]"*

### 5.6 First-trade disclosure modal

A blocking modal on the first perp trade for any wallet (tracked client-side + server-side flag), required checkbox:

> **You're trading a leveraged perp on a market that lives somewhere else.**
>
> - The underlying question is on **Polymarket**, on a different blockchain (Polygon).
> - Polymarket — **not us** — decides whether YES or NO wins.
> - You can be **liquidated** before Polymarket resolves and lose your margin.
> - If Polymarket goes down, gets sanctioned, or the market is relisted under new rules, **your position is force-closed at the last good oracle price**. You may take a loss you did not choose.
> - If you hold to Polymarket's resolution, your position snaps to **$0 or $1** against your entry.
>
> [ ] I understand   `[Continue]`

Dismiss is one-time per wallet. This is the highest-risk error mode on the product (a user confusing our perp with Polymarket spot) and gets the only blocking modal in the entire flow.

### 5.7 Creator dashboard

Permissionless creators (V2) get `/creators/<wallet>` showing:

- Lifetime fees earned, active perps count, 24h volume across all perps launched, total open interest.
- Per-perp row: fee %, 24h volume, 24h fees earned, OI.
- Bond status: locked SOL + locked seed USDC per perp.
- Withdraw-earned-fees button (batches across all perps).

Per-trader breakdowns are NOT exposed to creators. Creators see aggregate flow only — for trader privacy and to prevent off-platform flow solicitation.

---

## Section 6 — Fee economics & creator incentives

### 6.1 Fee model

Trader pays `config.trading_fee_bps` (default 50 = 0.50%) at trade time. Split:

| Recipient | V1 default | V2 default | Hard min | Hard max |
|---|---|---|---|---|
| Protocol treasury | 70% | varies | 22% | 70% |
| Market creator | 0% (= treasury) | 0-8% (creator-set) | 0% | 8% |
| LP | 30% | varies | 30% | 60% |

The V2 split is creator-set within bounds. A creator who picks the maximum 8% leaves 92% to be split protocol/LP per the hard-min rules. LP minimum 30% protects depth providers.

### 6.2 V2 launcher bond

10 SOL at launch into a `LauncherBond` PDA. Plus a creator-defined `market_seed_deposit` in USDC for the initial LP buffer.

| Scenario | Bond outcome |
|---|---|
| Clean resolution (Polymarket-YES, Polymarket-NO, or Polymarket-INVALID), no protocol-side incident | Full refund 90d after underlying resolution |
| Sudden launch-then-bail (creator withdraws all fees within 7d of launch + market sees no further volume) | 50% slash to insurance |
| Bound to manipulable underlying (post-launch detection of Polymarket market with <$25k liquidity at link time, falsified) | 100% slash to insurance |
| Underlying delisted by Polymarket (no fault of creator) | Full refund 30d after force-unwind |

**Fee-claim cap during the bond-lock window:** 25% of accrued fees claimable in the first 30 days, regardless of volume. Remainder unlocked progressively. This deters pump-then-bail without making honest creator economics infeasible.

### 6.3 Spam protection beyond the bond

- **Per-wallet rate limit:** 1 perp per 24 hours.
- **Curated oracle-source allowlist** even in V2. Pyth and Switchboard public; custom keepers require a separate per-creator approval flow until V2.1.
- **Minimum collateral mint allowlist** — USDC + a handful of approved stablecoins only.

---

## Section 7 — Off-chain / backend changes

### 7.1 Keeper services (`dcccrypto/percolator-keeper`)

The keeper is the new oracle TCB under the pivot. Five new services:

- **`polymarketPoller.ts`** — polls Polymarket's REST API every 5 seconds for each linked market. Maintains in-memory state.
- **`pythMonitor.ts`** — subscribes to Pyth feeds for Pyth-sourced markets. Computes implied probability from price-threshold-time-decay function for those markets.
- **`oraclePusher.ts`** — wraps poller output in a Squads multisig tx and submits `PushOracleSnapshot`. 2-of-3 signature scheme; one external co-signer; monthly key rotation. HSM-backed where feasible.
- **`terminalSnapCranker.ts`** — on observing a Polymarket market resolve (via the poller), submits `TerminalSnap` to fire settlement.
- **`emergencyUnwindCranker.ts`** — fires `EmergencyUnwind` when staleness or deviation thresholds breach for >15 minutes.

The existing crank loop (`crank.ts`) requires no changes — `KeeperCrank` (tag 5) itself is unchanged for perp-on-Polymarket markets.

### 7.2 Indexer services (`dcccrypto/percolator-indexer`)

Two new pieces:

- **`polymarketLinkage.ts`** — subscribes to `LinkPolymarketMarket` events and maintains a Supabase table `polymarket_market_links` mapping condition-id ↔ slab pubkey ↔ launcher wallet.
- **Second-source REST poller** (independent of the keeper). Polls Polymarket REST every 30 seconds; writes the latest probability to a `polymarket_second_source` PDA on Solana via an indexer-controlled signer. The wrapper's `PushOracleSnapshot` reads this PDA and rejects keeper submissions deviating by >300 bps. **Critical safety component** — without this, a compromised keeper can manipulate the oracle freely.
- **`oracle_health_view`** materialized view: per-perp staleness, deviation, last-update-slot. Powers the trade-page oracle-health pill and the keeper-team's monitoring dashboards. Sentry P0 alerts fire on staleness > 30s; PagerDuty pages on deviation > 200 bps.

The previously planned `resolver_rate_view` (for native-prediction-market resolver-rate auto-rotation) is dropped under the pivot.

### 7.3 API routes (`dcccrypto/percolator-launch`)

New routes:

- `GET /api/predict/markets` — discoverable markets (Polymarket-active + linked).
- `GET /api/predict/markets/[slab]` — slab detail, oracle health, Polymarket attribution.
- `GET /api/predict/markets/[slab]/oracle-health` — staleness, deviation, last 20 ring-buffer entries.
- `GET /api/creators/[wallet]` — creator dashboard data.
- `POST /api/predict/launch` (V2) — wizard submission; constructs the `LinkPolymarketMarket` tx for client-side signing.

### 7.4 Frontend (`dcccrypto/percolator-launch`)

New route subtree:

- `app/predict/page.tsx` — discovery / market list.
- `app/predict/[slab]/page.tsx` — trade page.
- `app/creators/[wallet]/page.tsx` — creator dashboard.

New components in `app/components/predict/`:

- `PerpOnPredPanel.tsx` (trade ticket)
- `PredDisclosureModal.tsx` (first-trade modal)
- `OracleHealthPill.tsx` (top-right of trade page)
- `EmergencyUnwindBanner.tsx`
- `PolymarketAttributionFooter.tsx`
- `CreatorResolutionCard.tsx`

Extends existing components: `app/components/trade/PriceChart.tsx` (0-1 y-axis when `market_kind == 2`), `app/components/oracle/OracleFreshnessIndicator.tsx` (Polymarket-specific staleness thresholds).

The existing `TradeCpi`-based wallet code does not need to know about Polymarket specifically — same instruction, different oracle.

---

## Section 8 — Reuse vs. new

| Component | Reused as-is | Reused with changes | New |
|---|:-:|:-:|:-:|
| `dcccrypto/percolator` engine | ✓ (refund-mode method already shipped; covers Polymarket-INVALID + emergency-unwind) | | |
| `dcccrypto/percolator-prog` wrapper — `TradeCpi`, `KeeperCrank`, `ResolveMarket`, `ForceCloseResolved` | ✓ | | |
| `dcccrypto/percolator-prog` wrapper — `MarketConfig` layout | | ✓ (V13 layout shipped; new fields appended in follow-up) | |
| `dcccrypto/percolator-prog` wrapper — new oracle adapter + 5 new instruction tags | | | ✓ |
| `dcccrypto/percolator-match` (active oracle-anchored spread quoter) | ✓ (with one-time bounded-domain conformance audit) | | |
| `dcccrypto/percolator-stake` (insurance LP staking) | ✓ | ✓ (junior tranche cooldown extends to cover halt + 24h buffer) | |
| `dcccrypto/percolator-keeper` keeper loop | ✓ | | ✓ (5 new services per §7.1) |
| `dcccrypto/percolator-indexer` core | ✓ | | ✓ (second-source poller + oracle-health view) |
| `dcccrypto/percolator-launch` frontend + backend services | ✓ | ✓ (extend trade page, oracle indicator) | ✓ (new `predict/`, `creators/`, disclosure modal, etc.) |
| SDK (`@percolatorct/sdk`) | | ✓ (semver major bump for new instruction builders) | |

The reused column dominates. This is the architectural property that makes the pivot cheap to ship.

---

## Section 9 — Migration & backwards compatibility

### 9.1 Discriminating perp-on-Polymarket vs. legacy perp

`config.market_kind: u8`. Legacy perp slabs have zero-filled reserved bytes; `market_kind == 0` reads as Perp and matches existing behavior. **No migration needed for live perp markets.**

### 9.2 V13 layout already-shipped fields

The earlier `feat/prediction-markets` wrapper commit introduced the V13 layout with several fields tuned for native prediction markets (`resolution_outcome_pending`, `ratification_deadline_unix`, `dispute_window_slots`, `resolution_open_unix`, `resolution_deadline_unix`). Under the pivot these fields are deprecated-but-retained — leaving them in place is simpler than reverting the layout commit, and a future native-prediction product could reuse them. The new perp-on-Polymarket fields append to the V13 tail; legacy zero-filled reads continue to work.

### 9.3 SDK versioning

The new instruction tags (40-44) and the `MarketConfig` field additions require an SDK major bump. Ship 3.0.0 with new instruction builders and updated `parseMarketConfig` covering both the legacy-perp and perp-on-Polymarket field reads.

---

## Section 10 — Risks & testing

### 10.1 Risks the existing engine does not catch

1. **Polymarket relisting / freeze / takedown (CRITICAL).** Polymarket can delist, freeze trading, change ticker mapping, or be sanctioned mid-life. Our perp would have an open OI book and a now-dead oracle. **Mitigation:** treat a Polymarket relist/freeze as `OraclePaused` → mandatory unwind at last valid TWAP minus a 200 bps conservativeness haircut routed to insurance; do not settle at zero; do not keep trading.

2. **UMA dispute → outcome flip mid-life (HIGH).** Polymarket resolves YES (or NO); our `TerminalSnap` fires; UMA voters flip the outcome in the 48h escalation window. We have already paid winners. **Mitigation:** never `TerminalSnap` on the first Polymarket resolution proposal. Wait the full UMA challenge period (2h optimistic + 48h escalation if disputed) plus a 24h buffer before settling. Inherit Polymarket's lifecycle states explicitly: `LIVE → PROPOSED → CHALLENGED? → FINALIZED`. Halt new opens at `PROPOSED`, terminal-snap only at `FINALIZED`.

3. **Pyth feed manipulation on the underlying spot (HIGH).** For Pyth-sourced markets, attacker manipulates Pyth confidence interval to liquidate the opposite side of our book. **Mitigation:** Pyth confidence-interval guard (`conf / price < 100 bps`); minimum publisher count (≥5); EMA price not aggregate price; 60-slot TWAP on our side over Pyth's own price; reject trades when `|spot − Pyth EMA| > 200 bps`.

4. **Cross-chain bridge trust (HIGH, if applicable).** If we ever use a bridge for any market, the bridge becomes part of our oracle TCB. **Mitigation:** treat any bridge as a single-source oracle with the same staleness/deviation guards as a custom keeper. For markets with OI > $100k, require two-source agreement. Wormhole / LayerZero / Switchboard cross-chain are all single-source under this rule.

5. **Custom-keeper compromise (HIGH).** Long-tail markets without Pyth coverage rely on a keeper signer. Key compromise → write `p = 0.99` → harvest liquidations of shorts → write back. **Mitigation:** keeper signer is 2-of-3 Squads multisig with one external co-signer; on-chain per-slot move clip (`max_price_move_bps_per_slot = 500`); second-source deviation circuit-breaker; canary trades; HSM-backed signing where feasible.

6. **Permissionless launcher binds to a manipulable underlying (CRITICAL).** Anyone launches a perp on a Polymarket market with $2k of liquidity. Pre-positions, then moves the underlying with a $10k spot trade, liquidates every counterparty. **Mitigation:** wrapper-side gates at `LinkPolymarketMarket` time (§5.2); 6-hour cooling pool; bond-claim cap.

7. **8% creator-fee pump-then-bail (HIGH).** Creator inflates volume with wash trades, claims fees, then liquidates LPs. **Mitigation:** §6.2 fee-claim cap (25% of accrued in first 30 days); bond unlocked only 90 days after market resolution; canary-wash-trading detection in the indexer.

8. **Polymarket spot vs. our perp basis blowout (MEDIUM).** Funding is zero (§4.1). No economic force closes the perp-vs-spot basis. **Mitigation:** matcher spread widens hyperbolically as `|perp_mark − underlying_p| / underlying_p` exceeds 500 bps. The existing oracle-anchored spread quoter supports this via its impact-term coefficient.

### 10.2 Testing strategy

1. **Kani proofs.** The refund-mode harness suite already shipped on `feat/prediction-markets` (empty market, single-account-no-position, single-account-with-position, two-account-bilateral, preservation, four precondition rejections, end-to-end refund-then-close) covers the engine-side correctness of Polymarket-INVALID inheritance and emergency-unwind. New harnesses for the oracle adapter (`PushOracleSnapshot` monotonicity, deviation guard, second-source check) land alongside the wrapper-side commits.

2. **`percolator-match` conformance audit.** One-time external audit before V1 launch verifying the matcher's behavior under the bounded `[0, 1]` probability domain — specifically: price-type domain-agnosticism, quoter clamp behavior at boundaries, tick-size compatibility. ~3 days of one senior auditor, ~$10-15k. **Pre-mainnet, hard prerequisite.**

3. **Devnet trial.** 3-week minimum with mock-Polymarket fixtures (a stub program that mimics Polymarket CTF state on devnet). Lifecycle tests: clean YES/NO resolution, UMA-flip mid-life, oracle staleness, Polymarket-delisted, custom-keeper-compromised. Bridge failures need explicit coverage if a bridge is used for any market.

4. **Simulation harness.** Initialize a perp, generate 1000 random trades on a symbolic probability walk, fire `TerminalSnap` at terminal `p`, walk every position close, verify sum-of-payouts identity. CI-gated.

5. **External audit.** ~3-4 weeks single senior auditor (Halborn or OtterSec). Cost: $40-60k. Pre-mainnet, hard prerequisite. Scope: wrapper-side oracle adapter + new instruction tags + keeper-key custody + cross-repo trust boundary (keeper-signed PDA → wrapper verification → engine consumption).

---

## Section 11 — Phasing & rollout

### 11.1 V1 launch slate (team-launched)

**Target:** 6-12 markets where Polymarket has corresponding Pyth-driven price thresholds. Don't mirror Polymarket sentiment for V1 — that requires custom keepers we haven't seasoned yet.

Example candidates (subject to Polymarket inventory at launch time):

- "BTC closes above $X on date Y" — multiple price thresholds, multiple dates.
- "ETH closes above $X on date Y" — same.
- "SOL closes above $X on date Y" — our ecosystem flagship.

For each market, Pyth is the oracle; the implied probability is computed by the keeper as a time-decay-toward-threshold function and pushed via `PushOracleSnapshot`. Custom-keeper risk is constrained to a single mechanical computation that's easy to second-source.

### 11.2 V1 minimum-viable feature set

**Must-ship:**

- `/discover` with Polymarket-aware market list.
- `/predict/[slab]/page.tsx` trade page with oracle-health pill, liquidation-line chart overlay, "if you hold to resolution" callout.
- First-trade disclosure modal (blocking).
- Polymarket attribution component (sitewide).
- Settlement notifications (in-app banner + email).
- Public oracle-health page linked from every trade-page pill.
- `EmergencyUnwind` cranker fully wired.

**Defer to V1.1:**

- Custom-keeper-sourced markets (sentiment markets without Pyth coverage).
- Devnet play-money mode.
- Switchboard On-Demand integration.

**Defer to V2:**

- Permissionless `LinkPolymarketMarket`.
- Creator dashboard.
- 8% creator-fee mechanics.
- Cooling-pool + reporting flow.

### 11.3 V2 gate criteria

Flip to permissionless only when all of the following hold for ≥ 30 consecutive days:

- ≥ 10 V1 markets resolved cleanly (no protocol-side incident).
- ≥ $500k cumulative perp volume.
- ≥ 200 unique trader wallets.
- Insurance fund senior tranche ≥ $250k.
- Zero unresolved Sentry P0/P1 errors in the predict path for 14 days.
- Postmortem cadence holding (every emergency-unwind gets a published postmortem within 7d).

Publish a public `/predict/readiness` dashboard tracking each metric.

### 11.4 Operational responsibilities

| Role | Owner | SLA |
|---|---|---|
| V1 launch queue review | PM rotation, weekly | 24h |
| Oracle keeper key rotation | Keeper team | Monthly |
| Emergency-unwind first response | On-call eng + PM | Ack within 30 min |
| Postmortem authorship | PM on the incident | Published within 7d |
| Pyth feed health | Keeper team | Existing on-call rotation |

---

## Section 12 — Open questions for team alignment

1. **Geofencing.** Polymarket is US-geofenced; we are globally accessible from Solana. Counsel input required before V1 launch.
2. **Council seats.** The `EmergencyRelink` (tag 44) Council is 3-of-5 multisig. Two external members need naming + commitment. Suggest reaching out to Solana Foundation and a prediction-market-native ex-Polymarket / ex-Augur engineer.
3. **Insurance fund segregation.** Should the perp-on-Polymarket insurance tranche be separate from perp insurance, or shared? Recommend separate tranche, shared LP UI.
4. **Polymarket-relisting handling.** If Polymarket re-IDs a market mid-perp-life (rare but documented), what's the protocol response? Default: `EmergencyUnwind` at last-good TWAP. Consider whether Council can `EmergencyRelink` to the new condition-id with a 48h cooldown.
5. **Cross-market correlation warnings.** A trader holding $5k on four correlated Polymarket markets (e.g., four candidates in the same election) is concentrated. Surface portfolio-level correlation warnings? V1.2 flag.
6. **Polymarket attribution requirements.** Does Polymarket have terms requiring or prohibiting our use of their condition-ids and market metadata? Counsel + product check.
7. **Mobile order-ticket density.** Single trade page, single ticket. Mobile is the primary form factor for retail perp traders. Dedicated mobile-design pass before V1.
8. **OG image rendering.** Dynamic OG cards on Vercel add latency/cost. Pre-generate at launch time and CDN-cache.

---

## Section 13 — Estimated effort & timeline

| Workstream | Effort | Notes |
|---|---|---|
| `percolator-prog` wrapper: V13 field additions + oracle adapter + 5 new instruction tags | 3-4 weeks senior eng | Includes Kani proof updates for the new instructions |
| `percolator-match` bounded-domain conformance audit | 3 days senior auditor | Pre-mainnet hard prerequisite (~$10-15k) |
| `percolator-keeper` services (poller, Pyth monitor, oracle pusher, terminal-snap cranker, emergency-unwind cranker) | 3 weeks TS eng | Keeper-multisig setup is the long pole |
| `percolator-indexer` services (linkage tracker, second-source poller, oracle-health view) | 1.5 weeks TS eng | Supabase schema + on-call alerting |
| `percolator-stake` cooldown extension | 0.5 weeks Rust + TS | Constant change + UI countdown coordination |
| `percolator-launch` API routes | 1 week | Next.js handlers |
| `percolator-launch` frontend (`predict/*`, `creators/*`, components, hooks) | 4 weeks | Bulk of UX work |
| SDK 3.0 release | 1 week | New instruction builders + V13 parsers |
| Third-party external audit | 3-4 weeks single senior auditor | Pre-mainnet hard prerequisite (~$40-60k) |
| Devnet trial | 3 weeks | Hard gate before mainnet |

**Total: ~10-12 weeks from kickoff to V1 mainnet**, assuming one senior eng on wrapper + keeper, one frontend eng, one PM. **V2 permissionless adds ~3-4 weeks** for the `LinkPolymarketMarket` permissionless gate, the launcher-bond economics, the cooling pool, and the creator dashboard.

---

## Appendix A — Source-code references

All paths verified during this design pass:

- `dcccrypto/percolator/src/percolator.rs` — `no_std` risk engine. `resolve_market_refund_not_atomic` and the refund-mode Kani harness suite already shipped on `feat/prediction-markets`.
- `dcccrypto/percolator-prog/src/percolator.rs` — BPF wrapper. V13 `MarketConfig` layout already shipped on `feat/prediction-markets`. Tag dispatch, `TradeCpi` band check, `ResolveMarket` handler, `ForceCloseResolved` handler all reused unchanged.
- `dcccrypto/percolator-match` — active oracle-anchored spread quoter matcher. Reused with one-time bounded-domain conformance audit.
- `dcccrypto/percolator-stake/src/state.rs` — senior/junior tranche fields, junior-loss accounting. Cooldown extension is a single constant change.
- `dcccrypto/percolator-keeper/src/services/` — keeper service structure. New services land alongside existing crank loop.
- `dcccrypto/percolator-indexer/src/services/` — indexer service structure. New polymarket-linkage and oracle-health pieces land alongside existing trade indexer.
- `dcccrypto/percolator-launch/app/` — existing Next.js + backend services. New `predict/` and `creators/` route subtrees attach here.

## Appendix B — Hand-off notes

- **PM-UX → Engineering:** Polymarket lifecycle timing (UMA propose → challenge → finalize windows) must match the wrapper's `TerminalSnap` gating. Wizard date displays must align with on-chain timestamps.
- **Engineering → Marketing:** Polymarket attribution wording and logomark usage need brand sign-off before V1 launch.
- **Engineering → Counsel:** the §12.1 geofencing question and the §12.6 Polymarket-attribution question are the two highest-priority external dependencies. Block V1 launch on counsel sign-off for both.

---

*End of proposal. Send comments via PR to this document or in #predictions-design.*

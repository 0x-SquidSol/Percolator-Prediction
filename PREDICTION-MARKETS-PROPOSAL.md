# Prediction Markets on Percolator — Integration Proposal

**Authors:** Lead engineer + PM/UX specialist + DeFi engineering specialist (3-person design pod)
**Status:** Draft v1 — for internal review
**Scope:** End-to-end proposal for integrating prediction markets into the Percolator protocol. Covers product positioning, user journeys, on-chain mechanics, risk-engine reuse, resolution oracle design, fee economics, and rollout plan (V1 admin-gated → V2 permissionless).

---

## TL;DR (executive summary)

1. **Prediction markets fit the existing Percolator engine as a configuration variant of the perp slab, not a new program.** Engineering verification against the production `percolator-prog` wrapper confirms that `ResolveMarket` (tag 19), `ResolvePermissionless` (tag 29), and `ForceCloseResolved` (tag 30) already implement most of the settlement state machine we'd otherwise have to build. The new on-chain surface is ~1,300 lines net: 4 new instruction tags, one new matcher binary (LMSR), 64 bytes appended to `MarketConfig`, one new engine method.

2. **One product, two flavors.** A prediction market is a slab with `market_kind = 1`. The trader, LP, and admin journeys live in the existing site IA (`/markets`, `/portfolio`, `/my-markets`) with a top-level Perps/Predictions tab. Brand stays unified; the pitch becomes "*pump.fun for perps. Polymarket for everything else.*"

3. **V1: admin-gated, 4-market launch slate, Squads 3-of-5 multisig as resolution authority. No US-election markets in the V1 slate.** Reasons: brand-risk asymmetry while user base is small; lets us build resolution muscle memory on lower-stakes markets first.

4. **V2: permissionless market creation, 5 SOL creator bond, hybrid resolver model.** Creator picks a resolver mode at launch (Pyth for price-conditional markets, creator-attested for low-TVL, UMA Optimistic Oracle for high-TVL, Percolator Council for max-trust). Disputes escalate to Council 3-of-5.

5. **Trading fees split three ways**: Protocol / Creator / LP. V1 defaults Protocol 70 / LP 30 (creator = treasury). V2 defaults Protocol 30 / Creator 40 / LP 30. Hard min on LP (15%) prevents fee-stripping.

6. **Leverage cap: 2x.** `initial_margin_bps = 5000`, `maintenance_margin_bps = 3300`. Higher leverage doesn't add useful product to binary markets and dramatically widens insurance tail risk (Polymarket and Kalshi run 1x).

7. **LMSR matcher binary** (`percolator-match-pred`, ~800 lines), reuses the existing `MatcherCall`/`MatcherReturn` ABI so the wrapper's `TradeCpi` path doesn't change.

8. **Net new code is small and auditable.** 4-week single-senior-auditor engagement should suffice (~$50-80k).

---

## Section 1 — Product positioning & strategy

### 1.1 The pitch

Percolator today is **"pump.fun for perps"** — a permissionless venue where anyone deploys a leveraged perp in a single wizard step. Prediction markets are a natural extension: a market in which the underlying has a **known terminal value (0 or 1) at a known future time**. We reuse the slab, the matcher CPI, the insurance fund, the fee router. What changes is (a) the price domain (bounded to [0, 1]), (b) the oracle (resolver instead of continuous price feed), (c) the lifecycle (markets end).

**External pitch:** *"Percolator Predictions — Solana-native event markets, settled on-chain, launched by anyone."*
- vs. Polymarket: faster (Solana, not Polygon), permissionless (not US-geofenced).
- vs. Kalshi: not CFTC-gated.
- vs. Augur: actually usable.

### 1.2 One product, two flavors

These are **one product with two flavors**, not two products. Rationale:
- Same trader uses both. A SOL-perp trader will happily punt $200 on "Fed cuts in June."
- Insurance LPs, keepers, indexer are shared infra — splitting fragments liquidity.
- The slab IS a market; whether it's perp or prediction is a config bit.

**Surfacing is differentiated:**
- Top-nav inside `/markets` gains a type-toggle: `Perps | Predictions`.
- `/trade/[slab]` reads `market_kind` and renders different right-rail (YES/NO buy box vs leverage slider).
- New short-URL route `/p/<slug>` for socially-shareable prediction markets, with OG cards.

### 1.3 Brand-risk framing

Prediction markets attract Kalshi-style regulatory attention and Polymarket-style reputational risk (election-night disputes). The Percolator brand is clean today. **V1's admin-gated phase exists primarily to protect the brand**, not to protect the engine. We say so explicitly in the public roadmap.

---

## Section 2 — On-chain architecture

### 2.1 Recommended shape: special perp configuration (Option B)

After reviewing the production wrapper end-to-end, the cleanest architecture is **Option B: a `market_kind: u8` discriminator added to `MarketConfig`**, NOT a new program (Option C) and NOT a bifurcated trading path (Option A).

**Why:**
- `MarketConfig` already carries every field a prediction market needs: `collateral_mint`, `vault_pubkey`, `index_feed_id`, `last_effective_price_e6`, `mark_ewma_e6`, `permissionless_resolve_stale_slots`, `force_close_delay_slots`.
- The slab is already a `u64 price_e6` paired with a signed `i128 size`. A YES share is a long position at implied probability `p_e6 ∈ [0, 1_000_000]`. PnL accrual works unchanged: `pnl = size × (mark - entry) / 1e6`.
- `ResolveMarket` already snapshots a final `resolved_price` into the engine. For prediction markets, the resolved price IS the outcome: `1_000_000` for YES, `1` for NO. Settlement = existing `force_close_resolved_with_fee_not_atomic`, which already computes `payout = collateral + size × (resolved_price - entry_avg) / 1e6`.
- The wrapper-side `TradeCpi` band check (`|exec - oracle| × 10_000 ≤ max(2 × trading_fee_bps, 100) × oracle`) works identically when "oracle" is the implied probability.

**Option A (bifurcated trading path) is rejected because** it forks the engine's hot path. Every trade/crank/liquidate/resolve handler grows a `match config.market_kind` and breaks the Kani proofs.

**Option C (new program) is rejected because** the risk engine (`percolator` crate) is `no_std` and deliberately consumed only by `percolator-prog`. A new program would either re-link the engine (forking ABI state) or CPI into the existing slab via existing tags (adding no value). Deploys also multiply.

### 2.2 `MarketConfig` additions (V13 layout)

Append 64 bytes to the tail of `MarketConfig`, bumping `SlabHeader::version` from 12 to 13:

```rust
// === Prediction-market extension (V13 layout) ===
/// 0 = Perp (legacy default), 1 = PredictionBinary, 2 = PredictionMulti (V2+).
pub market_kind: u8,
pub _pad_kind: [u8; 7],

/// Resolution oracle pubkey. For PredictionBinary, the SIGNER required
/// to call ResolvePredictionMarket. Distinct from existing hyperp_authority
/// (which only pushes hyperp mark prices). Burnable post-resolution.
pub resolution_oracle: [u8; 32],

/// Unix timestamp at which resolution window opens.
/// ResolvePredictionMarket rejects before this.
pub resolution_open_unix: i64,

/// Unix timestamp after which permissionless settlement kicks in
/// if the resolution oracle has not acted.
pub resolution_deadline_unix: i64,

/// Dispute window in slots between ResolvePredictionMarket and when
/// ForceCloseResolved becomes callable. Mirrors existing
/// force_close_delay_slots but is the OUTCOME dispute period specifically.
pub dispute_window_slots: u64,

/// V2 only: SOL bond required to launch. Refunded on clean resolution.
pub creator_bond_lamports: u64,

/// Outcome encoding once resolved:
///   0 = unresolved, 1 = NO, 2 = YES, 3 = INVALID (refund mode).
pub resolution_outcome: u8,
pub _pad_outcome: [u8; 7],
```

Legacy perp slabs read `market_kind == 0` from zeroed reserved bytes — no migration needed.

### 2.3 New instruction tags

The wrapper's tag table has holes at 15, 16, 18, 22, 24, 25, 26, 31, 33+. We claim **35, 36, 37, 38**:

| Tag | Name | V1 | V2 | Purpose |
|---|---|:-:|:-:|---|
| 35 | `InitPredictionMarket` | | ✓ | Permissionless market creation with SOL bond |
| 36 | `ResolvePredictionMarket { outcome: u8 }` | ✓ | ✓ | Signer = `config.resolution_oracle`. Translates outcome → settlement price. |
| 37 | `DisputeResolution { reason_hash: [u8; 32] }` | | ✓ | Raises dispute, extends `force_close_delay_slots`, slashes bond on uphold |
| 38 | `ClaimBond` | | ✓ | Permissionless refund of creator bond after dispute window |

**Note:** we are NOT claiming a `SettlePosition` tag. `ForceCloseResolved` (tag 30) already does exactly that. We just rebrand it in the SDK as `settlePosition()`.

### 2.4 What changes in the existing wrapper

Only two real touches:

1. **Band-check carve-out (~30 lines)** in the `TradeCpi` handler:
   ```rust
   if config.market_kind != 0 {
       band_bps = max(band_bps, 200);  // 2% minimum band for prediction markets
   }
   ```
   Rationale: at extreme implied probabilities (p_e6 ≈ 1000 = 0.1%), a 1% band is 10 e6-units — barely above rounding. Widen to 2% min.

2. **Oracle source for `read_price_and_stamp`** when `market_kind == 1`: instead of reading the external oracle, read the matcher context's `last_p_yes_e6` (set by the matcher on every fill). This is the matcher echoing back its marginal probability.

### 2.5 `ResolvePredictionMarket` handler (tag 36)

Thin shim over the existing `ResolveMarket` path:

```rust
Instruction::ResolvePredictionMarket { outcome } => {
    accounts::expect_len(accounts, 4)?;
    let a_oracle_signer = &accounts[0];
    let a_slab = &accounts[1];
    let a_clock = &accounts[2];

    accounts::expect_signer(a_oracle_signer)?;
    accounts::expect_writable(a_slab)?;
    let mut data = state::slab_data_mut(a_slab)?;
    slab_guard(program_id, a_slab, &data)?;
    require_initialized(&data)?;

    let mut config = state::read_config(&mut data);
    if config.market_kind != 1 { return Err(ProgramError::InvalidInstructionData); }
    if config.resolution_outcome != 0 { return Err(ProgramError::InvalidAccountData); }

    // Signer = resolution_oracle (NOT admin). The new authorization path.
    let expected = Pubkey::new_from_array(config.resolution_oracle);
    if a_oracle_signer.key != &expected {
        return Err(PercolatorError::ExpectedSigner.into());
    }

    let clock = Clock::from_account_info(a_clock)?;
    if (clock.unix_timestamp as i64) < config.resolution_open_unix {
        return Err(PercolatorError::InvalidConfigParam.into());
    }

    let resolved_price_e6: u64 = match outcome {
        1 => 1u64,                  // NO  (avoid 0 — trips InvalidAccountData guard)
        2 => 1_000_000u64,          // YES
        3 => return resolve_invalid(&mut data, &mut config, clock.slot),  // refund branch
        _ => return Err(ProgramError::InvalidInstructionData),
    };

    config.resolution_outcome = outcome;
    state::write_config(&mut data, &config);

    let engine = zc::engine_mut(&mut data)?;
    engine.resolve_market_not_atomic(
        percolator::ResolveMode::Ordinary,
        resolved_price_e6,
        resolved_price_e6,
        clock.slot,
        0,  // funding_rate_e9 = 0 — prediction markets have no funding
    ).map_err(map_risk_error)?;
    Ok(())
}
```

### 2.6 Invalid/refund mode

`outcome == 3` is the catch-all for markets that cannot resolve YES or NO — the underlying event was cancelled, the resolution criteria became impossible to evaluate, or the resolver explicitly elects the refund branch.

We add **one new engine method**, `resolve_market_refund_not_atomic`, that transitions the market from `Live` to `Resolved` while leaving every trader whole on their **open positions**. The mechanism, in plain language:

- For any account with an **open position** at refund time: the position is detached at zero unrealized PnL (the "close at entry price" semantic). The position's contribution to the market's aggregate open-interest and stored-position-count is removed; the trader's `capital` is preserved.
- For any account **without** an open position at refund time: the engine does nothing. Already-closed trades stay closed — a trader who took a profit (or loss) on an earlier trade and then closed before resolution keeps that realized result. This matches the convention used by Polymarket and Kalshi for INVALID resolution.
- `engine.market_mode` transitions to `Resolved`, with the same `resolved_slot` / `current_slot` / `last_market_slot` bookkeeping as the normal resolve path. The `resolved_payout_*` snapshot fields are zero sentinels since refund mode has no terminal payout to distribute.
- After resolution, the existing `force_close_resolved_not_atomic` path lets each user withdraw their preserved `capital` (plus any `reserved_pnl` / warmup reserves that terminal-close consolidates in the existing flow).

Trading fees are NOT refunded — they were earned by LPs and the protocol during the market's life.

Two engine-level invariants shape the scope:

1. **`oi_eff_long_q == 0 && oi_eff_short_q == 0` at resolve exit** — enforced by `assert_public_postconditions_fast`. Refund mode meets this by detaching every open position before the mode transition, NOT by deferring per-account work to `force_close_resolved_not_atomic`.

2. **`sched_remaining + pending_remaining == reserved_pnl` per account** — the engine's reserve-shape invariant links warmup reserves and reserved positive PnL one-to-one. They are not separately drainable into `capital`. Refund mode therefore does NOT touch `reserved_pnl` or warmup reserves; terminal close handles them through the existing per-account consolidation.

**Sizing note:** the engine method is implemented as a private per-account helper (`refund_detach_account`) plus the public `resolve_market_refund_not_atomic` that iterates active accounts and finalizes the side reset. Combined with the matching Kani proofs in `tests/proofs_prediction.rs`, total surface is closer to 300–500 lines across the engine crate. Still a small new surface relative to the rest of the engine, and well within the audit budget described in Section 11.

### 2.7 Insurance fund coverage

The existing engine already handles "payout exceeds LP collateral":
1. `ForceCloseResolved` debits LP collateral.
2. If LP collateral hits zero, engine routes to `engine.insurance_fund.balance`.
3. If insurance hits zero, ADL kicks in via `adl_mult_long` / `adl_mult_short` (existing perp-side machinery).

This is exactly how perp insolvency works. **No new code in the engine.** We just need to size the insurance fund appropriately at market init (§4.5).

---

## Section 3 — Matcher: bounded AMM for binary outcomes

### 3.1 The hard part isn't curve math, it's where the "oracle" comes from

A subtle finding from the engineering audit: the existing `percolator-match` reference matcher is NOT a constant-product curve AMM. It's an **oracle-anchored spread quoter** — `exec_price = oracle × (1 ± total_bps/10_000)`. The "AMM" component is just an impact term added to a spread around an external oracle.

For prediction markets there's no external oracle to anchor on. The implied probability has to come from **on-chain matcher state**. That reframes the design question from "how do we clip x·y=k to [0,1]" to "how do we compute the implied probability from inventory."

### 3.2 Curve choice: LMSR

Three candidates evaluated:

| Candidate | Pro | Con | Verdict |
|---|---|---|---|
| Constant-product clipped to [0,1] | Cheap (~600 CU), simple | Liquidity dries up near 0/1; slippage explodes | Reject |
| **LMSR (Hanson)** | Bounded LP loss, smooth pricing, validated at Polymarket/Manifold scale | ~10k CU/trade for fixed-point log/exp | **PICK** |
| Constant-power-product | Hybrid | No audited Solana implementation, no intuition advantage | Reject |

**LMSR wins on two load-bearing properties:**
1. **LP max loss is finite and provable: `b × ln(2)`**. This is essential for `percolator-stake` integration — the senior tranche needs to know worst-case exposure to size its first-loss buffer.
2. **Prices are well-defined at all inventories** including `(q_yes, q_no) = (0, 0)`, so no initialization hacks.

The 10k CU overhead is acceptable (a perp trade today costs 50-80k CU end-to-end).

### 3.3 The new matcher binary: `percolator-match-pred`

Sibling to `percolator-match`, implements the same `MatcherCall`/`MatcherReturn` ABI. Internal state extends `MatcherCtx` by repurposing the existing 112-byte `_reserved` tail:

```rust
// Lives in the 112-byte _reserved tail of MatcherCtx for binary LMSR mode.
#[repr(C)]
struct BinaryLmsrState {
    /// Liquidity parameter b in e6. Higher = deeper liquidity, more LP loss.
    /// Typical: 10_000_000_000 e6 = 10k USDC equivalent.
    pub b_e6: u128,
    /// Net YES shares outstanding (signed; usually positive).
    pub q_yes_e6: i128,
    /// Net NO shares outstanding.
    pub q_no_e6: i128,
    /// Cached marginal price after last trade. Echoed to wrapper as
    /// "oracle_price_e6" for the band check.
    pub last_p_yes_e6: u64,
    pub _reserved: [u8; 48],
}
```

### 3.4 Pricing math (pseudocode)

```rust
fn quote_yes_buy(state: &BinaryLmsrState, delta_shares_e6: u128)
    -> (u64 /* exec_price_e6 */, u128 /* cost_e6 */)
{
    // Average price = (C_after - C_before) / Δ
    // where C(q) = b · ln(exp(q_yes / b) + exp(q_no / b)).
    let b = state.b_e6;
    let q_y1 = state.q_yes_e6 + delta_shares_e6 as i128;

    let c0 = lmsr_cost_e6(b, state.q_yes_e6, state.q_no_e6);
    let c1 = lmsr_cost_e6(b, q_y1, state.q_no_e6);

    let cost = (c1 - c0) as u128;
    let exec_price = (cost * 1_000_000) / delta_shares_e6;

    // Marginal price after trade — echoed as "oracle_price_e6" for band check.
    let p_yes_after = sigmoid_e6((q_y1 - state.q_no_e6) / (b as i128));
    (exec_price as u64, cost)
}
```

`lmsr_cost_e6` and `sigmoid_e6` use degree-5 Remez polynomial approximations, error bound `< 2 e6-units` over `q/b ∈ [-20, 20]`. Outside that range we saturate to 999_999 / 1.

### 3.5 LP UX implications

Unlike perp LPs (who can withdraw anytime), **prediction-market LP capital is locked until resolution.** Free-withdrawal would let an LP exit when the curve shifts adversely against them, a free option vs. traders. The UI shows this prominently — the deposit modal has a mandatory checkbox: *"I understand my liquidity is locked until <resolution_date>."*

LPs choose between two tranches (reusing `percolator-stake` infra):
- **Junior LP** — bears first directional loss if traders win net, earns the bigger fee share.
- **Senior LP** — capped upside, insurance-style protection.

---

## Section 4 — Risk engine adaptations

### 4.1 Funding rate: zero, hard-coded

For `market_kind == 1`, funding is meaningless. A YES share isn't oscillating around an external mark — its mark IS the implied probability of the same outcome.

**At `InitMarket` for prediction kinds:**
- `funding_horizon_slots = u64::MAX`
- `funding_k_bps = 0`
- `funding_max_premium_bps = 0`
- `funding_max_e9_per_slot = 0`

Existing funding code becomes a no-op. Zero new code in the engine.

### 4.2 Liquidation: keep, with higher price-move tolerance

The existing liquidation engine (`KeeperCrank` with `LiquidationPolicy::FullClose`) is the right primitive. But the engine's `max_price_move_bps_per_slot` (default ~500 bps for perps) needs to be **wider** for prediction markets — real news events legitimately move implied probabilities 50%+ in a single slot (a debate gaffe, last-minute goal).

**Recommended:** `max_price_move_bps_per_slot = 5_000` (50%/slot) for prediction markets. The engine still rejects truly absurd moves (>500%), preventing a malicious matcher from settling at 0.99 → 0.01 in adjacent slots.

### 4.3 Margin: 2x max leverage

| Param | Perp default | Prediction recommended |
|---|---|---|
| `initial_margin_bps` | 500 (20x) | **5,000 (2x)** |
| `maintenance_margin_bps` | 250 | **3,300** |

**Rationale:** Polymarket runs 1x. Kalshi runs 1x. Augur runs flexible but practically 1-2x. A single 50% probability move (on-distribution for real prediction markets) wipes a 2x position; higher leverage adds tail-risk without product value. 2x is a Percolator-native compromise that differentiates from Polymarket without recklessness.

V2 can raise leverage per-market via creator config, capped at engine `MAX_INITIAL_MARGIN_BPS`.

### 4.4 Position size cap

Set `max_active_positions_per_side = 30%` of LP `b` (LMSR liquidity). Hard cap to keep any single position smaller than the LP's bounded loss budget.

### 4.5 Insurance fund sizing

At market init, the protocol seeds the slab's insurance fund proportional to the LMSR `b` parameter. Suggested formula:

```
insurance_seed = b × ln(2)  // = LP max loss, doubled as headroom
```

This guarantees that even if LPs go to zero, the insurance fund covers payouts up to the LMSR's bounded-loss limit.

---

## Section 5 — Resolution oracle design

### 5.1 V1 — Squads 3-of-5 multisig

**Mechanism is already half-built.** The program has `SetOracleAuthority` and the slab has `oracle_authority`. We add a parallel `resolution_oracle` field (§2.2) and set it to a Squads 2-of-3 multisig at market launch. `ResolvePredictionMarket` (tag 36) requires that multisig signature.

**Members (recommended):**
- 2 founders
- 2 engineering leads
- 1 external advisor (rotating quarterly)

**Audit trail UX:**
- Every `ResolvePredictionMarket` event indexed and rendered on `/p/<slug>` as: `Resolved YES on 2026-12-31 14:02 UTC · signers: 0xab..1, 0xcd..2 · evidence: <url> · [view tx]`.
- Global ledger at `/predictions/resolutions` — public Hall of Records, sortable by date and `was-disputed`.
- Resolving admin's stat row on `/admin/resolvers`: count resolved / count disputed / count overturned.

**Failsafe:** if the multisig fails to sign within `resolution_deadline_unix + 7 days`, ANY user can call the existing `ResolvePermissionless` (tag 29), which settles at the matcher's current `p_yes_e6` time-weighted EWMA (configured for prediction markets to use a 24h-equivalent half-life via the existing `mark_ewma_halflife_slots` infrastructure). Worse than a correct resolution, but better than indefinite limbo.

### 5.2 V2 — hybrid resolver model

Five candidates evaluated:

| Candidate | Pro | Con | V2 verdict |
|---|---|---|---|
| **Pyth** | Already integrated; zero-trust for hard-data markets | Only covers price/data feeds — useless for elections, sports | **Auto-resolve for price-conditional markets only** |
| **UMA Optimistic Oracle** | Battle-tested at Polymarket; 2h challenge / 4-6d escalation | Solana-side adapter doesn't exist; ~4-6 weeks senior eng + audit | **High-TVL markets (>$50k), opt-in** |
| **Reality.eth / Augur-style** | Permissionless, fully on-chain | No mature Solana port | Skip; revisit V3 |
| Internal team multisig | Fast, controlled | Doesn't scale | V1 only |
| **Per-market designated resolver + Council appeal** | Permissionless, flexible, lets creators bring their own trust | New mechanism; needs careful dispute economics | **Primary V2 path** |

**Recommended V2 architecture:** at launch, creator picks a `resolver_mode`:

- `pyth` (free, auto, data markets only — UI gates by category)
- `creator-attested` (creator self-resolves, 0.5 SOL extra resolver-bond, default for sub-$10k TVL)
- `uma` (UMA-style, $750-equivalent proposer bond, opt-in for markets with TVL > threshold)
- `council` (Percolator Council 3-of-5 resolves, 0.25 SOL surcharge — strongest trust signal)

**All paths share dispute escalation:** any disputed resolution lands at the Percolator Council. UMA-path disputes additionally escalate to UMA token-holder vote per Polymarket's flow.

The resolver mode appears as a badge on every market card (`Pyth-verified`, `Creator-attested`, `UMA-secured`, `Council-resolved`). Traders self-select toward markets they trust.

### 5.3 Dispute mechanics

**Window:** 48 hours after `ResolvePredictionMarket` (`config.dispute_window_slots ≈ 432_000` slots at 400ms/slot).

**V1 dispute flow:**
1. User holds a non-zero position in the market at time of dispute.
2. User posts a **0.5 SOL bond** to a `DisputeBond` PDA.
3. User signs `DisputeResolution` (tag 37), flipping the slab to `DISPUTED`.
4. Resolution Council (3-of-5 multisig — three Percolator team, two external Solana figures published in docs) reviews within 72h.
5. Council signs `ResolveDispute`:
   - If original outcome confirmed → disputer loses bond to insurance fund.
   - If overturned → disputer gets bond back + 50% of treasury reward (0.25 SOL). Original resolver is publicly logged. **Three overturns within 90 days triggers admin rotation** per ops policy.

**V2 dispute UX:** bond scales with market TVL (`max(0.5 SOL, 0.1% of TVL)`). Routes to UMA Optimistic Oracle for UMA-mode markets.

---

## Section 6 — User journeys

### 6.1 V1 admin launching a market

Audience: Percolator core team (3-5 internal wallets behind a multisig). Route: `/admin/predictions/new` (gated by `isAdmin(connectedWallet)`; non-admins 404).

**Wizard steps:**

1. **Question.** `question` (max 140 chars), `short_slug` (auto-suggested), `category` (Politics/Crypto/Sports/Tech/Macro/Culture), `cover_image` (1200×630).

2. **Outcome shape.** Binary YES/NO only in V1. Multi-outcome disabled with "Coming V1.1" tooltip.

3. **Resolution.**
   - `resolution_source` (URL, shown verbatim on market page).
   - `resolution_criteria` (long-form, max 1000 chars). The exact rule deciding YES vs NO. **This is the contract with traders.**
   - `resolution_timestamp` (datetime UTC). Hard-blocks `ResolvePredictionMarket` until this slot.
   - `resolution_grace_window_hours` (default 72). Past this without resolution → emergency unwind eligible.

4. **Engine.**
   - Slab tier: medium (1024 slots) default. V12_17 layout for V1.
   - `trading_fee_bps` (default 50 = 0.50%). Slider 10-200.
   - Collateral: USDC only in V1.
   - Matcher: `PredictionAMM-v1` locked.
   - LMSR `b`: defaults from category (e.g., 10k USDC for elections, 5k for crypto, 2k for niche).

5. **Fee split.**
   - Creator wallet: prefilled with treasury multisig (editable for V2-style flows).
   - V1 default: Protocol 70 / LP 30. (V2 default: Protocol 30 / Creator 40 / LP 30.)
   - Hard min on LP: 15%.

6. **Review & Sign.**
   - Full diff view, edit affordance per row.
   - Soft AI lint on `resolution_criteria` (does it contain a date? URL? clear binary phrasing? — flag, don't block).
   - **Two-signature requirement:** launch tx wraps in Squads multisig proposal. **No single admin can launch unilaterally.**

7. **Post-launch.** Market appears in `/markets?type=predictions`, `/admin/predictions` queue with state `LIVE`. Internal Slack alert in `#predictions-ops`.

### 6.2 V2 anonymous user launching a market

Lives at `/create` (existing wizard) with a top toggle: `Perp | Prediction`.

**Differences from V1:**
- **Deposit: 5 SOL** at launch, sent to `CreatorBond` PDA.
- **Designated resolver** — mandatory field. Creator picks (a) Pyth (auto, data-only), (b) creator-attested (0.5 SOL extra resolver-bond), (c) UMA (with proposer-bond), or (d) Percolator Council (0.25 SOL surcharge).
- **Resolution SLA:** hard-coded 96 hours after `resolution_timestamp`. Miss it → emergency unwind, 50% creator bond forfeited to insurance.
- **No admin review gate** (permissionless).
- **6-hour cooling pool** between launch tx confirm and the market appearing in default `/markets` listings. During cooling, reachable only via direct link. Anyone can `Report` it; a flag from the team multisig hides it from default listings permanently (the market still trades — we can't halt it — but it's de-listed). Soft moderation that survives the permissionless promise.

### 6.3 Trader betting on YES/NO

1. Lands on `/p/<slug>` (from Twitter/Discord OG card) or `/markets?type=predictions`.
2. Sees market detail page. YES at $0.62, NO at $0.38 (always sum to $1.00 minus AMM spread).
3. Clicks `Buy YES`. Right-rail opens order ticket:
   - **Amount** (USDC). Quick chips: $10 / $50 / $100 / Max.
   - **Shares received** (live from LMSR curve). $50 USDC → 80.6 YES shares.
   - **Avg price** ($0.620 → $0.621 after slippage).
   - **Max payout** at resolution ($80.60 if YES wins).
   - **Slippage tolerance:** chip selector 0.1% / 0.5% / 1% / custom. Default 0.5%.
   - **Explicit confirm panel:** *"If YES wins, you receive $80.60. If NO wins, you receive $0.00. Resolution Dec 31, 2026."*
4. Signs. Tx flows through existing `TradeCpi` (tag 10) → `percolator-match-pred` matcher → engine updates user position.
5. Position panel updates: `YES 80.60 shares · Cost $50.00 · Mark $0.621 · Unrealized +$0.04`.

### 6.4 Settlement & claim

**Notifications (user opts in at first-trade):**
- In-app: persistent banner on `/portfolio` once market enters `RESOLVING`. Clears on claim click.
- Email (if user added one in `/settings`): one mail at `RESOLVING`, one at `RESOLVED`.
- Discord webhook (user pastes personal webhook in `/settings`): ops bot pings.

**Claim flow:** after `ResolvePredictionMarket` lands and dispute window passes, position panel becomes single `Claim $80.60` button. One tx → existing `ForceCloseResolved` (tag 30). If user never claims, after 30 days admin can call `AdminForceCloseAccount` and funds sweep to user's wallet automatically.

### 6.5 Market lifecycle states (UI)

- `LIVE` — normal trading.
- `LOCKED` — last 60 minutes before `resolution_timestamp`; no new positions, position close still permitted. Banner: *"Trading closes in 47:02. Resolution at 2026-12-31 12:00 UTC."*
- `RESOLVING` — after `ResolvePredictionMarket` signed, dispute window open. Banner: *"This market resolved YES. Disputes open until 2026-01-02 12:00 UTC. [Dispute]"*
- `RESOLVED` — terminal. `Claim` buttons. Banner: *"Resolved YES on 2026-12-31 by 0xAB...CD. Source: [link]. [View on Solscan]"*
- `UNWOUND` — emergency path. Red banner: *"This market failed to resolve and was unwound at mid-price. [Read the postmortem]"*

---

## Section 7 — Fee economics & creator incentives

### 7.1 Fee model

Total taken at trade time is `config.trading_fee_bps` (default 50 = 0.50%). Split is configurable per-market within bounds:

| Recipient | V1 default | V2 default | Hard min | Hard max |
|---|---|---|---|---|
| Protocol treasury | 70% | 30% | 25% | 70% |
| Market creator | 0% (= treasury) | 40% | 10% | 50% |
| LP | 30% | 30% | 15% | 60% |

**V1 rationale:** creator = treasury, so we don't carve out a "creator" share. Cleaner accounting. **V2 rationale:** tilt toward creators (40%) and LPs (30%) to bootstrap external creator interest and liquidity. Hard-min LP (15%) prevents attacker creator from zeroing LP cut.

The on-chain mechanism is a small **fee-router PDA** on top of the existing trading-fee path. (Implementation note: extend the existing `trading_fee_bps` distribution logic to support a 3-way split via additional config fields.)

### 7.2 V2 launch deposit: 5 SOL

**Recommended: 5 SOL** (~$1000 at recent prices).

Justification:
- Polymarket has ~$0 friction but a centralized whitelist. Augur was ~$50 + REP, too low. Kalshi requires CFTC sponsorship, too high.
- $1000 deters trivial spam without locking out a serious indie creator.
- Slashing economics (below) require enough principal to be meaningful.

**Slashing rules:**

| Scenario | Bond outcome | LP outcome | Trader outcome |
|---|---|---|---|
| Clean resolution, no dispute | Full refund after 7d | Claim normally | Claim normally |
| Resolution within SLA, dispute overturned | 50% slash to insurance, 50% to disputers | Re-settled per overturned outcome | Re-settled |
| Missed SLA (no resolution by `deadline + grace`) | 50% slash to insurance, 50% returned | Emergency unwind at mid-price | Emergency unwind at mid-price |
| Undefined resolution criteria (Council judges meaningless) | Full slash to insurance | Emergency unwind at mid-price | Emergency unwind at mid-price |
| Market never traded by `resolution_timestamp` | Full refund | n/a | n/a |

**Soft floor:** creators can stake additional SOL into the bond (visible on the market page as `Creator stake: 10 SOL`) — costly-signal mechanism. No enforced minimum past 5 SOL; we display the stake prominently so traders can self-select toward serious creators.

### 7.3 V2 spam protection beyond the bond

- **Per-wallet rate limit: 1 market per 24 hours**, enforced via creator-account PDA `["pred-creator-cooldown", creator]` storing last creation slot.
- **Curated resolution oracle allowlist** — even in V2. The set of acceptable `resolution_oracle` pubkeys lives in a protocol DAO config PDA. V2 is "permissionless market creation, curated resolvers."
- **Minimum collateral mint allowlist** — only USDC + a handful of approved stablecoins. Don't let creators denominate a 6-month presidential market in a memecoin.

---

## Section 8 — Off-chain / backend changes

### 8.1 Keeper

Two new service files (`percolator-keeper/src/services/`):

- **`predictionResolution.ts`** — polls every active prediction market every `RESOLUTION_POLL_INTERVAL_MS` (15s). For each market with `clock.unix_timestamp >= resolution_deadline_unix` AND `resolution_outcome == 0`, calls the V1 multisig endpoint or (V2) the resolution oracle's webhook. When multisig signs, submits `ResolvePredictionMarket`.

- **`predictionSettle.ts`** — on observing a `ResolvePredictionMarket` event (via indexer or program-log subscription), schedules a `ForceCloseResolved` crank at `resolved_slot + force_close_delay_slots + 1`. Walks all populated `user_idx` slots from the slab's accounts bitmap. Each `ForceCloseResolved` is ~40k CU; batch 4-8 per tx.

The existing crank loop (`crank.ts`) requires no changes — `KeeperCrank` itself is unchanged for prediction markets.

### 8.2 Indexer

New file: **`PredictionIndexer.ts`**. Subscribes to `percolator-prog` logs filtering for tag 36 (`ResolvePredictionMarket`) and tag 37 (`DisputeResolution`). Writes to two new Supabase tables:

```sql
-- prediction_resolutions
slab_pubkey       TEXT PRIMARY KEY
market_title      TEXT
outcome           SMALLINT   -- 1=NO, 2=YES, 3=INVALID
resolved_at_slot  BIGINT
resolved_at_unix  BIGINT
resolver_pubkey   TEXT
settlement_tx     TEXT
dispute_count     INT DEFAULT 0

-- prediction_disputes
id                BIGSERIAL PRIMARY KEY
slab_pubkey       TEXT
disputer_pubkey   TEXT
reason_hash       TEXT       -- IPFS pin or similar
filed_at_slot     BIGINT
status            TEXT       -- 'open' | 'upheld' | 'rejected'
```

The existing `TradeIndexer.ts` continues to capture all trades — prediction-market trades come through the same `TradeCpi` path.

### 8.3 API (Next.js `app/app/api/`)

New routes:

- **`prediction/markets/route.ts`** — `GET` list, filters: `active | resolving | resolved`.
- **`prediction/markets/[slab]/route.ts`** — `GET` detail. Returns market metadata + current `q_yes_e6`/`q_no_e6`/`p_yes_e6` from matcher context + resolution state.
- **`prediction/markets/[slab]/positions/[wallet]/route.ts`** — `GET` user position.
- **`prediction/dispute/route.ts`** (V2) — `POST`. Submits a dispute tx, takes reason text + IPFS upload, returns `dispute_id`.

### 8.4 Frontend (`app/`)

**New page tree:**
- `predict/page.tsx` — index of active prediction markets.
- `predict/[slab]/page.tsx` — detail / trade page.
- `predict/resolved/page.tsx` — settled-market history.
- `p/[slug]/page.tsx` — short-URL redirector with dynamic OG card.

**New hooks (`app/hooks/`):**
- `usePredictionMarket(slab: string)` — wraps `GET /api/prediction/markets/[slab]`.
- `usePredictionPosition(slab, wallet)` — user-side state + unrealized PnL at current `p_yes_e6`.
- `useResolution(slab)` — subscribes to resolution events via Supabase realtime.
- `useDispute(slab)` (V2) — dispute flow.

**New components (`app/components/predict/`):**
- `PredictionBetPanel.tsx` — YES/NO toggle + amount + slippage chip.
- `ResolutionBanner.tsx` — yellow during dispute window, green on settlement, red on INVALID.
- `OutcomeChart.tsx` — historical `p_yes_e6` time series.
- `ResolutionRiskPanel.tsx` — collapsible panel showing source, criteria, resolver badge, dispute mechanics. **Above the order ticket on first scroll on mobile.** Trader must scroll past resolution disclosure to bet.

The existing `TradeCpi`-based wallet code doesn't need to know about prediction markets specifically. The wallet just sets `lp_idx` to the prediction matcher's LP slot and submits — same instruction.

---

## Section 9 — Reuse vs new (concrete table)

| Component | Reused as-is | Reused with changes | New |
|---|:-:|:-:|:-:|
| `SlabHeader` struct | ✓ | | |
| `MarketConfig` struct | | ✓ (append 64-byte tail, bump version V12→V13) | |
| Slab tier sizes | ✓ | | |
| Matcher CPI ABI (`MatcherCall`/`MatcherReturn`) | ✓ | | |
| Matcher binary | | | ✓ `percolator-match-pred` (LMSR) |
| `TradeCpi` (tag 10) | ✓ (one ~30-line carve-out for `market_kind ≥ 1`) | | |
| `KeeperCrank` (tag 5) | ✓ | | |
| `ResolveMarket` (tag 19) | ✓ (admin-resolved markets only) | | |
| `ResolvePermissionless` (tag 29) | ✓ (failsafe path for both) | | |
| `ForceCloseResolved` (tag 30) | ✓ ("SettlePosition" semantics) | | |
| `ResolvePredictionMarket` (tag 36) | | | ✓ |
| `InitPredictionMarket` (tag 35, V2) | | | ✓ |
| `DisputeResolution` (tag 37, V2) | | | ✓ |
| `ClaimBond` (tag 38, V2) | | | ✓ |
| Insurance fund (`percolator-stake`) | ✓ | | |
| Engine `resolve_market_not_atomic` | ✓ (called with `funding_rate = 0`) | | |
| Engine `resolve_market_refund_not_atomic` + per-account helper | | | ✓ (for INVALID; see §2.6 for the helper-plus-iterator shape and the sizing note) |
| Engine `force_close_resolved_with_fee_not_atomic` | ✓ | | |
| Risk engine funding loop | ✓ (no-op when `funding_k_bps = 0`) | | |
| Risk engine liquidation | ✓ (different margin params) | | |
| Keeper crank loop | ✓ | | |
| Keeper resolution service | | | ✓ `predictionResolution.ts` |
| Keeper settlement service | | | ✓ `predictionSettle.ts` |
| Indexer trade ingestion | ✓ | | |
| Indexer resolution table | | | ✓ |
| Existing perp UI | ✓ | | |
| Prediction market UI | | | ✓ `predict/*`, `p/[slug]` |
| SDK | | ✓ (semver major bump) | |

**The "reused" column dominates.** The single most important architectural finding from this design exercise: prediction markets on Percolator are mostly a configuration + matcher-swap + thin shim, not a parallel program.

---

## Section 10 — Migration & backwards compatibility

### 10.1 Discriminating prediction vs. perp

`config.market_kind: u8`. Existing slabs have zero-filled reserved bytes; `market_kind == 0` reads as "Perp" and matches legacy behavior. **No migration needed for live perp markets.**

### 10.2 Slab version bump

`SlabHeader::version` goes from 12 to 13. Existing markets keep their old version; new prediction markets deploy at V13. Wrapper handlers do `match version { 0..=12 => legacy_layout, 13 => v13_layout }` for any field that moved. Since we only *append* to `MarketConfig`, legacy reads are forward-safe.

### 10.3 SDK versioning

Adding new tags requires an SDK major bump. Current is `@percolatorct/sdk` 2.x. Ship 3.0.0 with:
- All existing tag builders.
- New: `instructions.resolvePredictionMarket`, `instructions.initPredictionMarket`, `instructions.disputeResolution`, `instructions.claimBond`.
- New: `accounts.parseMarketConfigV13` (decodes appended fields).
- Old SDK methods continue working against perp markets; prediction calls are net-new.

### 10.4 Slab tier sizing

V1 prediction markets don't need 4096 user slots. Each user is in ONE slot (their open position); `max_accounts` caps concurrent open positions, not unique participants over the market's lifetime.

**Recommendation:** ship V1 at the existing **V12_17 layout (1024 slots ≈ 256 KB)** — plenty for typical political markets, matches an existing audited tier. Introduce a smaller V13_S tier (256 slots ≈ 64 KB) later if rent becomes a concern for niche markets.

---

## Section 11 — Risks & testing

### 11.1 Risks the existing engine doesn't catch

1. **Matcher misbehavior at boundary prices.** LMSR fixed-point math has bounded error (~2 e6-units), but if `p_e6` rounds to exactly 0 or 1_000_000 during a trade, the band check divides by `price` and degenerates. **Mitigation:** clamp matcher output to `[1, 999_999]` always — never 0, never 1_000_000 — until *after* resolution. Engine treats 999_999 as "essentially YES."

2. **Resolution-time slippage.** When `ResolvePredictionMarket` sets `resolved_price = 1_000_000`, every existing position has an entry far below. A user who bought YES at `p = 0.01` and won gets a 99x payout. **Insurance fund must be sized accordingly.** Track maximum-loss-per-LP-at-resolution as a separate metric; force LPs to top up if inventory implies underfunded payout.

3. **`config.resolution_oracle` key compromise.** Worse than admin compromise on a perp because attacker can settle YES at NO and drain LPs. **Mitigation:** require resolution oracle to be a Squads multisig PDA, validated at `InitPredictionMarket` time. V2 alternative: UMA optimistic oracle has its own dispute and slashing built in.

### 11.2 Worst exploit scenarios specific to prediction markets

1. **Frontrun resolution.** Trader with non-public knowledge of outcome trades large size in the last hour. **Mitigation:** at `resolution_open_unix - 1 hour`, matcher widens spreads dramatically (configurable; default 5× baseline) AND admin can call a `PauseTrading` instruction (tag 39, new — minor addition) to freeze the matcher. Same mechanic Polymarket uses ("market closes 1 hour before resolution").

2. **Last-trade manipulation.** Trader pumps `p_yes_e6` to 0.99 in the final block before `ResolvePermissionless` fires (multisig unavailable), then settles at the manipulated price. **Mitigation:** for `market_kind == 1`, `ResolvePermissionless` settles at the **time-weighted EWMA** of `p_yes_e6` over the last 24 hours, using the existing `mark_ewma_e6` infrastructure.

3. **Junior tranche LP rage-quit during volatile resolution.** Junior LPs see `p_yes_e6` swing wildly pre-resolution and try to unstake before being slashed. **Mitigation:** extend junior tranche withdrawal cooldown to span `[market_close, resolved_slot + force_close_delay_slots]`.

### 11.3 Testing strategy

1. **Unit / Kani proofs** — extend `percolator/tests/proofs_*.rs` with prediction-market invariants:
   - *"If `market_kind == 1`, `resolved_price ∈ {1, 1_000_000} ∪ sentinel`"*
   - *"Sum of payouts at settlement ≤ sum of collateral deposited"*
   - *"After `ResolvePredictionMarket`, no further trades can land"*

2. **Devnet markets** — launch 3 devnet prediction markets at varying liquidity (`b = 1k, 10k, 100k`); team manually trades through full lifecycles including: clean resolution, disputed resolution, INVALID resolution, multisig-stuck-then-permissionless resolution. **Two weeks minimum on devnet before mainnet.**

3. **Simulated resolutions** — write `scripts/simulate-prediction-resolution.ts` that initializes a market, generates 1000 random trades, freezes the matcher, calls `ResolvePredictionMarket`, walks `ForceCloseResolved` for every slot, verifies sum-of-payouts identity. Run as a CI job.

4. **Third-party audit** — scope is small (~1300 lines net new). **Target 4 weeks with one senior auditor** (Halborn or OtterSec). Cost: $50-80k. Critical because resolution authority can drain LPs if compromised.

---

## Section 12 — Phasing & rollout plan

### 12.1 V1 launch slate (recommend 4 markets)

**Hard rule: no US-election markets in V1 slate.** Regulatory and reputational risk asymmetric. Grow into that category in V1.2 after building resolution muscle memory.

| # | Market | Resolution path | Why |
|---|---|---|---|
| 1 | *"Will SOL close above $300 on Dec 31, 2026 UTC?"* | Pyth-resolvable | Our ecosystem, low-controversy, trust-building flagship |
| 2 | *"Will Solana surpass Ethereum in 7-day DEX volume in any week of 2026?"* | Council-resolved (DefiLlama-sourced) | Tests Council muscle on friendly category |
| 3 | *"Will FIFA World Cup 2026 final be won by a CONCACAF nation?"* | External-canonical (FIFA) | Broad appeal, clean resolution, ends June 2026 — fast first lifecycle |
| 4 | *"Will Anthropic/OpenAI/Google release a model scoring >90% on SWE-Bench Verified before Dec 31, 2026?"* | Council-resolved | Crypto-adjacent tech market, our exact audience |

Three resolution categories, one fast-ending market for early dogfooding. Opening insurance commitment: $50k from treasury across all four.

### 12.2 V1 minimum-viable feature set

**Must-ship:**
- `/markets` with Perps/Predictions toggle.
- `/p/<slug>` with OG card generation.
- Prediction-flavored trade page.
- LP modal with lock-until-resolution warning.
- Admin launch wizard.
- `ResolvePredictionMarket` integration into `/admin/predictions/<slab>/resolve`.
- Dispute flow (bond, freeze, Council review).
- Settlement notifications (in-app banner + email).
- Resolution & Risk panel on every prediction page.
- Public resolution ledger at `/predictions/resolutions`.

**Defer to V1.1:**
- Multi-outcome (3+) markets.
- SOL-denominated predictions.
- Discord webhook integration (low effort).
- Devnet play-money mode.

**Defer to V2:**
- V2 launch wizard with bond escrow.
- Resolver-mode selector.
- UMA integration path.
- 6h cooling pool + reporting flow.
- Per-market resolver badges.

### 12.3 V2 gate criteria

Flip to permissionless **only when all of these hold for ≥30 consecutive days**:

- ≥ 15 markets resolved cleanly (no disputes overturned).
- ≥ $500k cumulative prediction volume.
- ≥ 200 unique trader wallets across prediction markets.
- Insurance fund senior tranche ≥ $250k.
- Zero unresolved Sentry P0/P1 errors in predictions path for 14 days.
- Council postmortem cadence holding (every disputed market gets a published postmortem within 7d).

Publish a public `/predictions/readiness` dashboard tracking each metric. Holds us accountable and gives the community a yardstick.

### 12.4 Operational responsibilities

| Role | Owner | SLA |
|---|---|---|
| Admin launch queue review | PM rotation, weekly | 24h |
| Resolution execution | On-call eng + PM (paired) | Within 24h of `resolution_timestamp` |
| Dispute first response | Council on-call | Ack within 12h, decide within 72h |
| Postmortem authorship | PM on the dispute | Published within 7d |
| Resolver oracle health (Pyth feeds) | Keeper team | Existing on-call rotation |
| Community comms during disputes | PM + Marketing | Status page within 2h |

**The Council (3-of-5 multisig) needs naming and external members chosen *before* V1 launch.** Recommend: 2 external members — one Solana Foundation-adjacent, one prediction-market-native (ex-Polymarket / Augur). Compensation: nominal monthly retainer + per-dispute fee from treasury.

---

## Section 13 — Open questions for team alignment

1. **Legal / geofencing.** Do we geofence US users for V1? Polymarket geofences; Kalshi is CFTC-regulated. We're permissionless, but a US user trading a US election market on our site is a real risk vector. **Need counsel input before market #1 ships.**

2. **Council external seats.** Who are the two non-team Council members? Need names + commitment before launch. Suggest reaching out to Solana Foundation and ex-Polymarket eng/PM.

3. **Insurance fund segregation.** Should the predictions insurance be a separate tranche from perps, or shared? Shared = simpler + more capital efficient. Separate = blast radius contained. **Recommend separate tranche, shared LP UI** — engineering effort modest, blast radius worth it.

4. **Play-money / devnet mode.** Manifold's growth was driven by play-money onboarding. We already have `/devnet-mint`. **Recommend yes, V1.1.**

5. **Resolution timezone defaults.** UTC always, but wizard should add a "localization preview" widget. Low effort, high error-reduction.

6. **Mobile order ticket density.** Order ticket on mobile needs a bottom sheet — but the Resolution & Risk panel needs to remain pre-trade-visible. **Conflict — needs design sprint.**

7. **Cross-market portfolio risk.** A trader holding $5k of YES on four correlated election markets is concentrated. Do we surface portfolio-level correlation warnings? Out of V1 scope; flag for V1.2.

8. **Naming.** "Percolator Predictions" vs "Percolator Events" vs no sub-brand. **PM recommendation: no sub-brand, just product-type tabs.** Marketing has a vote.

9. **OG image rendering cost.** Dynamic OG on Vercel can add latency/cost. Pre-generate at launch time and CDN-cache? Engineering call.

10. **Resolution criteria template library.** Ship 5-10 pre-vetted criteria templates ("price-at-time," "binary-event-by-date," "majority-vote-outcome") to reduce ambiguous criteria? **Strongly recommend yes for V1 admin wizard; near-required for V2** to keep "criteria meaningless" rejection rate manageable.

11. **UMA Solana-side adapter build.** 4-6 weeks senior engineering + audit. **Greenlight in parallel with V1 implementation** so V2 isn't blocked when the gate criteria hit?

12. **`config.dex_pool` field correction.** Engineering noted my initial brief mentioned this field as already existing — production wrapper does not have it. The hyperp mode pushes prices via `hyperp_authority` rather than reading an on-chain DEX pool. **Action: update internal docs.**

---

## Section 14 — Estimated effort & timeline

| Workstream | Effort | Notes |
|---|---|---|
| `percolator-prog` wrapper: `ResolvePredictionMarket` + V13 layout + band carve-out | 2-3 weeks senior eng | Includes Kani proof updates |
| `percolator` engine: `resolve_market_refund_not_atomic` + per-account detach helper | 2-3 weeks senior eng | ~300–500 lines including the Kani harness in `tests/proofs_prediction.rs`; see §2.6 for the design split |
| `percolator-match-pred` LMSR binary | 3-4 weeks senior eng | Fixed-point log/exp + Remez approximations are the hard part |
| `percolator-keeper`: `predictionResolution` + `predictionSettle` services | 2 weeks | TS, mostly straightforward |
| `percolator-indexer`: `PredictionIndexer` + migrations | 1 week | TS + Supabase migration |
| `percolator-launch` API routes | 1 week | Next.js route handlers |
| `percolator-launch` frontend (`predict/*`, components, hooks) | 4-5 weeks | Bulk of UX work |
| `percolator-launch` admin wizard | 2 weeks | Multi-step form + validation |
| SDK 3.0 release | 1 week | New instruction builders + V13 parsers |
| Third-party audit | 4 weeks | Single senior auditor; can overlap final 2 weeks of build |
| Devnet trial period | 2 weeks | Hard gate before mainnet |

**Total: ~16-18 weeks (4 months) from kickoff to V1 mainnet launch**, assuming 2 senior engineers + 1 frontend engineer + 1 PM + audit in parallel. **V2 permissionless adds ~6-8 weeks** for `InitPredictionMarket`, `DisputeResolution`, `ClaimBond` + UMA Solana-side adapter (the latter is the long pole).

---

## Appendix A — Source-code references

All paths verified during this design pass:

- `dcccrypto/percolator-prog/src/percolator.rs` — BPF wrapper, tag dispatch (`:1935-2249`), `ResolveMarket` handler (`:8479-8559`), `ForceCloseResolved` handler (`:9384-9466`), `TradeCpi` band check (`:7518-7540`), `MarketConfig` (`:2524-2685`).
- `dcccrypto/percolator/src/percolator.rs` — no_std risk engine, `InsuranceFund` (`:210`), ADL state (`:265-277`).
- `dcccrypto/percolator-matcher/src/lib.rs` — matcher CPI ABI (`MatcherCall`/`MatcherReturn` at `:144-184`).
- `dcccrypto/percolator-matcher/src/vamm.rs` — `MatcherCtx` (`:81-125`); reference for LMSR matcher's tail layout.
- `dcccrypto/percolator-stake/src/state.rs` — senior/junior tranche fields, junior-loss accounting.
- `dcccrypto/percolator-keeper/src/services/` — keeper structure for new prediction services.
- `dcccrypto/percolator-indexer/src/services/` — indexer structure for new prediction tables.
- `percolator-launch/app/app/api/` — existing API surface where prediction routes attach.

## Appendix B — Hand-off notes

- **PM-UX → Engineering:** align resolution timing copy (`resolution_open_unix`, `resolution_deadline_unix`, `dispute_window_slots`) with on-chain field semantics. Wizard's resolution-date inputs must map exactly to slot-budgeted on-chain values.
- **Engineering → Marketing:** the "no sub-brand" decision needs marketing sign-off. If they want a sub-brand, the IA discussion (Section 6.5) reopens.
- **All → Counsel:** geofencing decision (Section 13.1) is the highest-priority external dependency. Block V1 launch on counsel sign-off.

---

*End of proposal. Send comments via PR to this document or in #predictions-design.*

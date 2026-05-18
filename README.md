# Percolator-Prediction

> Solana-native event markets, settled on-chain, ultimately launchable by anyone.
> Built on top of the [Percolator](https://github.com/dcccrypto) perpetual-futures protocol.

---

## Status

**Phase 0 — Design.** This repo currently contains the integration proposal only. No code is being shipped from here yet. Implementation begins after team review and sign-off on the proposal in [`PREDICTION-MARKETS-PROPOSAL.md`](./PREDICTION-MARKETS-PROPOSAL.md).

The proposal is the authoritative spec. This README is the executive briefing — read this to understand the feature, read the proposal to execute it.

---

## What we're building

Today, Percolator is **"pump.fun for perps"** — anyone can launch a leveraged trading market for any Solana token in one wizard. Percolator-Prediction extends that primitive: instead of trading the price of an asset, traders bet on whether an **event** will happen.

Example markets:
- *"Will Bitcoin close above $150,000 on December 31, 2026?"*
- *"Will Argentina win the 2026 FIFA World Cup?"*
- *"Will the Fed cut rates at the June 2026 FOMC meeting?"*

Each market resolves on a known future date to either YES or NO. Traders take positions in YES shares or NO shares; the implied price of a YES share *is* the implied probability the market thinks the event will happen.

**The strategic frame:**
- vs. Polymarket: faster (Solana, not Polygon), not US-geofenced.
- vs. Kalshi: not CFTC-gated, permissionless creation.
- vs. Augur: actually usable.

Two products, one engine, one wallet, one liquidity story.

---

## How it works — one example, end to end

Imagine the market: **"Will Bitcoin close above $150,000 on Dec 31, 2026?"**

**1. Someone launches the market.** In V1, that's the Percolator team. In V2, anyone can launch one by depositing 5 SOL. The launcher writes the question, the resolution date, the resolution criteria (a written rule that decides YES vs NO), and picks who will resolve the outcome.

**2. Traders bet.** A trader who thinks BTC will hit $150k buys **YES shares**. Their counterpart buys **NO shares**. Each share costs between $0 and $1, and the price is the implied probability:
- YES trading at $0.62 → market thinks 62% chance
- NO trading at $0.38 → market thinks 38% chance (the two always sum to ~$1)

If the trader buys 100 YES shares at $0.62:
- They pay $62 today.
- If YES wins, each share pays $1 → they receive $100, profit $38.
- If NO wins, each share pays $0 → they lose their $62.

**3. Liquidity providers (LPs) make the market.** LPs deposit USDC; the system uses it to quote both YES and NO prices on an automated market-maker curve. LPs earn a share of trading fees. Their capital is **locked until resolution** — they cannot bail out mid-flight.

**4. The event happens.** Dec 31, 2026 arrives. The resolution authority (a 3-of-5 multisig in V1; a designated resolver of the creator's choice in V2) signs a transaction: `outcome = YES` or `outcome = NO`.

**5. A 48-hour dispute window opens.** If a user with an open position thinks the resolution was wrong, they post a 0.5 SOL bond and challenge it. A council reviews; the original outcome is either confirmed or overturned. Bond is forfeited if the challenge fails; refunded plus a small reward if it succeeds.

**6. Everyone claims.** After the dispute window closes, winners click "Claim" — payouts flow from the LP pool to their wallets. Losers' positions are worth $0.

That's the entire loop.

---

## What users see

### Market list

Same `/markets` page as today, with a new top toggle:

```
+----------------------------------------------------------------------+
| Percolator        Markets [Perps | *Predictions*]   Portfolio        |
+----------------------------------------------------------------------+
| All | Politics | Crypto | Sports | Tech | Macro | Culture           |
+----------------------------------------------------------------------+
| [card]              [card]              [card]              [card]   |
| BTC > $150k?       Argentina           Fed cut at         More...    |
| YES 62¢ NO 38¢     YES 18¢ NO 82¢      YES 71¢ NO 29¢                |
| Vol 24h $184k      Vol 24h $42k        Vol 24h $310k                 |
| Resolves Dec '26   Resolves Jul '26    Resolves Jun '26              |
+----------------------------------------------------------------------+
```

### Market detail page

Hybrid UX — chart for context, simple buy box for action, position panel for management.

```
+----------------------------------------------------------------------+
| Will Bitcoin close above $150,000 on Dec 31, 2026 UTC?               |
| Crypto · Resolves Dec 31, 2026 · 224d 7h left                        |
| Resolver: [Pyth-verified]   Volume 24h: $184k                        |
+-------------------------------------------+--------------------------+
|                                           |  BUY YES                 |
|  Implied probability over time            |  ----------              |
|                                           |  YES   62¢               |
| 100% ┤                                    |  NO    38¢               |
|      │                                    |                          |
|  80% ┤                          ╭────     |  Amount  [$50 ]          |
|      │                      ╭───╯         |  [$10][$50][$100][Max]   |
|  62% ┤───────────────────────╯  <- today  |  Shares: 80.6 YES        |
|      │             ╭──────                |  Avg price: 0.621        |
|  40% ┤────────────╯                       |  Max payout: $80.60      |
|      │                                    |  Slippage: [0.5%]        |
|   0% ┴────────────────────────────────    |                          |
|      Jan      Mar      May      Today     |  [   Place trade   ]     |
|                                           |                          |
|                                           |  Tab: [Buy NO]  [LP]     |
+-------------------------------------------+--------------------------+
| Your position                                                        |
| YES 80.6 shares · cost $50.00 · mark $0.621 · unrealized +$0.04      |
| [Sell] [Close]                                                       |
+----------------------------------------------------------------------+
| Resolution & Risk                                              [v]   |
| Source: federalreserve.gov/...                                       |
| Criteria: "BTCUSD close on Coinbase at 2026-12-31 12:00 UTC,         |
|           per Pyth feed PYTH:BTC/USD, > $150,000.00"                 |
| Dispute window: 48h after resolve  |  Bond to dispute: 0.5 SOL       |
+----------------------------------------------------------------------+
```

### Settlement

When the market resolves, holders see an in-app banner on `/portfolio`:

```
+----------------------------------------------------------------------+
| Market resolved YES — "Will BTC close above $150k on Dec 31?"        |
| You have $80.60 to claim.   [ Claim $80.60 ]   [ View market ]       |
+----------------------------------------------------------------------+
```

One click → wallet signature → funds in. The same notification fires via email and (optionally) a user-provided Discord webhook.

---

## Architecture — the big idea

**Prediction markets on Percolator are mostly a configuration variant of the existing perp engine, not a new program.**

After auditing the production `percolator-prog` wrapper end-to-end, the design pod confirmed that Percolator's existing `ResolveMarket`, `ResolvePermissionless`, and `ForceCloseResolved` instructions already implement most of the settlement state machine. We don't need to fork the engine; we just need to bind a resolution oracle and constrain the settlement price.

Concretely: ~80% of the work reuses what already exists. ~20% is new.

| Component | Status |
|---|---|
| Slab account structure | Reused as-is (with 64 bytes appended for prediction fields) |
| Trading instruction (`TradeCpi`) | Reused (one ~30-line carve-out for prediction-mode price source) |
| Settlement instructions (`ResolveMarket`, `ResolvePermissionless`, `ForceCloseResolved`) | Reused as-is |
| Insurance fund + LP staking | Reused as-is |
| Risk engine (funding, liquidation, margin) | Reused as-is (with `funding_rate = 0` for prediction markets) |
| Matcher binary (the price-quote engine) | **New** — LMSR curve, ~800 lines of Rust |
| Resolution-binding instruction | **New** — `ResolvePredictionMarket` (1 new tag) |
| V2 permissionless launch + bond | **New** — 3 new instruction tags |
| Frontend pages, hooks, components | **New** — `/predict/*` route subtree |
| Keeper services (resolution + settlement crank) | **New** — 2 TypeScript services |
| Indexer services + Supabase tables | **New** — 1 service + 2 tables |

Net new code: ~1,300 lines of Rust + ~3,000 lines of TypeScript + the frontend. Total audit surface ≈ small.

### The matcher (LMSR)

Today's reference matcher is an oracle-anchored spread quoter — it takes an external price and adds a spread. For prediction markets there's no external price (Pyth doesn't have a "Trump wins" feed), so the matcher itself has to *produce* the implied probability from on-chain liquidity state. We use **LMSR (Logarithmic Market Scoring Rule)** — the same math Polymarket and Manifold use for binary markets.

Properties:
- Prices are always defined in `[0, 1]`, even with zero open interest.
- LP maximum loss is finite and provable: `b × ln(2)` for liquidity parameter `b`.
- ~10k compute units per trade overhead (acceptable; perp trades today cost 50-80k CU).

The math lives in a new sibling binary `percolator-match-pred` that conforms to the existing matcher CPI ABI — no wrapper changes for the trading path.

---

## Money flows

### Trading fees

Every trade pays a small fee (default 0.5% of trade size). The fee splits three ways:

| Recipient | V1 default | V2 default | Hard min | Hard max |
|---|---|---|---|---|
| Protocol treasury | 70% | 30% | 25% | 70% |
| Market creator | 0% (= treasury) | 40% | 10% | 50% |
| LP | 30% | 30% | 15% | 60% |

In V1 the creator is always the Percolator team, so we collapse the split to Protocol 70 / LP 30 for cleaner accounting. In V2 we tilt toward external creators (40%) and LPs (30%) to bootstrap creator interest and liquidity. The hard-min on LP (15%) prevents an attacker-creator from zeroing the LP cut.

### V2 creator bond — 5 SOL

V2 markets require the creator to deposit 5 SOL at launch into a program-owned `CreatorBond` PDA.

| Scenario | Bond outcome |
|---|---|
| Clean resolution, no dispute | Full refund 7 days after resolution |
| Disputed resolution upheld by Council | 50% slash to insurance fund, 50% to disputers as reward |
| Missed resolution SLA (96h after deadline) | 50% slash to insurance, 50% returned |
| Market declared INVALID (criteria meaningless) | 100% slash to insurance |
| Market never traded by resolution timestamp | Full refund |

5 SOL (~$1000) is the right friction floor: enough to deter trivial spam, not enough to lock out serious indie creators. Polymarket's centralized whitelist makes their friction zero; Augur's was too cheap; Kalshi's CFTC sponsorship is too expensive.

Creators can stake additional SOL into the bond as a costly-signal mechanism. Stake size is displayed on the market page so traders can self-select toward serious creators.

---

## Resolution

### V1: Squads 3-of-5 multisig

At market launch, the slab's `resolution_oracle` field is set to a Squads 2-of-3 multisig of trusted team members + one external advisor (rotating quarterly). `ResolvePredictionMarket` requires that multisig signature.

**Why a multisig and not a single key:** the resolver can drain LPs if compromised. A single signer = single point of failure. The team-internal threat model also benefits from "no single person can resolve a market on their own."

**Audit trail:** every resolution is publicly indexed at `/predictions/resolutions` — market URL, claimed outcome, signers, evidence link, transaction hash. Every overturned resolution is retained permanently as a stat against the original resolver. **Three overturns within 90 days triggers admin rotation per operational policy.**

**Failsafe:** if the multisig fails to sign within `resolution_deadline + 7 days`, anyone can call the existing `ResolvePermissionless` instruction, which settles at the time-weighted EWMA of the last 24 hours of trading. Not as accurate as a correct resolution, but better than indefinite limbo.

### V2: hybrid model

V2 creators pick a `resolver_mode` at launch:

| Mode | Cost | When to use |
|---|---|---|
| `pyth` | Free | Markets whose answer is a Pyth feed value at a timestamp (e.g., "BTC > $150k on Dec 31"). Auto-resolves. |
| `creator-attested` | 0.5 SOL extra resolver-bond | Creator self-resolves. Disputable. Default for low-TVL markets. |
| `uma` | ~$750 proposer-bond | UMA Optimistic Oracle. Opt-in for high-TVL markets (>$50k). Solana-side adapter built during V1 runway. |
| `council` | 0.25 SOL surcharge | Percolator Council 3-of-5 multisig resolves. Strongest trust signal. |

All paths share dispute escalation: any disputed resolution ultimately lands at the Council. UMA-path markets additionally escalate to UMA token-holder vote first. The resolver mode appears as a badge on every market card — traders self-select toward markets they trust.

### Dispute mechanics

- **V1:** 48-hour window after resolution; 0.5 SOL bond; Council 3-of-5 reviews within 72h. Upheld disputes return the bond + 0.25 SOL reward. Failed disputes forfeit the bond to insurance.
- **V2:** bond scales with market TVL (`max(0.5 SOL, 0.1% of TVL)`). UMA-mode disputes route to UMA's optimistic oracle process.

---

## Roadmap

### V1 — admin-gated launch

**Timeline:** ~16-18 weeks from kickoff to mainnet launch.

**Launch slate (recommended, 4 markets):**

| # | Market | Resolution path | Why |
|---|---|---|---|
| 1 | *"Will SOL close above $300 on Dec 31, 2026?"* | Pyth-resolvable | Our ecosystem, low-controversy, trust-building flagship |
| 2 | *"Will Solana surpass Ethereum in 7-day DEX volume in any week of 2026?"* | Council-resolved (DefiLlama-sourced) | Tests Council muscle on a friendly category |
| 3 | *"Will the FIFA World Cup 2026 final be won by a CONCACAF nation?"* | External-canonical (FIFA) | Broad appeal, clean resolution, ends June 2026 — fast first lifecycle |
| 4 | *"Will Anthropic/OpenAI/Google release a model scoring >90% on SWE-Bench Verified before Dec 31, 2026?"* | Council-resolved | Crypto-adjacent tech market, our exact audience |

**Hard rule: no US-election markets in V1.** Regulatory and reputational risk are asymmetric while user base is small. We grow into that category in V1.2 after building resolution muscle memory.

**Engineering effort breakdown:**

| Workstream | Effort |
|---|---|
| Wrapper changes (`percolator-prog`) | 2-3 weeks senior eng |
| Engine method (`percolator`) | 1 week |
| LMSR matcher binary | 3-4 weeks senior eng |
| Keeper services | 2 weeks |
| Indexer services | 1 week |
| Frontend API routes | 1 week |
| Frontend pages, components, admin wizard | 6-7 weeks |
| SDK 3.0 release | 1 week |
| Third-party audit | 4 weeks (overlaps final 2 weeks of build) |
| Devnet trial | 2 weeks (hard gate before mainnet) |

### V2 — permissionless

Permissionless creation flips on **only** when all gate criteria hold for 30 consecutive days:

| Gate | Threshold |
|---|---|
| Cleanly-resolved markets (no overturned disputes) | ≥ 15 |
| Cumulative prediction volume | ≥ $500k |
| Unique trader wallets across prediction markets | ≥ 200 |
| Insurance fund senior tranche | ≥ $250k |
| Sentry P0/P1 errors in predictions path | 0 unresolved for 14 days |
| Postmortem cadence (every disputed market) | Published within 7d of resolution finalization |

Tracked publicly at a future `/predictions/readiness` dashboard so the community can hold us accountable.

**V2 adds:** SOL-bonded permissionless creation, hybrid resolver model, 6-hour "cooling pool" before new markets surface in default listings, dispute UI with UMA escalation path, per-market resolver badges.

**V2 effort:** ~6-8 additional weeks (the long pole is the UMA Solana-side adapter; can be built in parallel with V1 mainnet runway).

---

## Repo layout (planned)

Phase 0 (now): this repo holds the proposal only.

Phase 1+ (post-kickoff):

| Path | Owner | Contents |
|---|---|---|
| `match-pred/` | Rust eng | LMSR matcher binary, Solana BPF. Cargo workspace member. ~800 lines. |
| `keeper-pred/` | TS eng | Two services: `predictionResolution.ts` (watches for resolution events) and `predictionSettle.ts` (cranks settlement after dispute window). Sibling Railway service. |
| `indexer-pred/` | TS eng | Resolution + dispute event indexer. Writes to two new Supabase tables. |
| `sdk-pred/` | TS eng | SDK additions: instruction builders for tags 35-38, V13 `MarketConfig` parser. Merged into `@percolatorct/sdk` 3.0 at completion. |
| `tests/` | All | End-to-end devnet integration tests covering: clean resolution, disputed resolution, INVALID/refund mode, multisig-stuck-then-permissionless resolution. CI-gated. |
| `docs/` | All | Engineering notes, math derivations, audit prep material. |

**Out of repo:** wrapper changes (`percolator-prog`), engine changes (`percolator`), frontend integration (`percolator-launch`). Each lives as a `feat/prediction-markets` branch on its respective upstream repo. See proposal Section 14.

---

## Risk model

Three layers of user protection:

1. **Clear resolution rules.** Every market has a written-in-stone `resolution_criteria` field set at launch — the exact rule that decides YES vs NO. The protocol holds itself (and V2 creators) to the rule **as written**, not to subjective "what was meant." UI surfaces the criteria text above the order ticket on every market.

2. **Dispute window.** 48 hours between "we said YES" and "the money moves." If you hold a position and you think the resolution was wrong, post a bond and the Council reviews.

3. **Insurance fund + ADL.** If LP capital runs out at settlement, the existing insurance fund (already powering the perp side) covers the shortfall. Past that, ADL (auto-deleveraging) socializes the remaining loss across winners proportionally. Same machinery, same predictable failure mode.

Worst-case scenarios called out in the proposal (with mitigations):

| Risk | Mitigation |
|---|---|
| Matcher rounds to exactly 0 or 1 at extreme odds, tripping band check | Clamp matcher output to `[1, 999_999]` always; engine treats 999_999 as "essentially YES" |
| Resolution oracle key compromise | Multisig PDA required at launch; in V2, UMA path adds external dispute layer |
| Frontrun-resolution via insider info | Trading halts 1 hour before resolution timestamp; matcher spreads widen 5x in final hour |
| Last-trade manipulation before `ResolvePermissionless` | Time-weighted EWMA over 24h, not last-trade price, on failsafe path |
| LP rage-quit during volatile resolution | Junior tranche withdrawal cooldown extends to `[market_close, resolved + dispute_window]` |

Full risk analysis: Section 11 of the proposal.

---

## Audit & testing

- **Third-party audit:** ~1,300 lines net new (matcher + wrapper diff + engine diff). Target **4 weeks with one senior auditor** (Halborn or OtterSec). Estimated cost: $50-80k.
- **Kani proofs:** extend `percolator/tests/proofs_*.rs` with prediction-market invariants ("if `market_kind == 1`, `resolved_price ∈ {1, 1_000_000} ∪ sentinel`"; "sum of payouts at settlement ≤ sum of collateral deposited").
- **Devnet trial:** 2-week minimum on devnet with multiple markets at varying liquidity, manually walked through every lifecycle path (clean, disputed, INVALID, multisig-stuck).
- **Simulation harness:** `scripts/simulate-prediction-resolution.ts` — initialize market, generate 1000 random trades, resolve, walk every settlement, verify sum-of-payouts identity. CI-gated.

---

## Related repos

The Percolator protocol is a family of repos under [`dcccrypto`](https://github.com/dcccrypto):

| Repo | Role |
|---|---|
| [`percolator-prog`](https://github.com/dcccrypto/percolator-prog) | Solana BPF program wrapper. **Wrapper changes for prediction markets land here as `feat/prediction-markets`.** |
| [`percolator`](https://github.com/dcccrypto/percolator) | `no_std` Rust risk engine. **Engine method `resolve_market_refund_not_atomic` lands here as `feat/prediction-markets`.** |
| [`percolator-matcher`](https://github.com/dcccrypto/percolator-matcher) | Reference AMM matcher. The new `percolator-match-pred` is a sibling binary, not a fork. |
| [`percolator-stake`](https://github.com/dcccrypto/percolator-stake) | Insurance LP staking layer. Reused as-is. |
| [`percolator-keeper`](https://github.com/dcccrypto/percolator-keeper) | Off-chain keeper bot. Prediction-specific services merge in at V1 launch. |
| [`percolator-indexer`](https://github.com/dcccrypto/percolator-indexer) | Off-chain indexer. New resolution/dispute tables merge in at V1 launch. |
| [`percolator-launch`](https://github.com/dcccrypto/percolator-launch) | Next.js frontend + 3 backend services. **Frontend integration lands here as `feat/prediction-markets`.** |

The split between this standalone repo and the feature-branch-on-upstream approach is explained in proposal Section 14.

---

## Contributing

**Phase 0 (now):** read the [proposal](./PREDICTION-MARKETS-PROPOSAL.md). Comments, corrections, and open questions go in GitHub Issues on this repo. The 12 open questions in Section 13 of the proposal are an explicit invitation for team alignment input.

**Phase 1+ (post-kickoff):** standard PR workflow against this repo for the components listed in [Repo layout](#repo-layout-planned). Feature work on upstream `dcccrypto` repos for wrapper/engine/frontend changes.

Local setup, required CI checks, commit-message style, and PR review expectations are documented in [CONTRIBUTING.md](./CONTRIBUTING.md).

---

## Security

Pre-launch design code under active development; do not deploy any artifact built from this repository to a production Solana cluster. Vulnerability reports go through the channel documented in [SECURITY.md](./SECURITY.md).

---

## Full proposal

The complete integration spec — 14 sections, ~12,000 words, with on-chain field definitions, instruction handler pseudocode, LMSR pricing math, fee-router PDA design, full user journeys, V1 launch slate, V2 gate criteria, audit scope, and timeline:

[**Read the proposal →**](./PREDICTION-MARKETS-PROPOSAL.md)

---

## License

Apache License 2.0 — see [LICENSE](./LICENSE). Matches the rest of the Percolator project (`dcccrypto/percolator`, `dcccrypto/percolator-launch`, `dcccrypto/percolator-stake`, all Apache-2.0).

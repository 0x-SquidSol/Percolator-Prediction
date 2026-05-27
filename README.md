# Percolator-Prediction

> Up to 5x perpetual leverage on any Polymarket prediction market.
> Built as a Solana-side leverage layer on top of the [Percolator](https://github.com/dcccrypto) perpetual-futures protocol.

---

## Status

**Phase 0 — Design.** This repo holds the integration proposal, the staging SDK package, and the integration test harness. Implementation lives on `feat/prediction-markets` branches of the upstream `dcccrypto` repos. The authoritative spec is [`PREDICTION-MARKETS-PROPOSAL.md`](./PREDICTION-MARKETS-PROPOSAL.md); this README is the executive briefing.

---

## What we're building

Polymarket runs prediction markets on Polygon — thousands of markets, multi-billion-dollar historical volume, no native leverage. Percolator-Prediction is a Solana-side perpetual-futures product that lets traders take leveraged long or short positions on the implied probability of any Polymarket market.

Example use:

- "Will Bitcoin close above $150,000 on Dec 31, 2026?" is trading at 0.42 implied on Polymarket.
- A trader thinks news flow will push it to 0.60 over the next month.
- They open a **3x perp long** on Percolator-Prediction. If the probability moves 0.42 → 0.50, they make roughly (0.08 / 0.42) × 3 ≈ 57% on their margin.
- They can close anytime; they get liquidated if the probability moves the other way past their margin buffer; or they hold to Polymarket's resolution where the perp snaps to $0 or $1 against entry.

**Strategic frame:**

- vs. Polymarket directly: we add leverage and Solana speed onto the same markets. Polymarket stays the spot venue and the resolver; we are the leverage layer.
- vs. coin-margined SOL/USD perps (Drift, dYdX, Hyperliquid): we trade what they can't — markets whose underlying is an event, an opinion, or a soft signal rather than a unit-of-account price.

---

## How it works — one example, end to end

Imagine the market: **"Will Bitcoin close above $150,000 on Dec 31, 2026?"**

**1. Someone launches the perp.** In V1, that's the Percolator team. In V2, anyone can launch a perp on any Polymarket market by depositing 10 SOL plus a market seed deposit in USDC. The launcher picks an oracle source (Pyth for price-threshold markets like this one; custom keeper for sentiment markets; Switchboard On-Demand as a middle-ground option) and sets a creator-fee bps from 0 to 8% of trading fees.

**2. Traders take leveraged positions.** A trader who thinks BTC will hit $150k buys long-probability. Their counterpart shorts. The perp's price is the **implied probability** as reported by the oracle (in this example, the Pyth-derived time-decay-toward-threshold function); margin is in USDC. Leverage chips: 1x / 2x / 3x / 5x.

If the trader buys $50 of 3x long at p = 0.42 implied:

- They post $50 USDC margin.
- Their notional exposure is ~$150 of long-probability.
- If the probability moves 0.42 → 0.50, they make ~57% on margin (~$28).
- If the probability moves to ~0.31, they get liquidated and lose their margin.

**3. Liquidity providers (LPs) make the market.** LPs deposit USDC into the perp's tranche and earn a share of trading fees. Capital is locked for the lifetime of the underlying Polymarket market plus a 48-hour buffer (covers Polymarket's UMA dispute window and our orderly-unwind grace) — LPs cannot bail out mid-flight.

**4. Polymarket resolves the underlying.** Dec 31, 2026 arrives. Polymarket's resolution flow runs (via UMA's optimistic oracle on Polygon). The market finalizes YES, NO, or — in the rare ambiguous case — INVALID.

**5. Our perp inherits the outcome.** A permissionless cranker fires `TerminalSnap`. For YES our perp's mark snaps to 1.00. For NO it snaps to 0.00. For INVALID our perp inherits the refund — every open position is detached at zero unrealized PnL via the existing engine refund method, trader collateral is preserved. No native dispute system on our side; UMA handles disputes upstream.

**6. Everyone claims.** Winners click `Claim` — payouts flow from the LP pool to their wallets. Losers' positions are worth $0.

That's the entire loop.

---

## What users see

### Discovery

```
+----------------------------------------------------------------+
| Find a Polymarket market to leverage                           |
| [ search box                                                ]  |
| Try: "Trump 2028", "BTC year-end", paste polymarket.com URL    |
+----------------------------------------------------------------+
| Top this week                                                  |
|  [card] BTC > $150k EOY  vol $4.2M  no perp yet  [Launch perp] |
|  [card] Fed Sep cut      vol $1.1M  3x perp live   [Trade]     |
|  [card] SOL ETF Q3       vol $810k  5x perp live   [Trade]     |
+----------------------------------------------------------------+
```

### Trade page

```
+----------------------------------------------------------------+
| On Polymarket: Will BTC close above $150k on Dec 31, 2026?     |
| [polymarket logo]  resolves Dec 31, 2026 · view on Polymarket  |
| [Pyth OK]  Source: Polymarket on Polygon, via Pyth (12s ago)   |
+----------------------------------------------------------------+
|                                              | LONG  |  SHORT  |
|  Implied probability (TWAP, last 30d)        +-----------------+
|                                              | Lev: 1 2 3 [5]  |
|  60% ┤                              ╭───     |       def 2     |
|      │                          ╭───╯        | Size: $___      |
|  42% ┤───────────────────────╭───╯ <- now    | Mark: 0.420     |
|      │                  ╭────╯               | Liq:  0.310     |
|  31% ┄ liq (red dashed) ─ ─ ─ ─ ─ ─ ─ ─      | Max loss: $50   |
|      │                                       | Funding: 0.00%  |
|   0% ┴────────────────────────────────       +-----------------+
|     Apr     May    Jun    Jul    Now         | If you hold to  |
|                                              | resolution:     |
|  Volume 24h: $84k · Open interest: $312k     |   YES -> $238   |
|  Creator fee: 5% (to @creator.sol)           |   NO  -> $0     |
|                                              +-----------------+
|                                              | [ Open Long ]   |
+----------------------------------------------------------------+
| Halt schedule: perp trading halts 4h before Polymarket trading |
| closes. Settlement once Polymarket resolves via UMA.           |
+----------------------------------------------------------------+
```

### Settlement

When the underlying Polymarket market resolves, holders see an in-app banner on `/portfolio`:

```
+----------------------------------------------------------------+
| Polymarket resolved YES — "Will BTC close above $150k?"        |
| Your 3x long settled at $1.00. You have $238.10 to claim.      |
| [ Claim $238.10 ]   [ View market ]                            |
+----------------------------------------------------------------+
```

One click → wallet signature → funds in. Notification fires via in-app banner, optional email, and an optional user-provided Discord webhook.

---

## Architecture — the big idea

**Most of Percolator-Prediction is already built.** It's a Solana-side leverage layer on top of the existing Percolator perpetual-futures engine. The matcher, the risk engine, the insurance fund, the LP tranching, the liquidation machinery — all reused unchanged. The new work is concentrated in a wrapper-side oracle adapter that bridges Polymarket's price data onto Solana.

| Component | Status |
|---|---|
| Slab account structure | Reused as-is (one new `market_kind` discriminator) |
| Trading instruction (`TradeCpi`) | Reused (one ~30-line carve-out for prediction-mode oracle source) |
| Matcher binary (`percolator-match`) | Reused — the oracle-anchored spread quoter consumes a Polymarket-derived probability the same way it consumes any other oracle source |
| Risk engine (funding, liquidation, margin) | Reused — funding hardcoded to zero, margin tuned for the bounded `[0, 1]` probability domain |
| Settlement instructions (`ResolveMarket`, `ForceCloseResolved`) | Reused as-is |
| Engine refund-mode method | Already shipped on `feat/prediction-markets` — handles Polymarket-INVALID inheritance and oracle-death emergency unwind on the same code path |
| Insurance fund + LP staking | Reused as-is |
| **Polymarket oracle adapter** | **New** — wrapper-side, ~500 lines |
| **5 new instruction tags** (`LinkPolymarketMarket`, `PushOracleSnapshot`, `TerminalSnap`, `EmergencyUnwind`, `EmergencyRelink`) | **New** — ~200 lines combined |
| Frontend pages, hooks, components | New — `/predict/*` and `/creators/*` route subtrees |
| Keeper services (Polymarket poller, oracle pusher, terminal-snap cranker, emergency-unwind cranker) | New — TypeScript |
| Indexer services (linkage tracker, second-source poller, oracle-health view) | New — TypeScript + Supabase |

Net new on-chain code: ~700 lines. Net new TS: ~3,000 lines + the frontend. Total audit surface is small relative to a from-scratch product.

### The oracle bridge

Polymarket runs on Polygon; we run on Solana. The bridge problem is the core technical question. Three sources, used in combination depending on the market:

- **Pyth** — for markets whose underlying is a price threshold ("BTC above $X on date Y"). Pyth publishes the price feed; we compute the implied probability as a time-decay-toward-threshold function. Fully trust-decentralized. Default for V1.
- **Custom keeper** — for sentiment markets without Pyth coverage ("Will Trump win 2028"). A 2-of-3 Squads-multisigned bot polls Polymarket's REST API every 5 seconds and pushes a signed snapshot. This is the highest-risk surface in the protocol; mitigations include an indexer-maintained second-source PDA that the wrapper checks against on every push.
- **Switchboard On-Demand** — middle-ground option in V2. Federated oracle quorum runs a custom job that scrapes Polymarket REST. Better trust than 1-of-1 keeper, worse than Pyth.

When the oracle becomes unreliable — staleness, deviation, source failure — the protocol has a deterministic exit: 15-minute grace window, then either Council-gated `EmergencyRelink` to a new oracle source or orderly unwind at the last valid 24-hour EWMA minus a 200 bps haircut routed to insurance. The protocol always has a terminal exit, even when its oracle is dead.

---

## Money flows

### Trading fees

Every trade pays a small fee (default 0.50% of trade size). The fee splits three ways:

| Recipient | V1 default | V2 default | Hard min | Hard max |
|---|---|---|---|---|
| Protocol treasury | 70% | varies | 22% | 70% |
| Market creator | 0% (= treasury) | 0–8% (creator-set) | 0% | 8% |
| LP | 30% | varies | 30% | 60% |

V1: the creator IS the Percolator team, so the split collapses to Protocol 70 / LP 30. In V2 the creator sets their share from 0 to 8% of trading fees. LP min 30% protects depth providers. Protocol picks up whatever is left after creator and LP.

### V2 launcher bond — 10 SOL

V2 markets require the launcher to deposit 10 SOL at launch into a `LauncherBond` PDA, plus a creator-defined `market_seed_deposit` in USDC for the initial LP buffer.

| Scenario | Bond outcome |
|---|---|
| Clean resolution (YES, NO, or INVALID), no protocol-side incident | Full refund 90d after underlying resolution |
| Sudden launch-then-bail (creator withdraws fees within 7d of launch + market sees no further volume) | 50% slash to insurance |
| Bound to manipulable underlying (post-launch detection of insufficient Polymarket liquidity at link time) | 100% slash to insurance |
| Underlying delisted by Polymarket (no fault of creator) | Full refund 30d after force-unwind |

The bond is unlocked progressively. **Fee-claim cap during the bond-lock window:** 25% of accrued fees claimable in the first 30 days, regardless of volume — deters pump-then-bail without making honest creator economics infeasible.

---

## Resolution

**Polymarket resolves. We inherit.** That is the single most important architectural property under this design.

- Polymarket runs UMA's optimistic oracle on Polygon. UMA proposes an outcome, opens a 2-hour challenge window (with a 48-hour escalation window if challenged), and finalizes.
- Our wrapper observes the finalized Polymarket outcome (via the oracle adapter) and a permissionless cranker fires `TerminalSnap` to settle our perp at the corresponding terminal price (1.00 for YES, 0.00 for NO, refund path for INVALID).
- **No native resolution authority on our side.** No multisig of resolvers, no dispute system, no auto-rotation triggers — those problems live at Polymarket.
- **`TerminalSnap` waits for the full UMA challenge + escalation period before firing.** We never settle on an unconfirmed proposal — if UMA flips the outcome mid-dispute we would have already paid the wrong winners.

---

## Roadmap

### V1 — team-launched on Polymarket's largest markets

**Timeline:** ~10-12 weeks from kickoff to mainnet launch.

**Target launch slate:** 6-12 markets where Polymarket has a corresponding Pyth-driven price threshold (e.g., "BTC closes above $X on date Y", "ETH above $X on date Y", "SOL above $X on date Y"). Pyth is the oracle for these; the implied probability is the time-decay-toward-threshold function computed by the keeper from the Pyth feed.

We don't mirror Polymarket sentiment in V1. Sentiment markets (elections, sports, geopolitics) require custom keepers we want to season on lower-stakes markets first.

**Engineering effort breakdown:**

| Workstream | Effort |
|---|---|
| Wrapper: oracle adapter + 5 new instruction tags | 3-4 weeks senior eng |
| `percolator-match` bounded-domain conformance audit | 3 days senior auditor (pre-mainnet hard prerequisite) |
| Keeper services (poller, oracle pusher, cranks) | 3 weeks TS eng |
| Indexer services (linkage, second-source poller, health view) | 1.5 weeks TS eng |
| Insurance: cooldown extension | 0.5 weeks |
| Frontend API routes | 1 week |
| Frontend pages, components, hooks | 4 weeks |
| SDK 3.0 release | 1 week |
| Third-party external audit | 3-4 weeks (pre-mainnet hard prerequisite) |
| Devnet trial | 3 weeks (hard gate before mainnet) |

### V2 — permissionless

Permissionless creation flips on **only** when all gate criteria hold for 30 consecutive days:

| Gate | Threshold |
|---|---|
| Cleanly-resolved markets, no protocol-side incident | ≥ 10 |
| Cumulative perp volume | ≥ $500k |
| Unique trader wallets | ≥ 200 |
| Insurance fund senior tranche | ≥ $250k |
| Sentry P0/P1 errors in the predict path | 0 unresolved for 14 days |
| Postmortem cadence (every emergency-unwind) | Published within 7d of incident |

Tracked publicly at a future `/predict/readiness` dashboard.

**V2 adds:** permissionless `LinkPolymarketMarket` with a 10 SOL launcher bond + market seed deposit, the 6-hour cooling pool, the creator dashboard, the 0–8% creator-fee slider, Switchboard On-Demand as a default for sentiment markets.

**V2 effort:** ~3-4 additional weeks on top of V1.

### Future

Multi-outcome Polymarket markets (more than YES/NO), perp-on-perp products (taking leverage on another Percolator perp's mark), and cross-market correlation tooling are all open questions for after V2 has a track record. They are not on the V1 or V2 critical paths.

---

## Repo layout

This repo holds the design proposal and the staging packages. Implementation lives across the upstream `dcccrypto` repos on `feat/prediction-markets` branches.

| Path / repo | Owner | Contents |
|---|---|---|
| `./PREDICTION-MARKETS-PROPOSAL.md` | All | Authoritative integration spec. |
| `./sdk-pred/` | TS eng | SDK additions staging: instruction builders for the new tags, `MarketConfig` V13 parser. Merged into `@percolatorct/sdk` 3.0 at completion. |
| `./tests/` | All | End-to-end devnet integration tests covering: clean YES/NO resolution, INVALID/refund inheritance, oracle-stale emergency unwind, Polymarket-delisted force-unwind, custom-keeper-compromised second-source-catches. CI-gated. |
| `dcccrypto/percolator` (feat/prediction-markets) | Rust eng | Engine refund-mode method + Kani harness suite. **Already shipped.** |
| `dcccrypto/percolator-prog` (feat/prediction-markets) | Rust eng | Wrapper V13 `MarketConfig` layout (already shipped); oracle adapter + 5 new instruction tags (next). |
| `dcccrypto/percolator-match` | Rust eng | Active oracle-anchored spread quoter matcher. Reused with one-time bounded-domain conformance audit. |
| `dcccrypto/percolator-keeper` (feat/prediction-markets) | TS eng | New services: Polymarket REST poller, Pyth monitor, oracle pusher (Squads-multisig signed), terminal-snap cranker, emergency-unwind cranker. |
| `dcccrypto/percolator-indexer` (feat/prediction-markets) | TS eng | Polymarket linkage tracking, independent second-source REST poller (the keeper-deviation safety net), oracle-health materialized view. |
| `dcccrypto/percolator-stake` (feat/prediction-markets) | Rust + TS eng | Junior-tranche cooldown extension to cover the halt + 24h buffer window. |
| `dcccrypto/percolator-launch` (feat/prediction-markets) | Frontend eng | `/predict/*` and `/creators/*` route subtrees, oracle-health pill, first-trade disclosure modal, emergency-unwind banner. |

---

## Risk model

Three layers of trader protection:

1. **Polymarket runs the resolution.** Our protocol inherits whatever outcome Polymarket finalizes — including INVALID via the refund path. We have no resolver-as-attacker, no fee-farm-then-INVALID, no dispute-bond-gaming surface on our side.
2. **Deterministic emergency-unwind protocol.** When the oracle becomes unreliable, the protocol always has a terminal exit — 15-minute grace window, then either Council `EmergencyRelink` or orderly unwind at the last valid 24h EWMA minus a 200 bps haircut routed to insurance.
3. **Insurance fund + ADL.** If LP capital runs out at settlement, the existing insurance fund (already powering the perp side) covers the shortfall. Past that, ADL (auto-deleveraging) socializes the remaining loss across winners proportionally. Same machinery, same predictable failure mode.

Worst-case scenarios called out in proposal §10:

| Risk | Mitigation |
|---|---|
| Polymarket relisting / freeze / takedown | `EmergencyUnwind` at last valid TWAP minus 200 bps haircut. Never settle at zero; never settle at last-trade. |
| UMA dispute flips the outcome mid-life | Never `TerminalSnap` until UMA's full challenge + escalation window passes plus a 24h buffer. |
| Pyth feed manipulation | Confidence-interval guard + minimum publisher count + EMA-not-aggregate + 60-slot TWAP + entry-deviation rejection. |
| Custom-keeper compromise | 2-of-3 Squads multisig + indexer-maintained second-source deviation check + per-slot move clip + canary trades. |
| Permissionless launcher binds to a manipulable underlying | Wrapper-side gates at `LinkPolymarketMarket` time + 6-hour cooling pool + bond-claim cap. |
| 8% creator-fee pump-then-bail | Fee-claim cap (25% of accrued in first 30d) + bond unlock only 90d after market resolution. |

---

## Audit & testing

- **`percolator-match` bounded-domain conformance audit.** One-time external review verifying the matcher's behavior under the bounded `[0, 1]` probability domain (price-type domain-agnosticism, quoter clamp behavior at boundaries, tick-size compatibility). ~3 days senior auditor, ~$10-15k. **Pre-mainnet, hard prerequisite.**
- **External wrapper audit.** ~3-4 weeks single senior auditor covering the oracle adapter, the 5 new instruction tags, keeper-key custody, and the cross-repo trust boundary (keeper-signed PDA → wrapper verification → engine consumption). ~$40-60k. **Pre-mainnet, hard prerequisite.**
- **Kani proofs.** The refund-mode harness suite already shipped on `feat/prediction-markets` covers Polymarket-INVALID inheritance and oracle-death emergency unwind. New harnesses for the oracle adapter (monotonicity, deviation guard, second-source check) land alongside the wrapper-side commits.
- **Devnet trial.** 3-week minimum with mock-Polymarket fixtures on a stub program. Lifecycle paths: clean YES/NO, UMA-flip, oracle-stale, Polymarket-delisted, custom-keeper-compromised.
- **Simulation harness.** Initialize a perp, generate random trades on a symbolic probability walk, fire `TerminalSnap` at terminal `p`, walk every position close, verify sum-of-payouts identity. CI-gated.

---

## Related repos

The Percolator protocol is a family of repos under [`dcccrypto`](https://github.com/dcccrypto):

| Repo | Role under this product |
|---|---|
| [`percolator`](https://github.com/dcccrypto/percolator) | `no_std` Rust risk engine. Refund-mode method + Kani harness suite shipped on `feat/prediction-markets`. |
| [`percolator-prog`](https://github.com/dcccrypto/percolator-prog) | Solana BPF program wrapper. Oracle adapter + new instruction tags land here. |
| [`percolator-match`](https://github.com/dcccrypto/percolator-match) | Active oracle-anchored spread quoter matcher. Reused with one-time bounded-domain conformance audit. |
| [`percolator-stake`](https://github.com/dcccrypto/percolator-stake) | Insurance LP staking layer. Junior-tranche cooldown extended. |
| [`percolator-keeper`](https://github.com/dcccrypto/percolator-keeper) | Off-chain keeper bot. New Polymarket-poller, oracle pusher, and cranks land here. |
| [`percolator-indexer`](https://github.com/dcccrypto/percolator-indexer) | Off-chain indexer. New linkage tracker and the independent second-source poller (the keeper-deviation safety net) land here. |
| [`percolator-launch`](https://github.com/dcccrypto/percolator-launch) | Next.js frontend + 3 backend services. `/predict/*` and `/creators/*` route subtrees land here. |

---

## Contributing

**Phase 0 (now):** read the [proposal](./PREDICTION-MARKETS-PROPOSAL.md). Comments, corrections, and open questions go in GitHub Issues on this repo.

**Phase 1+ (post-kickoff):** standard PR workflow against this repo for the staging packages (SDK + tests). Feature-branch PRs against the upstream `dcccrypto` repos for wrapper / keeper / indexer / frontend / engine changes.

Local setup, required CI checks, commit-message style, and PR review expectations are documented in [CONTRIBUTING.md](./CONTRIBUTING.md).

---

## Security

Pre-launch design code under active development; do not deploy any artifact built from this repository to a production Solana cluster. Vulnerability reports go through the channel documented in [SECURITY.md](./SECURITY.md).

---

## Full proposal

The complete integration spec — 13 sections, with on-chain field definitions, instruction handler pseudocode, the Polymarket oracle bridge design, full user journeys, V1 launch slate, V2 gate criteria, audit scope, and timeline:

[**Read the proposal →**](./PREDICTION-MARKETS-PROPOSAL.md)

---

## License

Apache License 2.0 — see [LICENSE](./LICENSE). Matches the rest of the Percolator project.

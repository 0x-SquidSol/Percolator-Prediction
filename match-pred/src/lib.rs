//! Percolator prediction-markets matcher.
//!
//! A bounded automated market maker for binary-outcome (YES/NO) prediction
//! markets. Sibling binary to the reference matcher in `dcccrypto/percolator-match`,
//! conforming to the same `MatcherCall` / `MatcherReturn` CPI ABI so the
//! upstream `percolator-prog` `TradeCpi` path can invoke it without changes.
//!
//! Pricing follows the Logarithmic Market Scoring Rule. Prices are bounded
//! to the open interval `(0, 1)`, LP maximum loss is finite, and quotes are
//! well-defined at zero open interest.
//!
//! Implementation is intentionally a placeholder at this commit — subsequent
//! commits add fixed-point math, the LMSR cost function, the CPI ABI parsers,
//! the Solana BPF target (`cdylib` + `no_std` + `solana-program` dependency),
//! and the `entrypoint!` registration.

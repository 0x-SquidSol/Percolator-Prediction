# Security Policy

## Status

This repository contains **pre-launch design code under active development**. None of it has been audited. The matcher binary is not deployed to any cluster. The instruction builders, parsers, and integration test scripts in this repo are not exercised against mainnet.

**Do not deploy any artifact built from this repository to a production Solana cluster.** A formal security audit will be conducted prior to mainnet deployment of the prediction-markets feature; bug-bounty terms covering the audited code will be published alongside that audit's certification.

The wider Percolator project's running services are covered separately by [`dcccrypto/percolator-launch`'s SECURITY.md](https://github.com/dcccrypto/percolator-launch/blob/main/SECURITY.md), which documents the live API's security posture (CORS, WebSocket auth, input sanitization, rate limiting, etc.).

## Reporting a vulnerability

If you discover a security issue in this repository, please report it responsibly.

**Email:** `security@percolatorlaunch.com`

**Please include:**

- A description of the issue and the affected file paths or commit SHAs.
- Steps to reproduce, including any required environment setup.
- Estimated impact (e.g., does the issue affect a future on-chain instruction's correctness, an off-chain SDK builder, an integration test, etc.).
- Your name or handle if you would like public credit once the issue is resolved.

We commit to:

- **Acknowledging the report within 48 hours.**
- **Providing an assessment and target timeline within 7 days.**
- **Coordinating public disclosure with you**, typically 90 days after the fix lands or after mainnet launch — whichever comes second.

Please **do not** open public GitHub issues for security-sensitive findings until coordinated disclosure is complete.

## Scope

In scope for security reports against this repository:

- The TypeScript SDK in `sdk-pred/` (instruction builders, the V13 `MarketConfig` parser, slippage helpers — once implemented).
- The integration test harness in `tests/` (test scripts that handle real keypairs or post fund-touching transactions).
- The CI workflows under `.github/workflows/` (anything that could exfiltrate secrets or alter build outputs).

Out of scope for this repository, but in scope for the linked upstream repos:

- Issues in the on-chain wrapper or risk engine: report against [`dcccrypto/percolator-prog`](https://github.com/dcccrypto/percolator-prog) or [`dcccrypto/percolator`](https://github.com/dcccrypto/percolator) directly.
- Issues in the live frontend or backend services: report per [`dcccrypto/percolator-launch`'s SECURITY.md](https://github.com/dcccrypto/percolator-launch/blob/main/SECURITY.md).

## Audit & disclosure timeline

The prediction-markets feature ships with a single coordinated audit covering:

- The wrapper changes on the `feat/prediction-markets` branch of `dcccrypto/percolator-prog`.
- The engine method on the `feat/prediction-markets` branch of `dcccrypto/percolator`.
- The off-chain oracle and settlement services on the corresponding `feat/prediction-markets` branches of `dcccrypto/percolator-keeper` and `dcccrypto/percolator-indexer`.

The audit report and the SDK / keeper / indexer code coverage will be published when the corresponding programs are deployed to mainnet.

## Safe harbor

We will not pursue legal action against researchers who:

- Act in good faith to report vulnerabilities through the channel above.
- Avoid privacy violations, data destruction, or service disruption.
- Do not publicly disclose vulnerabilities before coordinated disclosure has run its course.
- Follow standard responsible-disclosure practices.

Thank you for helping keep Percolator secure.

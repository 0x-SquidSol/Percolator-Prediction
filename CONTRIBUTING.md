# Contributing

This repository is in **active early-stage development**. Substantial contributions should be discussed in advance — either on a draft pull request or via the channels listed under [SECURITY.md](./SECURITY.md) for security-sensitive topics.

## Local setup

```sh
git clone https://github.com/0x-SquidSol/Percolator-Prediction.git
cd Percolator-Prediction

# Rust workspace
cargo check --workspace --all-targets

# Typescript workspace (uses pnpm; version pinned via packageManager in package.json)
pnpm install
pnpm -r run typecheck
```

Node 20+ is required (see `.nvmrc`). The pnpm version is pinned via the `packageManager` field; `corepack enable` handles activation.

## Required CI checks

Every push and pull request runs two jobs in `.github/workflows/ci.yml`. Both must pass before merge:

| Job | What it runs |
|---|---|
| **Rust (fmt, check, clippy)** | `cargo fmt --check`, `cargo check --workspace --all-targets --locked`, `cargo clippy --workspace --all-targets --locked -- -D warnings` |
| **TypeScript (typecheck)** | `pnpm install --frozen-lockfile`, `pnpm -r run typecheck` |

Clippy fails on any warning. The workspace's lint policy enables pedantic with three explicit allow-lints documented in the workspace `Cargo.toml`.

## Commit message style

Conventional commits, matching the convention used across `dcccrypto/*` upstream repos:

```
<type>(<scope>): <imperative summary>

<body — optional, wrap at ~72 chars>
```

Common types: `feat`, `fix`, `chore`, `refactor`, `test`, `docs`, `ci`, `perf`, `security`.

Keep commits **atomic and reviewable in under 30 minutes**. Prefer many small commits over one large one — it makes review, revert, and bisect dramatically easier.

## Branch and pull request workflow

- Feature branches branch from the latest `main`.
- Long-lived branches (cross-feature work spanning weeks) rebase weekly to absorb upstream changes early rather than at merge time.
- Pull requests target `main`. CI must be green before review.
- One reviewer minimum; security-sensitive commits (anything touching wallet signing, fee accounting, settlement math, or admin authorization) require focused review — do not bundle these into omnibus PRs.
- Squash-merge is allowed for cleanup PRs (docs, scaffolding). Substantive code lands as a fast-forward of well-structured commits.

## Where to file what

| Type of report | Where |
|---|---|
| Security vulnerability | See [SECURITY.md](./SECURITY.md). Do not open public issues. |
| Bug report | GitHub Issues on this repository. |
| Design discussion | Reference the relevant section of the proposal doc; open a draft PR if the discussion produces a code-shaped artifact. |
| Issue in the upstream wrapper / engine / launch app | File on the relevant `dcccrypto/*` repo, not here. |

## License

By contributing, you agree that your contributions are licensed under the Apache License, Version 2.0 — see [LICENSE](./LICENSE).

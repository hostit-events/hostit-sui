# Contributing to HostIt

Thanks for your interest in improving HostIt! This guide covers how to set up, make a change, and open a pull request. For project background and architecture, read the [README](./README.md); for a deeper engineering map, see [`CLAUDE.md`](./CLAUDE.md).

## Ground rules

- **Use [bun](https://bun.sh) — never npm or pnpm**, in every directory.
- This is a **two-tree repo**: the Move package lives at the root (`sui` commands), the Next.js dApp in `web/` (`bun` commands).
- **Never commit secrets.** `web/.env.local` is git-ignored; only the all-blank `.env.local.example` template is tracked.
- HostIt is **permissionless** — no issuer/buyer role split. UI must not project access gates; signal quality via suiNS/verification, not gatekeeping.

## Getting started

```bash
git clone https://github.com/hostit-events/hostit-sui.git
cd hostit-sui

# Move package (from the repo root) — requires the Sui CLI on a testnet env
sui move build
sui move test

# Frontend (from web/) — requires bun
cd web
bun install
cp .env.local.example .env.local   # fill in keys for Enoki/social login (optional for local dev)
bun run dev                        # http://localhost:3000
```

## Development workflow

1. **Branch** off `main`: `git checkout -b fix/short-description` (or `feat/…`, `docs/…`, `chore/…`).
2. Make focused, surgical changes that match the surrounding code's style and patterns.
3. **Verify before you commit** (see below).
4. Open a pull request against `main` with a clear description of the *why*.

### Verification gates

A change is not ready until these pass:

| Scope | Command | Run from |
|---|---|---|
| Move | `sui move build` && `sui move test` | repo root |
| Frontend types | `bunx tsc --noEmit` | `web/` |
| Frontend lint | `bun run lint` | `web/` |

> ⚠️ **Do not run `bun run build` while `bun run dev` is running** — they share `.next/` and the production build corrupts the dev bundle. Use `bunx tsc --noEmit` to typecheck instead.

There is no JS unit-test framework; `tsc --noEmit` + `lint` are the frontend gates. Move changes **must** keep the `tests/` suites green — add a `test_scenario` test for new on-chain behavior.

## Commit & PR conventions

- **Conventional commits**, scoped: `fix(web): …`, `feat(move): …`, `docs: …`, `chore: …`, `fix(sponsor): …`. Keep the subject imperative and < ~72 chars; put the *why* in the body.
- Keep each commit coherent (one logical change). Group related edits; avoid mixing unrelated concerns.
- Ensure the working tree is clean and all gates pass before requesting review.

## Things to know before you change…

- **Move code** — capabilities replace roles (`PlatformCap`, `OrganizerCap{event_id}`); all timestamps are **milliseconds**. Prefer narrow scope with explicit follow-ups over speculative generalization.
- **Gasless transactions** — the sponsorable move-call allowlist is **server-authoritative** in `web/app/api/sponsor/route.ts` (mirrored as a client hint in `web/lib/sponsor.ts`). If you add a sponsored entry function, add its target to **both**.
- **Package versioning** — the package is upgraded in place, so types anchor to the version that introduced them. When touching the `predict` module, use `PACKAGE_ID_LATEST` for call targets and the matching pinned constant for its types (see `web/lib/config.ts` and `CLAUDE.md`).
- **Deploys are gated upgrades** — shipping Move changes uses `sui client upgrade`, which a maintainer runs with explicit per-deploy authorization. Don't deploy as part of a PR. See [`DEPLOYING.md`](./DEPLOYING.md) for the full upgrade procedure.

## Reporting bugs & proposing features

Open a [GitHub issue](https://github.com/hostit-events/hostit-sui/issues) with: what you expected, what happened, and minimal steps to reproduce (route, wallet state, network). For security-sensitive reports, please contact a maintainer privately rather than filing a public issue.

## License

By contributing, you agree that your contributions are licensed under the project's [MIT License](./LICENSE).

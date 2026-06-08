# HostIt — events made easy, on Sui

A **permissionless** event-ticketing platform on [Sui](https://sui.io). Anyone can host an event, sell tickets, check attendees in at the door, mint proof-of-attendance, run a ticket-gated chat, and open prediction markets on whether the event sells out — all on-chain, with **gasless UX**.

HostIt is a faithful Sui Move port of the HostIt EVM Diamond, paired with a Next.js dApp. It uses **Walrus** for event media, **Seal** for encrypted data, and **Enoki** for sponsored transactions and social login.

> **Status:** live on **Sui testnet**. Move package `hostit_ticket`, latest version `0xb5c952…dffcc0f`. See [On-chain deployment](#on-chain-deployment).

---

## Features

- **Events & tickets** — permissionless `create_event`; one shared `Event` per event, generic `Coin<T>` payments, a 3% protocol fee, refunds, organizer payouts.
- **Check-in** — staff scan an **ed25519 voucher** at the door; optional self check-in within the event window. Multi-day attendance supported.
- **POAP** — checked-in holders mint a proof-of-attendance NFT (once per ticket).
- **Ticket-gated forum** — encrypted, on-chain-anchored event chat (Walrus + Seal), readable only by ticket holders.
- **Prediction markets** — native parimutuel "Sellout Clock" (binary) and "final tickets-sold" (range) markets that **settle trustlessly on-chain** by reading the event's mint counter.
- **Gasless** — transactions are sponsored server-side via Enoki; sign-in via wallet or Google (zkLogin).
- **Trust signals, not gatekeeping** — suiNS names + verification badges, consistent with the permissionless design.

---

## Architecture

```mermaid
graph TB
  subgraph Client["Browser · Next.js 15 / React 19 / Tailwind v4"]
    UI["Screens<br/>Discover · Event · Create · Manage<br/>Wallet · Forum · Check-in · Door"]
    Kit["@mysten/dapp-kit<br/>wallet + zkLogin sign-in"]
  end
  subgraph Server["Next.js route handlers (server-only secrets)"]
    Sponsor["/api/sponsor (+/execute)<br/>Enoki sponsored tx"]
    Copilot["/api/copilot<br/>Claude AI assistant"]
  end
  subgraph Sui["Sui testnet"]
    Pkg["hostit_ticket package<br/>hub · event · ticket · market · checkin<br/>access · poap · forum · predict"]
  end
  subgraph Infra["Decentralized services"]
    Walrus["Walrus<br/>event metadata + cover images"]
    Seal["Seal<br/>threshold encryption"]
    Enoki["Enoki<br/>gas sponsor + zkLogin"]
  end

  UI --> Kit
  UI --> Sponsor
  UI --> Copilot
  UI -->|store / read blobs| Walrus
  UI -->|encrypt / decrypt| Seal
  Kit -->|sign| Pkg
  Sponsor --> Enoki --> Pkg
  Seal -. seal_approve policy check .-> Pkg
```

### On-chain modules

A single Move package, `hostit_ticket`, with capability-based access control (capabilities replace EVM roles) and millisecond timestamps throughout.

```mermaid
graph LR
  hub["hub<br/>shared Hub · config · 3% fee treasury"]
  event["event<br/>Event + OrganizerCap · prices · escrow"]
  ticket["ticket<br/>Ticket NFT (event_id field)"]
  market["market<br/>buy · claim_free · refund · withdraw"]
  checkin["checkin<br/>ed25519 voucher · self check-in"]
  poap["poap<br/>proof-of-attendance NFT"]
  forum["forum<br/>ticket-gated post anchor"]
  access["access<br/>Seal seal_approve_* policies"]
  predict["predict<br/>parimutuel Sellout + Range markets"]

  market --> hub
  market --> event
  market --> ticket
  checkin --> event
  checkin --> ticket
  poap --> event
  poap --> ticket
  forum --> event
  forum --> ticket
  access --> event
  access --> ticket
  predict --> event
```

| Module | Responsibility |
|---|---|
| `hub` | Shared `Hub`: protocol config + 3% platform-fee treasury. Touched by every paid sale. |
| `event` | `create_event` shares one `Event` per event and mints an `OrganizerCap{event_id}`; holds per-coin price + escrow via dynamic fields. |
| `ticket` | One global `Ticket` type with an `event_id` field (not a per-event type). |
| `market` | `buy` / `buy_with_sui` / `claim_free` / `refund` / `withdraw_event_balance`; splits the fee into Hub + event escrow. |
| `checkin` | Attendee-signed check-in gated by an ed25519 voucher over `event_id ‖ ticket_id ‖ expiry`; `self_check_in` fallback. |
| `access` | `seal_approve_ticket` / `seal_approve_organizer` / `seal_approve_self` decryption policies. |
| `poap` | Proof-of-attendance NFT via a shared registry, claimable after check-in (one per ticket). |
| `forum` | On-chain anchor (`PostCreated`) for ticket-gated Walrus + Seal messages. |
| `predict` | Native parimutuel markets settling on `event::minted()`. |

### Gasless transaction flow

Sponsorship is **server-side** (the private Enoki key never reaches the browser); the user signs but pays no gas.

```mermaid
sequenceDiagram
  actor U as User
  participant FE as Frontend
  participant API as /api/sponsor
  participant E as Enoki
  participant S as Sui

  U->>FE: action (buy / claim / bet / check-in)
  FE->>API: transaction-kind bytes + sender
  API->>E: createSponsoredTransaction(allowlisted targets)
  E-->>API: sponsored bytes + digest
  API-->>FE: sponsored bytes
  FE->>U: wallet signs (no gas dialog)
  FE->>API: signature
  API->>E: executeSponsoredTransaction
  E->>S: submit — sponsor pays gas
  S-->>FE: digest ✓
```

### Prediction markets

DeepBook Predict has no self-serve oracle on testnet, so HostIt ships its **own** parimutuel module that settles trustlessly against the event's verifiable on-chain mint counter — no oracle, no keeper, no fee.

```mermaid
graph LR
  C["Create market<br/>snapshot strike (= max tickets)<br/>+ expiry (= start time)"] --> O["Open<br/>stake USDC on YES/NO<br/>or a tickets-sold bucket"]
  O -->|now ≥ expiry| St["Settle (permissionless)<br/>reads event::minted on-chain"]
  St --> Cl["Claim<br/>winners split the pool pro-rata"]
```

---

## Tech stack

- **Move 2024** (`hostit_ticket`) on Sui · `sui` CLI for build/test/upgrade.
- **Next.js 15** (App Router) · **React 19** · **Tailwind v4**.
- `@mysten/sui` v2 · `@mysten/dapp-kit` v2 · `@mysten/enoki` · `@mysten/seal` · `@tanstack/react-query`.
- **Walrus** (HTTP publisher/aggregator) · **Seal** (committee key server) · **Enoki** (sponsored tx + zkLogin) · **Anthropic Claude** (in-app copilot).
- Package manager: **bun** (only).

---

## On-chain deployment

Live on **Sui testnet**. `web/lib/config.ts` is the source of truth (all values are env-overridable).

| Object | ID |
|---|---|
| Package — original (type origin for core modules) | `0x423336143d4e5a810d24b97762bfa10be56b7d5dc86b75e831cb0897264b1e8d` |
| Package — latest (predict; all `predict` calls) | `0xb5c95242b1a2acc8a2561246f95f8de182b3cbc67d71a370ee413c9dcdffcc0f` |
| Shared `Hub` | `0xa2b9ceb63babc6897932c6f4cfdbbddc9d3493d36691e4520278fc58090efabd` |
| Shared `PoapRegistry` | `0x57e285538f99b6bcc4d42e6adca2d2bb305cfb0c8b292094677fb70963d6021f` |
| Collateral coin (testnet USDC) | `0xa1ec7fc0…::usdc::USDC` |

> **Package versioning (Sui upgrades):** the package is **upgraded in place**, not re-published. Sui anchors a type's identity to the version that *introduced* it, so core modules keep the original id while `predict` types live at the upgrade that added them. The frontend encodes this via `PACKAGE_ID`, `PACKAGE_ID_LATEST`, and `PREDICT_SELLOUT_PKG`. See [`CLAUDE.md`](./CLAUDE.md) for the full model.

---

## Repository layout

```
hostit-sui/
├── Move.toml · Move.lock · Published.toml   # Sui Move package manifest + publish state
├── sources/                                 # Move modules: hub · event · ticket · market · checkin
│                                            #               access · poap · forum · predict
├── tests/                                   # Move test_scenario suites (57 tests)
└── web/                                     # Next.js dApp
    ├── app/                                 # App Router routes (+ /api/sponsor, /api/copilot)
    ├── components/ (+ screens/)             # UI
    └── lib/                                 # config · ticketing · predict · hooks · walrus · seal · sponsor
```

---

## Local development

### Prerequisites
- [Bun](https://bun.sh) (never npm/pnpm)
- The [Sui CLI](https://docs.sui.io/guides/developer/getting-started/sui-install) (for Move build/test) on a testnet env

### 1 — Move package (run from the repo root)

```bash
sui move build          # compile
sui move test           # run all Move tests
sui move test predict   # run a subset by name
```

### 2 — Frontend (run from `web/`)

```bash
bun install
cp .env.local.example .env.local   # then fill in your keys (see below)
bun run dev                        # http://localhost:3000
bunx tsc --noEmit                  # typecheck (the primary verification gate)
bun run lint
```

> ⚠️ Do **not** run `bun run build` while `bun run dev` is running — they share `.next/` and the prod build corrupts the dev bundle. Use `bunx tsc --noEmit` to verify instead.

### Environment

Copy `web/.env.local.example` → `web/.env.local`. Notable variables:

| Variable | Purpose |
|---|---|
| `NEXT_PUBLIC_ENOKI_API_KEY` | Public Enoki key — enables zkLogin sign-in (browser-safe). |
| `ENOKI_PRIVATE_API_KEY` | **Server-only** — used by `/api/sponsor` to sponsor gas. Never prefix with `NEXT_PUBLIC_`. |
| `NEXT_PUBLIC_GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google OAuth (secret is server-only). |
| `NEXT_PUBLIC_HOSTIT_*` / `NEXT_PUBLIC_USDC_COIN_TYPE` | Optional on-chain ID overrides; default to `lib/config.ts`. |

Without Enoki keys the app still runs — gasless UX is disabled and users pay their own gas. `.env.local` is git-ignored; the only env file in the repo is the all-blank `.env.local.example` template.

---

## Conventions

- **Permissionless:** no issuer/buyer role split — any wallet can host *and* hold. The UI signals quality via suiNS/verification, never access gates.
- **Deploys are gated upgrades:** shipping Move changes uses `sui client upgrade` (not fresh publish), which requires explicit per-deploy authorization.
- **Gasless allowlist** is server-authoritative in `web/app/api/sponsor/route.ts` (mirrored as a hint in `web/lib/sponsor.ts`).

For a deeper engineering guide, see [`CLAUDE.md`](./CLAUDE.md).

## License

MIT.

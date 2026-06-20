# SDD progress — implement-plans

Branch: `advisor/implement-plans` (base `957206b`). Goal: implement all 20 plans in `plans/`.
Execution: sequential waves on one branch; parallel Opus implementers within a wave (file-disjoint). Controller runs authoritative gates + commits after each wave.

## Waves
- **W1** (parallel, disjoint): 001 web-ci · 002 sponsor-routes · 004 csp-headers · 006 copilot-route · 015 testnet-banner · 017 wallet-guidance · 018 cover-img · 019 retry-cap
- **W2** (parallel, disjoint): 003 durable-ratelimit+nonce · 005 seal-verify · 012 capped-page-enum · 016 buy-precheck
- **W3** (parallel, disjoint): 013 real-qr · 020 config-doc-drift
- **W4** (sequential — shared Move sources/moveErrors/tests): 008 move-quick → 010 checkin-dedup → 009 refund-fee → 011 dust-sweep → 014 predict-codes → 007 seal-namespace

## Decision-plan defaults (controller's choice; reversible, nothing deployed)
- 009 → **Option B** (disclose the forfeit: add `fee_forfeited` to TicketRefunded + fix Refunds UI tile; no fund-flow change).
- 010 → **PER-TICKET** (re-key per-day dedup on ticket id; update reader + tests).

## Gating
- Move plans (007–011): code + `sui move build` + `sui move test` only. NO `sui client upgrade/publish` (gated, needs explicit per-deploy auth).

## Status
- W1 complete (001,002,004,006,015,017,018,019) — gates green: tsc clean, lint 0 errors (25 pre-existing warnings), 84 tests. Commit d6ed50d.

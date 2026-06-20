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
- W2 complete (003,005,012,016) — fixed 016 hook-order; gates green: tsc clean, lint 0 errors, 101 tests. Commit ea9679e.
- W3 complete (013,020) — gates green: tsc clean, lint 0 errors, 103 tests, sui move build OK. Commit f0b163e.
- W4 (Move): 008,009,010,014,007 DONE — gates green: sui move test 100/100, web tsc clean, lint 0 errors, 109 tests. Commit 70ae0f8. **011 DEFERRED** — plan's "fully-claimed" predicate unsafe (all-tables-empty never true with losers; winning-table-empty drains pot early in no-winner case); safe fix needs a `had_winners` struct flag for negligible dust → reverted cleanly, re-plan later.
- ALL WAVES DONE: **19/20 plans implemented**, 011 deferred. 6 commits on advisor/implement-plans.
- Final whole-branch review (Opus): **READY TO MERGE**, 0 Critical/Important, 2 Minor (cosmetic fee_forfeited rate-drift; documented rate-limit cold-start) — no fix needed. Branch ready for PR.

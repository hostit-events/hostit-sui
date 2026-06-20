"use client";

// "Markets" section for an event page: renders BOTH prediction markets attached
// to an event — the binary "Sellout Clock" (will it sell out?) and the N+1
// bucket "Final tickets sold" range market. Discovery is via useEventMarkets
// (queryEvents-driven, UI-level dedup to the first market of each kind). Each
// card is permissionless: any connected wallet can open, bet, settle (after
// expiry) and claim. Submits via a local run(tx) (sponsored-or-regular, mirrors
// the EventPageScreen buy flow) and surfaces a TxLink + humanizeError.
//
// The SelloutMarketCard here was MOVED verbatim out of EventPageScreen.tsx; its
// behavior is identical (it self-discovers its own market id from MarketCreated
// logs, so it does not depend on useEventMarkets). The RangeMarketCard is new
// and takes its marketId from useEventMarkets.

import { useEffect, useMemo, useState } from "react";
import type { Transaction } from "@mysten/sui/transactions";
import { ENOKI_ENABLED, USDC_COIN_TYPE, EV_MARKET_CREATED, fmtAmount, toUnits } from "@/lib/config";
import {
  betBucketTx,
  betNoTx,
  betYesTx,
  bucketLabel,
  claimRangeTx,
  claimTx,
  computeBucketOdds,
  computeOdds,
  createRangeMarketTx,
  createSelloutMarketTx,
  parseMarketFields,
  parseRangeFields,
  settleRangeTx,
  settleTx,
} from "@/lib/predict";
import { useEventMarkets } from "@/lib/markets";
import { humanizeError } from "@/lib/moveErrors";
import {
  useCurrentAccount,
  useSignAndExecute,
  useSponsorAndExecute,
  useSuiQuery,
} from "@/lib/hooks";
import { Icon } from "@/components/Icon";
import { TxLink } from "@/components/TxLink";
import type {
  CoinBalance,
  DynamicFieldName,
  GetBalanceParams,
  GetDynamicFieldObjectParams,
  GetObjectParams,
  PaginatedEvents,
  QueryEventsParams,
  SuiObjectResponse,
} from "@mysten/sui/jsonRpc";

function fmtDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
function fmtTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

// Parse a USDC amount string (human units) into smallest units (6 decimals).
// Returns null for empty / non-positive / malformed input.
function parseUsdcUnits(s: string): bigint | null {
  const u = toUnits(s, 6);
  return u && u > 0n ? u : null;
}

// USDC has 6 decimals, so any digits beyond the 6th are silently truncated by
// parseUsdcUnits. Clamp the raw input on change so what the user sees matches
// what gets staked (and don't fight numeric/garbage input — leave that to the
// parser + the helper line below).
function clampUsdcInput(s: string): string {
  const dot = s.indexOf(".");
  if (dot === -1) return s;
  return s.slice(0, dot + 1) + s.slice(dot + 1, dot + 7);
}

// --- Reading the caller's per-bettor stake (for the claim gate) -------------
//
// Per-bettor stakes live in on-chain `Table<address, u64>` fields, which are
// dynamic fields NOT returned inline by getObject. We pull the table's object id
// out of the raw market content, then getDynamicFieldObject({ name: address })
// to read this wallet's stake. A value > 0 on the WINNING side means the wallet
// has unclaimed winnings; removal-on-claim means a re-read returns 0 ("Claimed").

type RawFields = Record<string, unknown>;

function rawMarketFields(obj: SuiObjectResponse | undefined): RawFields | null {
  const content = obj?.data?.content as { fields?: RawFields } | undefined;
  return content?.fields ?? null;
}

// Extract a `Table`/`vector<u64>`-style child object id from a parsed Move field
// shaped like `{ fields: { id: { id: "0x…" } } }`. Returns null if absent.
function tableId(field: unknown): string | null {
  const f = (field as { fields?: { id?: { id?: string } } } | undefined)?.fields;
  const id = f?.id?.id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

// A `Table<address,u64>` entry surfaces as a dynamic-field object whose content
// fields carry `{ name, value }`; the value is the u64 stake (JSON string).
function dynamicFieldU64Value(obj: SuiObjectResponse | undefined): bigint | null {
  const content = obj?.data?.content as { fields?: { value?: unknown } } | undefined;
  const v = content?.fields?.value;
  if (v === undefined || v === null) return null;
  try {
    return BigInt(v as string | number);
  } catch {
    return null;
  }
}

const ADDRESS_NAME = (addr: string): DynamicFieldName => ({ type: "address", value: addr });

// "Get testnet USDC" hint shown when a connected wallet's USDC balance is 0, so
// the bet buttons (disabled in that case) aren't a silent dead end.
function NoUsdcHint() {
  return (
    <div className="text-[11px]" style={{ color: "var(--fg3)" }}>
      You have 0 USDC.{" "}
      <a
        href="https://faucet.circle.com/"
        target="_blank"
        rel="noreferrer"
        style={{ color: "var(--hi-blue)", textDecoration: "underline" }}
      >
        Get testnet USDC
      </a>{" "}
      to place a bet.
    </div>
  );
}

// Shared TX feedback (success digest link + humanized error) for the market cards.
function TxFeedback({ digest, err }: { digest: string | null; err: string | null }) {
  return (
    <>
      {digest && (
        <TxLink
          digest={digest}
          className="mono text-[12px]"
          style={{ color: "var(--color-success)" }}
          before={<><Icon icon="ph:check-circle-bold" size={13} />{" "}</>}
        />
      )}
      {err && (
        <div className="text-xs break-words" style={{ color: "var(--color-danger)" }}>
          {err}
        </div>
      )}
    </>
  );
}

/**
 * "Sellout Clock" parimutuel prediction market for an event. Permissionless:
 * any connected wallet can open the market, bet YES/NO before doors, settle
 * after the deadline, and claim winnings once settled. Reads the (first) market
 * for this event from `MarketCreated` logs filtered by `event_seq`, then
 * getObject -> parseMarketFields. UI-level dedup surfaces only the first market.
 */
function SelloutMarketCard({
  eventId,
  eventSeq,
  maxTickets,
}: {
  eventId: string;
  eventSeq: string;
  maxTickets: bigint;
}) {
  const account = useCurrentAccount();
  const addr = account?.address ?? null;

  const regular = useSignAndExecute();
  const sponsored = useSponsorAndExecute();
  const isPending = regular.isPending || sponsored.isPending;

  const [amount, setAmount] = useState("1");
  const [err, setErr] = useState<string | null>(null);
  const [digest, setDigest] = useState<string | null>(null);

  // MarketCreated logs (newest first), filtered client-side to this event_seq.
  const created = useSuiQuery<"queryEvents", QueryEventsParams, PaginatedEvents>(
    "queryEvents",
    { query: { MoveEventType: EV_MARKET_CREATED }, order: "descending", limit: 50 },
    { staleTime: 30_000 },
  );

  // First/only market id for this event (UI-level dedup).
  const marketId = useMemo(() => {
    if (!created.data) return null;
    for (const ev of created.data.data) {
      const p = ev.parsedJson as { event_seq?: string | number; market_id?: string };
      if (String(p.event_seq) === eventSeq && p.market_id) return String(p.market_id);
    }
    return null;
  }, [created.data, eventSeq]);

  // Fetch + parse the market object once we know its id.
  const marketQ = useSuiQuery<"getObject", GetObjectParams, SuiObjectResponse>(
    "getObject",
    { id: marketId ?? "", options: { showContent: true } },
    { enabled: Boolean(marketId), staleTime: 15_000 },
  );
  const market = useMemo(
    () => (marketQ.data ? parseMarketFields(marketQ.data) : null),
    [marketQ.data],
  );

  // Connected wallet's USDC balance — gates the bet buttons (see NoUsdcHint).
  const balanceQ = useSuiQuery<"getBalance", GetBalanceParams, CoinBalance>(
    "getBalance",
    { owner: addr ?? "", coinType: USDC_COIN_TYPE },
    { enabled: Boolean(addr), staleTime: 15_000 },
  );
  const usdcZero = Boolean(addr) && balanceQ.data
    ? BigInt(balanceQ.data.totalBalance) <= 0n
    : false;

  // Caller's stake on the WINNING side (only meaningful once settled). Read from
  // the winning side's `Table<address,u64>` via a dynamic-field lookup.
  const winningTableId = useMemo(() => {
    if (!market?.settled) return null;
    const f = rawMarketFields(marketQ.data);
    if (!f) return null;
    return tableId(market.outcomeYes ? f.yes_stakes : f.no_stakes);
  }, [market?.settled, market?.outcomeYes, marketQ.data]);

  const winStakeQ = useSuiQuery<
    "getDynamicFieldObject",
    GetDynamicFieldObjectParams,
    SuiObjectResponse
  >(
    "getDynamicFieldObject",
    { parentId: winningTableId ?? "", name: ADDRESS_NAME(addr ?? "") },
    { enabled: Boolean(winningTableId && addr), staleTime: 15_000, retry: false },
  );
  // null = not loaded yet / no entry; 0n = entry zeroed (claimed); >0 = claimable.
  const winningStake = winStakeQ.data ? dynamicFieldU64Value(winStakeQ.data) : null;

  async function run(tx: Transaction) {
    if (!addr) return;
    setErr(null);
    setDigest(null);
    try {
      const out = ENOKI_ENABLED
        ? await sponsored.mutateAsync({ transaction: tx, sender: addr })
        : await regular.mutateAsync({ transaction: tx });
      setDigest(out.digest);
      created.refetch();
      marketQ.refetch();
      balanceQ.refetch();
      winStakeQ.refetch();
    } catch (e: unknown) {
      setErr(humanizeError(e));
    }
  }

  const now = Date.now();
  const loading = created.isLoading || (Boolean(marketId) && marketQ.isLoading);
  // The market id resolved but its getObject failed/returned no parseable
  // content — surface an error + Retry instead of a permanent "Loading…".
  const marketLoadFailed =
    Boolean(marketId) && !marketQ.isLoading && (marketQ.isError || !market);

  // Shared header used in every state of the card.
  const header = (
    <span className="eyebrow">
      <Icon icon="mdi:timer-sand" size={14} /> Sellout Clock
    </span>
  );

  const txFeedback = <TxFeedback digest={digest} err={err} />;

  // ---- No market yet: permissionless create CTA. ----
  if (!loading && !marketId) {
    return (
      <div className="space-y-3">
        {header}
        <div className="card space-y-3" style={{ padding: 16 }}>
          <div className="text-sm" style={{ color: "var(--fg2)" }}>
            Will this event sell out (reach {String(maxTickets)} tickets) before doors?
          </div>
          <button
            className="btn btn-block"
            disabled={!addr || isPending}
            onClick={() => run(createSelloutMarketTx(eventId, USDC_COIN_TYPE))}
          >
            <Icon icon="mdi:timer-sand" size={16} />
            {isPending ? "Opening…" : addr ? "Create Sellout Clock" : "Connect wallet to open"}
          </button>
          <div className="text-[11px]" style={{ color: "var(--fg3)" }}>
            Anyone can open this market — it&apos;s a parimutuel pool settled on-chain.
          </div>
          {txFeedback}
        </div>
      </div>
    );
  }

  // ---- Market getObject error: offer a Retry instead of a stuck spinner. ----
  if (marketLoadFailed) {
    return (
      <div className="space-y-3">
        {header}
        <div className="card space-y-3" style={{ padding: 16 }}>
          <div className="text-sm" style={{ color: "var(--color-danger)" }}>
            Couldn&apos;t load this market.
          </div>
          <button className="btn btn-block" onClick={() => marketQ.refetch()}>
            <Icon icon="ph:arrow-clockwise-bold" size={16} /> Retry
          </button>
        </div>
      </div>
    );
  }

  // ---- Loading market state. ----
  if (loading || !market) {
    return (
      <div className="space-y-3">
        {header}
        <div className="card mono text-sm" style={{ padding: 16, color: "var(--fg2)" }}>
          Loading market…
        </div>
      </div>
    );
  }

  const odds = computeOdds(market.totalYes, market.totalNo);
  const hasBets = market.totalYes > 0n || market.totalNo > 0n;
  const expiryMs = Number(market.expiryMs);
  const open = !market.settled && now < expiryMs;
  const needsSettle = !market.settled && now >= expiryMs;

  return (
    <div className="space-y-3">
      {header}
      <div className="card space-y-4" style={{ padding: 16 }}>
        <div className="text-sm" style={{ color: "var(--fg2)" }}>
          Will this event sell out (reach {String(market.strike)} tickets) before doors?
        </div>

        {/* Odds */}
        {hasBets ? (
          <div className="flex items-center justify-between text-sm">
            <span className="badge badge-green">YES {odds.yesPct.toFixed(0)}%</span>
            <span className="mono text-[12px]" style={{ color: "var(--fg3)" }}>
              {fmtAmount(market.totalYes + market.totalNo, 6)} USDC pooled
            </span>
            <span className="badge badge-line">NO {odds.noPct.toFixed(0)}%</span>
          </div>
        ) : (
          <div className="text-[12px]" style={{ color: "var(--fg3)" }}>
            No bets yet — be the first to set the odds.
          </div>
        )}

        {/* Open: bet YES / NO */}
        {open && (
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm">
              <span style={{ color: "var(--fg2)" }}>Stake</span>
              <input
                id="market-bet-sellout"
                aria-label="Bet amount (USDC)"
                className="input mono"
                type="number"
                min="0"
                step="0.01"
                value={amount}
                onChange={(e) => setAmount(clampUsdcInput(e.target.value))}
                style={{ width: 110 }}
                disabled={isPending}
              />
              <span style={{ color: "var(--fg3)" }}>USDC</span>
            </label>
            {parseUsdcUnits(amount) === null && (
              <div className="text-[11px]" style={{ color: "var(--hi-amber)" }}>
                Enter an amount greater than 0 (up to 6 decimals).
              </div>
            )}
            <div className="flex gap-2">
              <button
                className="btn btn-primary"
                style={{ flex: 1 }}
                disabled={!addr || isPending || usdcZero || parseUsdcUnits(amount) === null}
                onClick={() => {
                  const units = parseUsdcUnits(amount);
                  if (units === null) return;
                  run(
                    betYesTx({
                      marketId: marketId!,
                      coinType: USDC_COIN_TYPE,
                      amountUnits: units,
                      sponsored: ENOKI_ENABLED,
                    }),
                  );
                }}
              >
                {isPending ? "…" : "Bet YES"}
              </button>
              <button
                className="btn"
                style={{ flex: 1 }}
                disabled={!addr || isPending || usdcZero || parseUsdcUnits(amount) === null}
                onClick={() => {
                  const units = parseUsdcUnits(amount);
                  if (units === null) return;
                  run(
                    betNoTx({
                      marketId: marketId!,
                      coinType: USDC_COIN_TYPE,
                      amountUnits: units,
                      sponsored: ENOKI_ENABLED,
                    }),
                  );
                }}
              >
                {isPending ? "…" : "Bet NO"}
              </button>
            </div>
            <div className="text-[11px]" style={{ color: "var(--fg3)" }}>
              Betting closes at doors ({fmtDate(expiryMs)}, {fmtTime(expiryMs)}). Winners split the
              losing pool pro-rata.
            </div>
            {!addr && (
              <div className="text-[11px]" style={{ color: "var(--fg3)" }}>
                Connect a wallet to bet.
              </div>
            )}
            {usdcZero && <NoUsdcHint />}
          </div>
        )}

        {/* Expired but unsettled: anyone can settle. */}
        {needsSettle && (
          <div className="space-y-2">
            <div className="text-[12px]" style={{ color: "var(--fg2)" }}>
              Betting is closed. Settle on-chain to lock the outcome from the event&apos;s minted
              count.
            </div>
            <div
              className="text-[11px] flex items-start gap-1.5"
              style={{ color: "var(--hi-amber)" }}
            >
              <Icon icon="ph:warning-bold" size={14} />
              <span>
                Settling locks the outcome now. Tickets may still sell until the event ends — settle
                once you&apos;re confident the final count is in.
              </span>
            </div>
            <button
              className="btn btn-block"
              disabled={!addr || isPending}
              onClick={() => run(settleTx({ marketId: marketId!, eventId, coinType: USDC_COIN_TYPE }))}
            >
              <Icon icon="ph:gavel-bold" size={16} />
              {isPending ? "Settling…" : addr ? "Settle" : "Connect wallet to settle"}
            </button>
          </div>
        )}

        {/* Settled: outcome + claim (gated on a real unclaimed winning stake). */}
        {market.settled && (() => {
          // Resolve claim eligibility from the caller's winning-side stake.
          const stakeLoading = Boolean(addr && winningTableId) && winStakeQ.isLoading;
          const hasWinningStake = winningStake !== null && winningStake > 0n;
          // An entry that exists but is 0 means the wallet already claimed.
          const alreadyClaimed = winningStake !== null && winningStake === 0n;
          return (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm">
                <span style={{ color: "var(--fg2)" }}>Outcome:</span>
                {market.outcomeYes ? (
                  <span className="badge badge-green">Sold out</span>
                ) : (
                  <span className="badge badge-line">Did not sell out</span>
                )}
              </div>
              {!addr ? (
                <button className="btn btn-primary btn-block" disabled>
                  <Icon icon="ph:coins-bold" size={16} /> Connect wallet to claim
                </button>
              ) : stakeLoading ? (
                <button className="btn btn-primary btn-block" disabled>
                  <Icon icon="ph:coins-bold" size={16} /> Checking your stake…
                </button>
              ) : hasWinningStake ? (
                <>
                  <button
                    className="btn btn-primary btn-block"
                    disabled={isPending}
                    onClick={() =>
                      run(claimTx({ marketId: marketId!, coinType: USDC_COIN_TYPE, recipient: addr! }))
                    }
                  >
                    <Icon icon="ph:coins-bold" size={16} />
                    {isPending ? "Claiming…" : "Claim winnings"}
                  </button>
                  <div className="text-[11px]" style={{ color: "var(--fg3)" }}>
                    Your winning-side stake: {fmtAmount(winningStake!, 6)} USDC + a pro-rata share of
                    the losing pool.
                  </div>
                </>
              ) : (
                <div
                  className="text-[12px] flex items-center gap-1.5"
                  style={{ color: "var(--fg3)" }}
                >
                  <Icon icon="ph:info-bold" size={14} />
                  {alreadyClaimed ? "Claimed." : "You did not bet the winning side."}
                </div>
              )}
            </div>
          );
        })()}

        {txFeedback}
      </div>
    </div>
  );
}

// Default cutoffs for a fresh range market: quartiles of maxTickets. N=4 cutoffs
// -> 5 buckets (0–q1-1, q1–q2-1, q2–q3-1, q3–max-1, max+). Cutoffs must be
// strictly increasing; with a tiny maxTickets the naive quartiles can collide
// (e.g. max=2 -> [0,1,1,2]). We dedup+sort to keep the vector strictly
// increasing, and fall back to a single midpoint cutoff if everything collapses.
function defaultCutoffs(maxTickets: bigint): bigint[] {
  if (maxTickets <= 0n) return [1n];
  const raw = [maxTickets / 4n, maxTickets / 2n, (3n * maxTickets) / 4n, maxTickets];
  const positive = raw.filter((c) => c > 0n);
  const uniqueSorted = Array.from(new Set(positive.map((c) => c.toString())))
    .map((s) => BigInt(s))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (uniqueSorted.length === 0) return [maxTickets > 1n ? maxTickets / 2n : 1n];
  return uniqueSorted;
}

/**
 * "Final tickets sold" parimutuel range market: bettors stake on which BUCKET
 * the final `event::minted` count lands in (N+1 buckets from N cutoffs). Mirrors
 * SelloutMarketCard's lifecycle (create -> bet -> settle after expiry -> claim)
 * but with a bucket picker + per-bucket odds bars. The market id comes from
 * useEventMarkets (range discovery); we getObject -> parseRangeFields for live
 * totals/cutoffs/outcome. Permissionless throughout.
 */
function RangeMarketCard({
  eventId,
  marketId,
  marketsLoading,
  maxTickets,
  refetchMarkets,
}: {
  eventId: string;
  marketId: string | null;
  marketsLoading: boolean;
  maxTickets: bigint;
  refetchMarkets: () => void;
}) {
  const account = useCurrentAccount();
  const addr = account?.address ?? null;

  const regular = useSignAndExecute();
  const sponsored = useSponsorAndExecute();
  const isPending = regular.isPending || sponsored.isPending;

  const [amount, setAmount] = useState("1");
  const [picked, setPicked] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [digest, setDigest] = useState<string | null>(null);

  // Reset the picked bucket when the market changes — a stale index from a
  // previously-viewed market could point at a non-existent bucket.
  useEffect(() => {
    setPicked(0);
  }, [marketId]);

  // Fetch + parse the range market object once we know its id.
  const marketQ = useSuiQuery<"getObject", GetObjectParams, SuiObjectResponse>(
    "getObject",
    { id: marketId ?? "", options: { showContent: true } },
    { enabled: Boolean(marketId), staleTime: 15_000 },
  );
  const market = useMemo(
    () => (marketQ.data ? parseRangeFields(marketQ.data) : null),
    [marketQ.data],
  );

  // Connected wallet's USDC balance — gates the bet button (see NoUsdcHint).
  const balanceQ = useSuiQuery<"getBalance", GetBalanceParams, CoinBalance>(
    "getBalance",
    { owner: addr ?? "", coinType: USDC_COIN_TYPE },
    { enabled: Boolean(addr), staleTime: 15_000 },
  );
  const usdcZero = Boolean(addr) && balanceQ.data
    ? BigInt(balanceQ.data.totalBalance) <= 0n
    : false;

  // Caller's stake in the WINNING bucket (only meaningful once settled). The
  // per-bucket `stakes` is a `vector<Table<address,u64>>`; pull the winning
  // bucket's table id, then a dynamic-field lookup for this wallet's stake.
  // NOTE: in the refund path (winning bucket has no bets) the contract refunds
  // each bettor across every bucket — that's handled below by enabling claim
  // whenever the winning bucket itself drew no stake.
  const winningTableId = useMemo(() => {
    if (!market?.settled) return null;
    const f = rawMarketFields(marketQ.data);
    const stakes = f?.stakes;
    if (!Array.isArray(stakes)) return null;
    return tableId(stakes[market.winningBucket]);
  }, [market?.settled, market?.winningBucket, marketQ.data]);

  const winStakeQ = useSuiQuery<
    "getDynamicFieldObject",
    GetDynamicFieldObjectParams,
    SuiObjectResponse
  >(
    "getDynamicFieldObject",
    { parentId: winningTableId ?? "", name: ADDRESS_NAME(addr ?? "") },
    { enabled: Boolean(winningTableId && addr), staleTime: 15_000, retry: false },
  );
  const winningStake = winStakeQ.data ? dynamicFieldU64Value(winStakeQ.data) : null;

  async function run(tx: Transaction) {
    if (!addr) return;
    setErr(null);
    setDigest(null);
    try {
      const out = ENOKI_ENABLED
        ? await sponsored.mutateAsync({ transaction: tx, sender: addr })
        : await regular.mutateAsync({ transaction: tx });
      setDigest(out.digest);
      refetchMarkets();
      marketQ.refetch();
      balanceQ.refetch();
      winStakeQ.refetch();
    } catch (e: unknown) {
      setErr(humanizeError(e));
    }
  }

  const now = Date.now();
  const loading = marketsLoading || (Boolean(marketId) && marketQ.isLoading);
  // The market id resolved but its getObject failed/returned no parseable
  // content — surface an error + Retry instead of a permanent "Loading…".
  const marketLoadFailed =
    Boolean(marketId) && !marketQ.isLoading && (marketQ.isError || !market);

  // Shared header used in every state of the card.
  const header = (
    <span className="eyebrow">
      <Icon icon="mdi:chart-bar" size={14} /> Final tickets sold
    </span>
  );

  const txFeedback = <TxFeedback digest={digest} err={err} />;

  // ---- No market yet: permissionless create CTA (quartile cutoffs). ----
  if (!loading && !marketId) {
    const cutoffs = defaultCutoffs(maxTickets);
    const previewBuckets = cutoffs.length + 1;
    return (
      <div className="space-y-3">
        {header}
        <div className="card space-y-3" style={{ padding: 16 }}>
          <div className="text-sm" style={{ color: "var(--fg2)" }}>
            How many tickets will this event ultimately sell? Open a pooled market over{" "}
            {previewBuckets} ranges.
          </div>
          <div className="flex flex-wrap gap-1.5">
            {Array.from({ length: previewBuckets }, (_, i) => (
              <span key={i} className="badge badge-line mono">
                {bucketLabel(cutoffs, i)}
              </span>
            ))}
          </div>
          <button
            className="btn btn-block"
            disabled={!addr || isPending}
            onClick={() => run(createRangeMarketTx(eventId, USDC_COIN_TYPE, cutoffs))}
          >
            <Icon icon="mdi:chart-bar" size={16} />
            {isPending
              ? "Opening…"
              : addr
                ? "Create final-tickets-sold market"
                : "Connect wallet to open"}
          </button>
          <div className="text-[11px]" style={{ color: "var(--fg3)" }}>
            Anyone can open this market — ranges default to quartiles of{" "}
            {String(maxTickets)} max tickets.
          </div>
          {txFeedback}
        </div>
      </div>
    );
  }

  // ---- Market getObject error: offer a Retry instead of a stuck spinner. ----
  if (marketLoadFailed) {
    return (
      <div className="space-y-3">
        {header}
        <div className="card space-y-3" style={{ padding: 16 }}>
          <div className="text-sm" style={{ color: "var(--color-danger)" }}>
            Couldn&apos;t load this market.
          </div>
          <button className="btn btn-block" onClick={() => marketQ.refetch()}>
            <Icon icon="ph:arrow-clockwise-bold" size={16} /> Retry
          </button>
        </div>
      </div>
    );
  }

  // ---- Loading market state. ----
  if (loading || !market) {
    return (
      <div className="space-y-3">
        {header}
        <div className="card mono text-sm" style={{ padding: 16, color: "var(--fg2)" }}>
          Loading market…
        </div>
      </div>
    );
  }

  const odds = computeBucketOdds(market.totals);
  const pooled = market.totals.reduce((a, b) => a + b, 0n);
  const hasBets = pooled > 0n;
  const expiryMs = Number(market.expiryMs);
  const open = !market.settled && now < expiryMs;
  const needsSettle = !market.settled && now >= expiryMs;
  const bucketCount = market.totals.length;
  // Keep the picker in range against the live bucket count.
  const safePicked = picked >= 0 && picked < bucketCount ? picked : 0;

  return (
    <div className="space-y-3">
      {header}
      <div className="card space-y-4" style={{ padding: 16 }}>
        <div className="text-sm" style={{ color: "var(--fg2)" }}>
          How many tickets will this event ultimately sell?
        </div>

        {/* Per-bucket odds bars */}
        <div className="space-y-2">
          {market.totals.map((t, i) => {
            const pct = odds[i] ?? 0;
            const isWinner = market.settled && i === market.winningBucket;
            return (
              <div key={i} className="space-y-1">
                <div className="flex items-center justify-between text-[12px]">
                  <span
                    className="mono"
                    style={{ color: isWinner ? "var(--color-success)" : "var(--fg2)" }}
                  >
                    {bucketLabel(market.cutoffs, i)}
                    {isWinner && " ✓"}
                  </span>
                  <span className="mono" style={{ color: "var(--fg3)" }}>
                    {hasBets ? `${pct.toFixed(0)}% · ${fmtAmount(t, 6)}` : "—"}
                  </span>
                </div>
                <div
                  style={{
                    height: 6,
                    borderRadius: 999,
                    background: "rgba(255,255,255,.06)",
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      height: "100%",
                      // No bets yet: render a muted zero-width bar (no implied
                      // odds). With bets, floor at 1% so funded buckets stay visible.
                      width: hasBets ? `${Math.max(pct, 1)}%` : "0%",
                      borderRadius: 999,
                      background: isWinner ? "var(--color-success)" : "var(--hi-blue)",
                      transition: "width .3s ease",
                    }}
                  />
                </div>
              </div>
            );
          })}
        </div>

        {hasBets ? (
          <div className="mono text-[12px]" style={{ color: "var(--fg3)" }}>
            {fmtAmount(pooled, 6)} USDC pooled
          </div>
        ) : (
          <div className="text-[12px]" style={{ color: "var(--fg3)" }}>
            No bets yet — be the first to set the odds.
          </div>
        )}

        {/* Open: pick a bucket + stake + bet */}
        {open && (
          <div className="space-y-2">
            <label className="block text-sm">
              <span style={{ color: "var(--fg2)" }}>Bucket</span>
              <select
                id="market-bet-bucket"
                aria-label="Bucket"
                className="select mono"
                value={safePicked}
                onChange={(e) => setPicked(Number(e.target.value))}
                disabled={isPending}
                style={{ marginTop: 6 }}
              >
                {market.totals.map((_, i) => (
                  <option key={i} value={i}>
                    {bucketLabel(market.cutoffs, i)}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-2 text-sm">
              <span style={{ color: "var(--fg2)" }}>Stake</span>
              <input
                id="market-bet-range"
                aria-label="Bet amount (USDC)"
                className="input mono"
                type="number"
                min="0"
                step="0.01"
                value={amount}
                onChange={(e) => setAmount(clampUsdcInput(e.target.value))}
                style={{ width: 110 }}
                disabled={isPending}
              />
              <span style={{ color: "var(--fg3)" }}>USDC</span>
            </label>
            {parseUsdcUnits(amount) === null && (
              <div className="text-[11px]" style={{ color: "var(--hi-amber)" }}>
                Enter an amount greater than 0 (up to 6 decimals).
              </div>
            )}
            <button
              className="btn btn-primary btn-block"
              disabled={!addr || isPending || usdcZero || parseUsdcUnits(amount) === null}
              onClick={() => {
                const units = parseUsdcUnits(amount);
                if (units === null) return;
                run(
                  betBucketTx({
                    marketId: marketId!,
                    coinType: USDC_COIN_TYPE,
                    bucket: safePicked,
                    amountUnits: units,
                  }),
                );
              }}
            >
              <Icon icon="mdi:chart-bar" size={16} />
              {isPending ? "…" : `Bet ${bucketLabel(market.cutoffs, safePicked)}`}
            </button>
            <div className="text-[11px]" style={{ color: "var(--fg3)" }}>
              Betting closes at doors ({fmtDate(expiryMs)}, {fmtTime(expiryMs)}). The winning bucket
              splits the losing pools pro-rata.
            </div>
            {!addr && (
              <div className="text-[11px]" style={{ color: "var(--fg3)" }}>
                Connect a wallet to bet.
              </div>
            )}
            {usdcZero && <NoUsdcHint />}
          </div>
        )}

        {/* Expired but unsettled: anyone can settle. */}
        {needsSettle && (
          <div className="space-y-2">
            <div className="text-[12px]" style={{ color: "var(--fg2)" }}>
              Betting is closed. Settle on-chain to lock the winning bucket from the event&apos;s
              minted count.
            </div>
            <div
              className="text-[11px] flex items-start gap-1.5"
              style={{ color: "var(--hi-amber)" }}
            >
              <Icon icon="ph:warning-bold" size={14} />
              <span>
                Settling locks the winning bucket now. Tickets may still sell until the event ends —
                settle once you&apos;re confident the final count is in.
              </span>
            </div>
            <button
              className="btn btn-block"
              disabled={!addr || isPending}
              onClick={() =>
                run(settleRangeTx({ marketId: marketId!, eventId, coinType: USDC_COIN_TYPE }))
              }
            >
              <Icon icon="ph:gavel-bold" size={16} />
              {isPending ? "Settling…" : addr ? "Settle" : "Connect wallet to settle"}
            </button>
          </div>
        )}

        {/* Settled: winning bucket + claim (gated on a real unclaimed stake). */}
        {market.settled && (() => {
          // If the winning bucket drew no bets, the contract takes the REFUND
          // path: any bettor reclaims their own stake from every bucket. We can't
          // cheaply prove "bet some bucket" from one lookup, so in that case we
          // leave claim enabled and let humanizeError surface E_NO_STAKE for
          // wallets that never bet. With winners present, we gate precisely on the
          // winning-bucket stake.
          const refundPath = (market.totals[market.winningBucket] ?? 0n) === 0n;
          const stakeLoading = Boolean(addr && winningTableId) && winStakeQ.isLoading;
          const hasWinningStake = winningStake !== null && winningStake > 0n;
          const alreadyClaimed = winningStake !== null && winningStake === 0n;
          const canClaim = refundPath || hasWinningStake;
          return (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm">
                <span style={{ color: "var(--fg2)" }}>Winning bucket:</span>
                <span className="badge badge-green mono">
                  {bucketLabel(market.cutoffs, market.winningBucket)}
                </span>
              </div>
              {!addr ? (
                <button className="btn btn-primary btn-block" disabled>
                  <Icon icon="ph:coins-bold" size={16} /> Connect wallet to claim
                </button>
              ) : !refundPath && stakeLoading ? (
                <button className="btn btn-primary btn-block" disabled>
                  <Icon icon="ph:coins-bold" size={16} /> Checking your stake…
                </button>
              ) : canClaim ? (
                <>
                  <button
                    className="btn btn-primary btn-block"
                    disabled={isPending}
                    onClick={() =>
                      run(claimRangeTx({ marketId: marketId!, coinType: USDC_COIN_TYPE, recipient: addr! }))
                    }
                  >
                    <Icon icon="ph:coins-bold" size={16} />
                    {isPending ? "Claiming…" : refundPath ? "Refund stake" : "Claim winnings"}
                  </button>
                  <div className="text-[11px]" style={{ color: "var(--fg3)" }}>
                    {refundPath
                      ? "No one bet the winning bucket — each bettor refunds their own stake."
                      : `Your winning-bucket stake: ${fmtAmount(winningStake!, 6)} USDC + a pro-rata share of the losing pools.`}
                  </div>
                </>
              ) : (
                <div
                  className="text-[12px] flex items-center gap-1.5"
                  style={{ color: "var(--fg3)" }}
                >
                  <Icon icon="ph:info-bold" size={14} />
                  {alreadyClaimed ? "Claimed." : "You did not bet the winning bucket."}
                </div>
              )}
            </div>
          );
        })()}

        {txFeedback}
      </div>
    </div>
  );
}

/**
 * "Markets" section for an event page: the Sellout Clock (binary) + the
 * Final-tickets-sold range market, side by side on wide viewports. Range
 * discovery flows through useEventMarkets; the Sellout card self-discovers its
 * own market id (kept as-is from the original inline component).
 */
export function EventMarketsScreen({
  eventId,
  eventSeq,
  maxTickets,
}: {
  eventId: string;
  eventSeq: string;
  maxTickets: bigint;
}) {
  const { rangeMarketId, loading, refetch } = useEventMarkets(eventSeq);

  return (
    <div className="grid gap-6" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(280px,1fr))" }}>
      <SelloutMarketCard eventId={eventId} eventSeq={eventSeq} maxTickets={maxTickets} />
      <RangeMarketCard
        eventId={eventId}
        marketId={rangeMarketId}
        marketsLoading={loading}
        maxTickets={maxTickets}
        refetchMarkets={refetch}
      />
    </div>
  );
}

"use client";

// "Markets" section for an event page: renders BOTH prediction markets attached
// to an event — the binary "Sellout Clock" (will it sell out?) and the N+1
// bucket "Final tickets sold" range market. Discovery is via useEventMarkets
// (queryEvents-driven, UI-level dedup to the first market of each kind). Each
// card is permissionless: any connected wallet can open, bet, settle (after
// expiry) and claim. Submits via a local run(tx) (sponsored-or-regular, mirrors
// the EventPageScreen buy flow) and surfaces a TxLink + humanizeError.
//
// Both cards take their marketId from useEventMarkets (one fully-enumerated
// MarketCreated query per kind in the parent, first-match UI-level dedup) — the
// sellout card no longer self-discovers its id with its own capped query.

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import type { Transaction } from "@mysten/sui/transactions";
import { ENOKI_ENABLED, USDC_COIN_TYPE, fmtAmount, toUnits } from "@/lib/config";
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
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type {
  CoinBalance,
  DynamicFieldName,
  GetBalanceParams,
  GetDynamicFieldObjectParams,
  GetObjectParams,
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

/**
 * "Sellout Clock" parimutuel prediction market for an event. Permissionless:
 * any connected wallet can open the market, bet YES/NO before doors, settle
 * after the deadline, and claim winnings once settled. The market id arrives as a
 * prop from the parent's useEventMarkets (first-match dedup over fully-enumerated
 * MarketCreated logs); this card just getObject -> parseMarketFields it.
 */
function SelloutMarketCard({
  eventId,
  marketId,
  marketsLoading,
  maxTickets,
  refetchMarkets,
  onMarketChange,
}: {
  eventId: string;
  marketId: string | null;
  marketsLoading: boolean;
  maxTickets: bigint;
  refetchMarkets: () => void;
  // Called after a successful tx so a parent (the event page) can re-run its own
  // market-existence query and reveal/refresh the section without a reload.
  onMarketChange?: () => void;
}) {
  const account = useCurrentAccount();
  const addr = account?.address ?? null;

  const regular = useSignAndExecute();
  const sponsored = useSponsorAndExecute();
  const isPending = regular.isPending || sponsored.isPending;

  const [amount, setAmount] = useState("1");

  // `marketId` is the sellout market for this event_seq, discovered once by the
  // parent's useEventMarkets (first-match UI-level dedup over fully-enumerated
  // MarketCreated logs) and passed down — no longer re-fetched per card.

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
    try {
      const out = ENOKI_ENABLED
        ? await sponsored.mutateAsync({ transaction: tx, sender: addr })
        : await regular.mutateAsync({ transaction: tx });
      toast.success("Transaction confirmed", {
        description: <TxLink digest={out.digest} chars={10} />,
      });
      refetchMarkets();
      marketQ.refetch();
      balanceQ.refetch();
      winStakeQ.refetch();
      onMarketChange?.();
    } catch (e: unknown) {
      toast.error(humanizeError(e));
    }
  }

  const now = Date.now();
  const loading = marketsLoading || (Boolean(marketId) && marketQ.isLoading);
  // The market id resolved but its getObject failed/returned no parseable
  // content — surface an error + Retry instead of a permanent "Loading…".
  const marketLoadFailed =
    Boolean(marketId) && !marketQ.isLoading && (marketQ.isError || !market);

  // Shared header used in every state of the card.
  const header = null;

  // ---- No market yet: permissionless create CTA. ----
  if (!loading && !marketId) {
    return (
      <div className="space-y-3">
        {header}
        <Card className="gap-3 p-4">
          <div className="text-sm" style={{ color: "var(--fg2)" }}>
            Will this event sell out (reach {String(maxTickets)} tickets) before doors?
          </div>
          <Button
            className="w-full min-h-11 sm:min-h-0"
            disabled={!addr || isPending}
            onClick={() => run(createSelloutMarketTx(eventId, USDC_COIN_TYPE))}
          >
            <Icon icon="mdi:timer-sand" size={16} />
            {isPending ? "Opening…" : addr ? "Create Sellout Clock" : "Connect wallet to open"}
          </Button>
          <div className="text-[11px]" style={{ color: "var(--fg3)" }}>
            Anyone can open this market — it&apos;s a parimutuel pool settled on-chain.
          </div>
        </Card>
      </div>
    );
  }

  // ---- Market getObject error: offer a Retry instead of a stuck spinner. ----
  if (marketLoadFailed) {
    return (
      <div className="space-y-3">
        {header}
        <Card className="gap-3 p-4">
          <div className="text-sm" style={{ color: "var(--color-danger)" }}>
            Couldn&apos;t load this market.
          </div>
          <Button variant="outline" className="w-full" onClick={() => marketQ.refetch()}>
            <Icon icon="ph:arrow-clockwise-bold" size={16} /> Retry
          </Button>
        </Card>
      </div>
    );
  }

  // ---- Loading market state. ----
  if (loading || !market) {
    return (
      <div className="space-y-3">
        {header}
        <Card className="gap-2 p-4">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-8 w-full" />
        </Card>
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
      <Card className="gap-4 p-4">
        <div className="text-sm" style={{ color: "var(--fg2)" }}>
          Will this event sell out (reach {String(market.strike)} tickets) before doors?
        </div>

        {/* Odds */}
        {hasBets ? (
          <div className="flex items-center justify-between text-sm">
            <Badge className="tabular-nums">YES {odds.yesPct.toFixed(0)}%</Badge>
            <span className="mono text-[12px]" style={{ color: "var(--fg3)" }}>
              {fmtAmount(market.totalYes + market.totalNo, 6)} USDC pooled
            </span>
            <Badge variant="outline" className="tabular-nums">NO {odds.noPct.toFixed(0)}%</Badge>
          </div>
        ) : (
          <div className="text-[12px]" style={{ color: "var(--fg3)" }}>
            No bets yet — be the first to set the odds.
          </div>
        )}

        {/* Open: bet YES / NO */}
        {open && (
          <div className="space-y-2">
            <Label htmlFor="market-bet-sellout" className="text-sm">
              <span style={{ color: "var(--fg2)" }}>Stake</span>
              <Input
                id="market-bet-sellout"
                aria-label="Bet amount (USDC)"
                className="mono w-[110px]"
                type="number"
                min="0"
                step="0.01"
                value={amount}
                onChange={(e) => setAmount(clampUsdcInput(e.target.value))}
                disabled={isPending}
              />
              <span style={{ color: "var(--fg3)" }}>USDC</span>
            </Label>
            {parseUsdcUnits(amount) === null && (
              <div className="text-[11px]" style={{ color: "var(--hi-amber)" }}>
                Enter an amount greater than 0 (up to 6 decimals).
              </div>
            )}
            <div className="flex gap-2">
              <Button
                className="flex-1 min-h-11 sm:min-h-0"
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
              </Button>
              <Button
                variant="outline"
                className="flex-1 min-h-11 sm:min-h-0"
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
              </Button>
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
            <Button
              className="w-full min-h-11 sm:min-h-0"
              disabled={!addr || isPending}
              onClick={() => run(settleTx({ marketId: marketId!, eventId, coinType: USDC_COIN_TYPE }))}
            >
              <Icon icon="ph:gavel-bold" size={16} />
              {isPending ? "Settling…" : addr ? "Settle" : "Connect wallet to settle"}
            </Button>
          </div>
        )}

        {/* Settled: outcome + claim (gated on a real unclaimed winning stake). */}
        {market.settled && (() => {
          // Resolve claim eligibility from the caller's winning-side stake.
          const stakeLoading = Boolean(addr && winningTableId) && winStakeQ.isLoading;
          // A FAILED stake read (retry:false) leaves winningStake null — same as a
          // genuine "no entry". Distinguish it so a transient RPC error doesn't
          // masquerade as "you didn't win" and hide real winnings.
          const stakeReadFailed = Boolean(addr && winningTableId) && winStakeQ.isError;
          const hasWinningStake = winningStake !== null && winningStake > 0n;
          // An entry that exists but is 0 means the wallet already claimed.
          const alreadyClaimed = winningStake !== null && winningStake === 0n;
          return (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm">
                <span style={{ color: "var(--fg2)" }}>Outcome:</span>
                {market.outcomeYes ? (
                  <Badge>Sold out</Badge>
                ) : (
                  <Badge variant="outline">Did not sell out</Badge>
                )}
              </div>
              {!addr ? (
                <Button className="w-full" disabled>
                  <Icon icon="ph:coins-bold" size={16} /> Connect wallet to claim
                </Button>
              ) : stakeLoading ? (
                <Button className="w-full" disabled>
                  <Icon icon="ph:coins-bold" size={16} /> Checking your stake…
                </Button>
              ) : stakeReadFailed ? (
                <div className="space-y-1.5">
                  <Button
                    variant="outline"
                    className="w-full"
                    disabled={isPending}
                    onClick={() => winStakeQ.refetch()}
                  >
                    <Icon icon="ph:arrow-clockwise-bold" size={16} /> Couldn&apos;t check your stake — Retry
                  </Button>
                  <div className="text-[11px]" style={{ color: "var(--fg3)" }}>
                    We couldn&apos;t read your winning-side stake. Retry to check for claimable winnings.
                  </div>
                </div>
              ) : hasWinningStake ? (
                <>
                  <Button
                    className="w-full min-h-11 sm:min-h-0"
                    disabled={isPending}
                    onClick={() =>
                      run(claimTx({ marketId: marketId!, coinType: USDC_COIN_TYPE, recipient: addr! }))
                    }
                  >
                    <Icon icon="ph:coins-bold" size={16} />
                    {isPending ? "Claiming…" : "Claim winnings"}
                  </Button>
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
      </Card>
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
  onMarketChange,
}: {
  eventId: string;
  marketId: string | null;
  marketsLoading: boolean;
  maxTickets: bigint;
  refetchMarkets: () => void;
  // Called after a successful tx so a parent (the event page) can re-run its own
  // market-existence query and reveal/refresh the section without a reload.
  onMarketChange?: () => void;
}) {
  const account = useCurrentAccount();
  const addr = account?.address ?? null;

  const regular = useSignAndExecute();
  const sponsored = useSponsorAndExecute();
  const isPending = regular.isPending || sponsored.isPending;

  const [amount, setAmount] = useState("1");
  const [picked, setPicked] = useState(0);

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
    try {
      const out = ENOKI_ENABLED
        ? await sponsored.mutateAsync({ transaction: tx, sender: addr })
        : await regular.mutateAsync({ transaction: tx });
      toast.success("Transaction confirmed", {
        description: <TxLink digest={out.digest} chars={10} />,
      });
      refetchMarkets();
      marketQ.refetch();
      balanceQ.refetch();
      winStakeQ.refetch();
      onMarketChange?.();
    } catch (e: unknown) {
      toast.error(humanizeError(e));
    }
  }

  const now = Date.now();
  const loading = marketsLoading || (Boolean(marketId) && marketQ.isLoading);
  // The market id resolved but its getObject failed/returned no parseable
  // content — surface an error + Retry instead of a permanent "Loading…".
  const marketLoadFailed =
    Boolean(marketId) && !marketQ.isLoading && (marketQ.isError || !market);

  // Shared header used in every state of the card.
  const header = null;

  // ---- No market yet: permissionless create CTA (quartile cutoffs). ----
  if (!loading && !marketId) {
    const cutoffs = defaultCutoffs(maxTickets);
    const previewBuckets = cutoffs.length + 1;
    return (
      <div className="space-y-3">
        {header}
        <Card className="gap-3 p-4">
          <div className="text-sm" style={{ color: "var(--fg2)" }}>
            How many tickets will this event ultimately sell? Open a pooled market over{" "}
            {previewBuckets} ranges.
          </div>
          <div className="flex flex-wrap gap-1.5">
            {Array.from({ length: previewBuckets }, (_, i) => (
              <Badge key={i} variant="outline" className="mono">
                {bucketLabel(cutoffs, i)}
              </Badge>
            ))}
          </div>
          <Button
            className="w-full min-h-11 sm:min-h-0"
            disabled={!addr || isPending}
            onClick={() => run(createRangeMarketTx(eventId, USDC_COIN_TYPE, cutoffs))}
          >
            <Icon icon="mdi:chart-bar" size={16} />
            {isPending
              ? "Opening…"
              : addr
                ? "Create final-tickets-sold market"
                : "Connect wallet to open"}
          </Button>
          <div className="text-[11px]" style={{ color: "var(--fg3)" }}>
            Anyone can open this market — ranges default to quartiles of{" "}
            {String(maxTickets)} max tickets.
          </div>
        </Card>
      </div>
    );
  }

  // ---- Market getObject error: offer a Retry instead of a stuck spinner. ----
  if (marketLoadFailed) {
    return (
      <div className="space-y-3">
        {header}
        <Card className="gap-3 p-4">
          <div className="text-sm" style={{ color: "var(--color-danger)" }}>
            Couldn&apos;t load this market.
          </div>
          <Button variant="outline" className="w-full" onClick={() => marketQ.refetch()}>
            <Icon icon="ph:arrow-clockwise-bold" size={16} /> Retry
          </Button>
        </Card>
      </div>
    );
  }

  // ---- Loading market state. ----
  if (loading || !market) {
    return (
      <div className="space-y-3">
        {header}
        <Card className="gap-2 p-4">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-6 w-full" />
          <Skeleton className="h-6 w-full" />
          <Skeleton className="h-8 w-full" />
        </Card>
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
      <Card className="gap-4 p-4">
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
                  <span className="mono tabular-nums" style={{ color: "var(--fg3)" }}>
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
            <div className="space-y-1.5 text-sm">
              <Label htmlFor="market-bet-bucket" style={{ color: "var(--fg2)" }}>
                Bucket
              </Label>
              <Select
                value={String(safePicked)}
                onValueChange={(v) => setPicked(Number(v))}
                disabled={isPending}
              >
                <SelectTrigger id="market-bet-bucket" aria-label="Bucket" className="mono w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {market.totals.map((_, i) => (
                    <SelectItem key={i} value={String(i)} className="mono">
                      {bucketLabel(market.cutoffs, i)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Label htmlFor="market-bet-range" className="text-sm">
              <span style={{ color: "var(--fg2)" }}>Stake</span>
              <Input
                id="market-bet-range"
                aria-label="Bet amount (USDC)"
                className="mono w-[110px]"
                type="number"
                min="0"
                step="0.01"
                value={amount}
                onChange={(e) => setAmount(clampUsdcInput(e.target.value))}
                disabled={isPending}
              />
              <span style={{ color: "var(--fg3)" }}>USDC</span>
            </Label>
            {parseUsdcUnits(amount) === null && (
              <div className="text-[11px]" style={{ color: "var(--hi-amber)" }}>
                Enter an amount greater than 0 (up to 6 decimals).
              </div>
            )}
            <Button
              className="w-full min-h-11 sm:min-h-0"
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
            </Button>
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
            <Button
              className="w-full min-h-11 sm:min-h-0"
              disabled={!addr || isPending}
              onClick={() =>
                run(settleRangeTx({ marketId: marketId!, eventId, coinType: USDC_COIN_TYPE }))
              }
            >
              <Icon icon="ph:gavel-bold" size={16} />
              {isPending ? "Settling…" : addr ? "Settle" : "Connect wallet to settle"}
            </Button>
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
          // A FAILED winning-bucket stake read (retry:false) leaves winningStake
          // null — indistinguishable from a genuine "no entry". On the refund path
          // claim stays enabled regardless, so this only matters when there ARE
          // winners and the gate would otherwise read the error as "you didn't win".
          const stakeReadFailed =
            !refundPath && Boolean(addr && winningTableId) && winStakeQ.isError;
          const hasWinningStake = winningStake !== null && winningStake > 0n;
          const alreadyClaimed = winningStake !== null && winningStake === 0n;
          const canClaim = refundPath || hasWinningStake;
          return (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm">
                <span style={{ color: "var(--fg2)" }}>Winning bucket:</span>
                <Badge className="mono">
                  {bucketLabel(market.cutoffs, market.winningBucket)}
                </Badge>
              </div>
              {!addr ? (
                <Button className="w-full" disabled>
                  <Icon icon="ph:coins-bold" size={16} /> Connect wallet to claim
                </Button>
              ) : !refundPath && stakeLoading ? (
                <Button className="w-full" disabled>
                  <Icon icon="ph:coins-bold" size={16} /> Checking your stake…
                </Button>
              ) : stakeReadFailed ? (
                <div className="space-y-1.5">
                  <Button
                    variant="outline"
                    className="w-full"
                    disabled={isPending}
                    onClick={() => winStakeQ.refetch()}
                  >
                    <Icon icon="ph:arrow-clockwise-bold" size={16} /> Couldn&apos;t check your stake — Retry
                  </Button>
                  <div className="text-[11px]" style={{ color: "var(--fg3)" }}>
                    We couldn&apos;t read your winning-bucket stake. Retry to check for claimable winnings.
                  </div>
                </div>
              ) : canClaim ? (
                <>
                  <Button
                    className="w-full min-h-11 sm:min-h-0"
                    disabled={isPending}
                    onClick={() =>
                      run(claimRangeTx({ marketId: marketId!, coinType: USDC_COIN_TYPE, recipient: addr! }))
                    }
                  >
                    <Icon icon="ph:coins-bold" size={16} />
                    {isPending ? "Claiming…" : refundPath ? "Refund stake" : "Claim winnings"}
                  </Button>
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
      </Card>
    </div>
  );
}

/**
 * "Markets" section for an event page: the Sellout Clock (binary) + the
 * Final-tickets-sold range market, side by side on wide viewports. Both market
 * ids come from a single useEventMarkets call (one fully-enumerated MarketCreated
 * query per kind) and are passed down to the cards.
 */
export function EventMarketsScreen({
  eventId,
  eventSeq,
  maxTickets,
  onMarketChange,
}: {
  eventId: string;
  eventSeq: string;
  maxTickets: bigint;
  // Optional: forwarded to both cards so a market-creating (or any) tx can notify
  // a parent (the event page) to re-run its own existence query and reveal/refresh
  // the section live, without a reload.
  onMarketChange?: () => void;
}) {
  const { selloutMarketId, rangeMarketId, loading, refetch } = useEventMarkets(eventSeq);

  return (
    <div className="grid gap-6" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(280px,1fr))" }}>
      <SelloutMarketCard
        eventId={eventId}
        marketId={selloutMarketId}
        marketsLoading={loading}
        maxTickets={maxTickets}
        refetchMarkets={refetch}
        onMarketChange={onMarketChange}
      />
      <RangeMarketCard
        eventId={eventId}
        marketId={rangeMarketId}
        marketsLoading={loading}
        maxTickets={maxTickets}
        refetchMarkets={refetch}
        onMarketChange={onMarketChange}
      />
    </div>
  );
}

"use client";

import { useMemo, useState } from "react";
import { COINS, ENOKI_ENABLED, ORGANIZER_CAP_TYPE, coinInfo } from "@/lib/config";
import { useEventList } from "@/lib/events";
import {
  getFields,
  setAllowSelfCheckinTx,
  setPriceTx,
  withdrawEventBalanceTx,
} from "@/lib/ticketing";
import { useSignAndExecute, useSponsorAndExecute, useSuiQuery } from "@/lib/hooks";
import { humanizeError } from "@/lib/moveErrors";
import { Icon } from "./Icon";
import { TxLink } from "./TxLink";
import type {
  GetObjectParams,
  GetOwnedObjectsParams,
  PaginatedObjectsResponse,
  SuiObjectResponse,
} from "@mysten/sui/jsonRpc";

/** Events you organize, matched to the OrganizerCap you hold for each. */
export function MyEvents({ address }: { address: string }) {
  const { events } = useEventList();
  const capsQuery = useSuiQuery<
    "getOwnedObjects",
    GetOwnedObjectsParams,
    PaginatedObjectsResponse
  >("getOwnedObjects", {
    owner: address,
    filter: { StructType: ORGANIZER_CAP_TYPE },
    options: { showContent: true },
  });

  const capByEvent = useMemo(() => {
    const m = new Map<string, string>();
    if (!capsQuery.data) return m;
    for (const entry of capsQuery.data.data) {
      const f = getFields(entry);
      const capId = entry.data?.objectId;
      if (f && capId) m.set(String(f.event_id), capId);
    }
    return m;
  }, [capsQuery.data]);

  const mine = useMemo(
    () => events.filter((e) => e.organizer === address && capByEvent.has(e.eventId)),
    [events, address, capByEvent],
  );

  if (mine.length === 0) return null;

  return (
    <section className="space-y-5">
      <div>
        <span className="eyebrow">
          <Icon icon="material-symbols-light:analytics-rounded" size={14} /> Organizer
        </span>
        <h2 className="page-title" style={{ marginTop: 12, fontSize: 26 }}>
          Events you organize <span style={{ color: "var(--fg3)" }}>({mine.length})</span>
        </h2>
      </div>
      <div className="space-y-3">
        {mine.map((e) => (
          <MyEventRow
            key={e.eventId}
            eventId={e.eventId}
            capId={capByEvent.get(e.eventId)!}
            address={address}
            isFree={e.isFree}
          />
        ))}
      </div>
    </section>
  );
}

function MyEventRow({
  eventId,
  capId,
  address,
  isFree,
}: {
  eventId: string;
  capId: string;
  address: string;
  isFree: boolean;
}) {
  const q = useSuiQuery<"getObject", GetObjectParams, SuiObjectResponse>("getObject", {
    id: eventId,
    options: { showContent: true },
  });
  const regular = useSignAndExecute();
  const sponsored = useSponsorAndExecute();
  const isPending = regular.isPending || sponsored.isPending;
  const [coin, setCoin] = useState(COINS[0].type);
  const [priceStr, setPriceStr] = useState("1");
  const [err, setErr] = useState<string | null>(null);
  const [digest, setDigest] = useState<string | null>(null);

  const f = getFields(q.data ?? {});
  if (!f) return <div className="card mono">{eventId.slice(0, 14)}… loading</div>;
  const name = String(f.name);
  const minted = String(f.minted);
  const maxTickets = String(f.max_tickets);
  const allowSelf = Boolean(f.allow_self_checkin);

  // All organizer actions here (toggle / set_price / withdraw) are on the sponsor
  // allowlist, so gas is sponsored when Enoki is on — organizers never need SUI.
  async function send(tx: ReturnType<typeof setPriceTx>) {
    setErr(null);
    try {
      const out =
        ENOKI_ENABLED && address
          ? await sponsored.mutateAsync({ transaction: tx, sender: address })
          : await regular.mutateAsync({ transaction: tx });
      setDigest(out.digest);
      q.refetch();
    } catch (e: unknown) {
      setErr(humanizeError(e));
    }
  }

  function priceUnits(): bigint {
    const dec = coinInfo(coin).decimals;
    const n = Number(priceStr);
    if (!Number.isFinite(n) || n <= 0) return 0n;
    return BigInt(Math.round(n * 10 ** dec));
  }

  return (
    <div className="card space-y-3 text-sm">
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="font-medium">{name}</div>
          <div className="mono">
            {eventId.slice(0, 12)}… · sold {minted}/{maxTickets}
          </div>
        </div>
        <div
          className="flex items-center gap-2.5"
          title="Self check-in lets holders check themselves in within the event window (no staff voucher)."
        >
          <span className="text-[13px]" style={{ color: "var(--fg2)" }}>
            Self check-in
          </span>
          <div
            className={`switch ${allowSelf ? "on" : ""}`}
            role="switch"
            aria-checked={allowSelf}
            onClick={() => {
              if (!isPending) send(setAllowSelfCheckinTx({ capId, eventId, allow: !allowSelf }));
            }}
          />
        </div>
      </div>

      {!isFree && (
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <label className="label">Coin</label>
            <select className="select" value={coin} onChange={(e) => setCoin(e.target.value)}>
              {COINS.map((c) => (
                <option key={c.type} value={c.type}>
                  {c.symbol}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Price ({coinInfo(coin).symbol})</label>
            <input
              className="input"
              type="number"
              min={0}
              step="any"
              value={priceStr}
              onChange={(e) => setPriceStr(e.target.value)}
            />
          </div>
          <button
            className="btn btn-primary"
            disabled={isPending}
            onClick={() => send(setPriceTx({ capId, eventId, coinType: coin, price: priceUnits() }))}
          >
            Set price
          </button>
          <button
            className="btn"
            disabled={isPending}
            onClick={() =>
              send(withdrawEventBalanceTx({ capId, eventId, coinType: coin, recipient: address }))
            }
            title="Withdraw all accrued revenue in the selected coin (refundable events: only after the refund window)."
          >
            Withdraw {coinInfo(coin).symbol}
          </button>
        </div>
      )}
      {err && <div className="text-xs text-[var(--color-danger)] break-words">{err}</div>}
      {digest && <TxLink digest={digest} className="mono text-xs" style={{ color: "var(--color-success)" }} />}
    </div>
  );
}

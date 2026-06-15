"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
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
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
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

  const f = getFields(q.data ?? {});
  if (!f) return <Card className="mono p-4">{eventId.slice(0, 14)}… loading</Card>;
  const name = String(f.name);
  const minted = String(f.minted);
  const maxTickets = String(f.max_tickets);
  const allowSelf = Boolean(f.allow_self_checkin);

  // All organizer actions here (toggle / set_price / withdraw) are on the sponsor
  // allowlist, so gas is sponsored when Enoki is on — organizers never need SUI.
  async function send(tx: ReturnType<typeof setPriceTx>) {
    try {
      const out =
        ENOKI_ENABLED && address
          ? await sponsored.mutateAsync({ transaction: tx, sender: address })
          : await regular.mutateAsync({ transaction: tx });
      toast.success("Updated", {
        description: <TxLink digest={out.digest} chars={10} />,
      });
      q.refetch();
    } catch (e: unknown) {
      toast.error(humanizeError(e));
    }
  }

  function priceUnits(): bigint {
    const dec = coinInfo(coin).decimals;
    const n = Number(priceStr);
    if (!Number.isFinite(n) || n <= 0) return 0n;
    return BigInt(Math.round(n * 10 ** dec));
  }

  return (
    <Card className="space-y-3 p-4 text-sm">
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="font-medium">{name}</div>
          <div className="mono">
            {eventId.slice(0, 12)}… · sold {minted}/{maxTickets}
          </div>
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex items-center gap-2.5">
              <Label htmlFor={`self-checkin-${eventId}`} className="text-[13px]" style={{ color: "var(--fg2)" }}>
                Self check-in
              </Label>
              <Switch
                id={`self-checkin-${eventId}`}
                aria-label="Toggle self check-in"
                checked={allowSelf}
                disabled={isPending}
                onCheckedChange={() => {
                  if (!isPending) send(setAllowSelfCheckinTx({ capId, eventId, allow: !allowSelf }));
                }}
              />
            </div>
          </TooltipTrigger>
          <TooltipContent>
            Self check-in lets holders check themselves in within the event window (no staff voucher).
          </TooltipContent>
        </Tooltip>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button asChild size="sm">
          <Link href={`/manage/${eventId}`}>Manage</Link>
        </Button>
        <Button asChild variant="outline" size="sm">
          <Link href={`/event/${eventId}`}>View</Link>
        </Button>
      </div>

      {!isFree && (
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex flex-col gap-1.5">
            <Label>Coin</Label>
            <Select value={coin} onValueChange={setCoin}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {COINS.map((c) => (
                  <SelectItem key={c.type} value={c.type}>
                    {c.symbol}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Price ({coinInfo(coin).symbol})</Label>
            <Input
              type="number"
              min={0}
              step="any"
              value={priceStr}
              onChange={(e) => setPriceStr(e.target.value)}
            />
          </div>
          <Button
            size="sm"
            disabled={isPending}
            onClick={() => send(setPriceTx({ capId, eventId, coinType: coin, price: priceUnits() }))}
          >
            Set price
          </Button>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                disabled={isPending}
                onClick={() =>
                  send(withdrawEventBalanceTx({ capId, eventId, coinType: coin, recipient: address }))
                }
              >
                Withdraw {coinInfo(coin).symbol}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              Withdraw all accrued revenue in the selected coin (refundable events: only after the refund window).
            </TooltipContent>
          </Tooltip>
        </div>
      )}
    </Card>
  );
}

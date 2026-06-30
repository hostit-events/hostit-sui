"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { useDAppKit } from "@mysten/dapp-kit-react";
import { CurrentAccountSigner } from "@mysten/dapp-kit-core";
import { useEnokiFlow, useZkLogin } from "@mysten/enoki/react";
import { ENOKI_NETWORK } from "@/lib/auth";
import type { SessionKey } from "@mysten/seal";
import type {
  GetObjectParams,
  GetOwnedObjectsParams,
  PaginatedObjectsResponse,
  SuiObjectResponse,
} from "@mysten/sui/jsonRpc";
import { TICKET_TYPE, ORGANIZER_CAP_TYPE, ENOKI_ENABLED } from "@/lib/config";
import { useAllEvents } from "@/lib/events";
import { getFields } from "@/lib/ticketing";
import {
  useCurrentAccount,
  useCurrentClient,
  useSignAndExecute,
  useSponsorAndExecute,
  useSuiQuery,
} from "@/lib/hooks";
import { humanizeError } from "@/lib/moveErrors";
import { createSessionKey } from "@/lib/seal";
import {
  FORUM_CHANNELS,
  DEFAULT_FORUM_CHANNEL,
  EV_FORUM_POST,
  EV_FORUM_MODERATED,
  encryptForumMessage,
  forumPostTx,
  forumPostAsOrganizerTx,
  forumModerateTx,
  decryptForumMessage,
  foldModeration,
  MOD_HIDE,
  MOD_UNHIDE,
  MOD_PIN,
  MOD_UNPIN,
  type ForumCredential,
  type ModerationJson,
  type ModerationState,
} from "@/lib/forum";
import { AddressDisplay } from "@/components/AddressDisplay";
import { Icon } from "@/components/Icon";
import { TxLink } from "@/components/TxLink";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  InputGroup,
  InputGroupTextarea,
} from "@/components/ui/input-group";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { Message, MessageContent, MessageHeader, MessageFooter } from "@/components/ui/message";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker";
import {
  MessageScroller,
  MessageScrollerProvider,
  MessageScrollerViewport,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerButton,
} from "@/components/ui/message-scroller";

// PostCreated event payload anchored on-chain by `forum::post`.
interface ForumPostJson {
  event_id: string;
  channel: string;
  blob_id: string;
  author: string;
  ts_ms: string | number;
}

// A message after (attempted) decryption.
interface DecodedMessage {
  blobId: string;
  channel: string;
  author: string;
  tsMs: number;
  text: string | null; // null => decrypt failed / not yet decrypted
}

// An outgoing message rendered optimistically (iMessage/WhatsApp style): it shows
// in the stream the instant you hit send, before the encrypt → Walrus → on-chain
// round-trip lands. `blobId` is filled once stored on Walrus; the entry is dropped
// when its on-chain post appears in the feed (reconciliation), or kept as
// "failed" with a retry.
interface PendingMsg {
  localId: string;
  channel: string;
  text: string;
  ts: number;
  blobId?: string;
  status: "sending" | "sent" | "failed";
  error?: string;
}

export function ForumScreen({ id }: { id: string }) {
  const account = useCurrentAccount();
  const addr = account?.address ?? null;
  const suiClient = useCurrentClient();
  const dAppKit = useDAppKit();
  const enokiFlow = useEnokiFlow();
  const zk = useZkLogin();
  const regular = useSignAndExecute();
  const sponsored = useSponsorAndExecute();

  // --- Gate: does the wallet hold a ticket OR the organizer cap for THIS event? --
  const ownedQ = useSuiQuery<
    "getOwnedObjects",
    GetOwnedObjectsParams,
    PaginatedObjectsResponse
  >(
    "getOwnedObjects",
    {
      owner: addr ?? "",
      filter: { StructType: TICKET_TYPE },
      options: { showContent: true },
    },
    { enabled: Boolean(addr) },
  );

  const capsQ = useSuiQuery<
    "getOwnedObjects",
    GetOwnedObjectsParams,
    PaginatedObjectsResponse
  >(
    "getOwnedObjects",
    {
      owner: addr ?? "",
      filter: { StructType: ORGANIZER_CAP_TYPE },
      options: { showContent: true },
    },
    { enabled: Boolean(addr) },
  );

  const myTicketId = useMemo(() => {
    if (!ownedQ.data) return null;
    for (const entry of ownedQ.data.data) {
      const fields = getFields(entry);
      if (fields && String(fields.event_id) === id && entry.data?.objectId) {
        return entry.data.objectId;
      }
    }
    return null;
  }, [ownedQ.data, id]);

  const myCapId = useMemo(() => {
    if (!capsQ.data) return null;
    for (const entry of capsQ.data.data) {
      const fields = getFields(entry);
      if (fields && String(fields.event_id) === id && entry.data?.objectId) {
        return entry.data.objectId;
      }
    }
    return null;
  }, [capsQ.data, id]);

  const isOrganizer = Boolean(myCapId);
  const gatedIn = Boolean(addr && (myTicketId || myCapId));

  // Credential used for decrypt + post. A ticket takes precedence (organizers who
  // also hold a ticket post as a normal member); otherwise the organizer cap.
  const cred = useMemo<ForumCredential | null>(
    () =>
      myTicketId
        ? { kind: "ticket", ticketId: myTicketId }
        : myCapId
          ? { kind: "organizer", capId: myCapId }
          : null,
    [myTicketId, myCapId],
  );

  // Event organizer address — to badge organizer-authored posts (for everyone).
  const eventQ = useSuiQuery<"getObject", GetObjectParams, SuiObjectResponse>(
    "getObject",
    { id, options: { showContent: true } },
    { enabled: gatedIn },
  );
  const organizerAddr = useMemo(() => {
    const f = getFields(eventQ.data ?? {});
    return f ? String(f.organizer) : null;
  }, [eventQ.data]);

  // --- Channels -------------------------------------------------------------
  const [channel, setChannel] = useState<string>(DEFAULT_FORUM_CHANNEL);
  const channelMeta = useMemo(() => FORUM_CHANNELS.find((c) => c.id === channel), [channel]);
  const organizerOnlyChannel = Boolean(channelMeta?.organizerOnly);
  // Who may post in the active channel: everyone in normal channels; only the
  // organizer in an organizer-only channel (announcements).
  const canPost = !organizerOnlyChannel || isOrganizer;

  // --- Posts (on-chain anchors) for this event ------------------------------
  // FULLY enumerate the global PostCreated/PostModerated logs (cursor-followed via
  // useAllEvents, ~1000-log bound) instead of a single capped 200-log page: once
  // platform-wide activity exceeds the page, this event's own rows — and, for
  // moderation, an old `hide` tombstone — would silently fall off, un-hiding a
  // hidden post. useAllEvents has no enabled/refetchInterval; the hooks run
  // unconditionally, but every downstream effect/UI stays gated on `gatedIn`, so
  // the (cheap) background query when not gated in is simply unused.
  const postsQ = useAllEvents(EV_FORUM_POST);

  // --- Moderation tombstones (organizer hide/pin) ---------------------------
  const modQ = useAllEvents(EV_FORUM_MODERATED);

  const modState = useMemo<Map<string, ModerationState>>(() => {
    // modQ.data is useAllEvents' { data, truncated } envelope (≅ the old
    // PaginatedEvents): .data is the SuiEvent[], same hop count as before.
    const rows = (modQ.data?.data ?? [])
      .map((ev) => ev.parsedJson as ModerationJson)
      .filter((m) => m && m.event_id === id);
    return foldModeration(rows);
  }, [modQ.data, id]);

  const channelPosts = useMemo<ForumPostJson[]>(() => {
    if (!postsQ.data) return [];
    let rows = postsQ.data.data
      .map((ev) => ev.parsedJson as ForumPostJson)
      .filter((p) => p && p.event_id === id && p.channel === channel);
    // Organizer-only channels: only the organizer's own posts are valid here, so a
    // ticket holder can't surface a message by crafting a raw `post` with this
    // channel string — the read layer drops any non-organizer author.
    if (organizerOnlyChannel) {
      rows = rows.filter((p) => organizerAddr != null && p.author === organizerAddr);
    }
    return rows.sort((a, b) => Number(a.ts_ms) - Number(b.ts_ms)); // oldest -> newest
  }, [postsQ.data, id, channel, organizerOnlyChannel, organizerAddr]);

  // On-chain blob ids posted to THIS event — used to reconcile optimistic
  // (pending) messages: once a pending message's blob appears on-chain, drop it.
  const eventBlobIds = useMemo(() => {
    const s = new Set<string>();
    for (const ev of postsQ.data?.data ?? []) {
      const p = ev.parsedJson as ForumPostJson;
      if (p && p.event_id === id) s.add(p.blob_id);
    }
    return s;
  }, [postsQ.data, id]);

  // True when either source hit the page bound (older posts / moderation actions
  // exist but aren't loaded) — surfaced as a banner below the channel list.
  const forumTruncated = Boolean(modQ.data?.truncated || postsQ.data?.truncated);

  // Pinned posts surface to the top; the rest stay chronological.
  const orderedPosts = useMemo<ForumPostJson[]>(() => {
    const pinned = channelPosts.filter((p) => modState.get(p.blob_id)?.pinned);
    const rest = channelPosts.filter((p) => !modState.get(p.blob_id)?.pinned);
    return [...pinned, ...rest];
  }, [channelPosts, modState]);

  // --- Seal SessionKey (auto-minted on open for gated users; ~10-min TTL) -----
  const sessionRef = useRef<SessionKey | null>(null);
  const sessionPromiseRef = useRef<Promise<SessionKey | null> | null>(null);
  const [sessionReady, setSessionReady] = useState(false);
  const [signing, setSigning] = useState(false);
  const [decrypting, setDecrypting] = useState(false);

  // Mint (or reuse) the Seal SessionKey. zkLogin signs the personal message with
  // the Enoki ephemeral key (seamless, no popup); an external wallet shows ONE
  // prompt. The in-flight promise is cached so concurrent callers (the
  // auto-decrypt effect + a post/moderate action) never trigger a second prompt.
  const ensureSession = useCallback(async (): Promise<SessionKey | null> => {
    if (sessionRef.current) return sessionRef.current;
    if (sessionPromiseRef.current) return sessionPromiseRef.current;
    if (!addr) return null;
    const promise = (async () => {
      setSigning(true);
      try {
        const sk = await createSessionKey(suiClient, addr, async (message) => {
          // zkLogin (Google/Enoki) has no dapp-kit wallet — signing via
          // CurrentAccountSigner there throws "No wallet is connected". Sign with
          // the Enoki ephemeral keypair instead (seamless, no popup); external
          // wallets still go through CurrentAccountSigner (one prompt). Mirrors
          // lib/hooks.ts + lib/memoryClient.ts.
          if (zk.address) {
            const keypair = await enokiFlow.getKeypair({ network: ENOKI_NETWORK });
            const r = await keypair.signPersonalMessage(message);
            return { signature: r.signature };
          }
          const signer = new CurrentAccountSigner(dAppKit);
          const r = await signer.signPersonalMessage(message);
          return { signature: r.signature };
        });
        sessionRef.current = sk;
        setSessionReady(true);
        return sk;
      } catch (e: unknown) {
        toast.error(humanizeError(e));
        return null;
      } finally {
        setSigning(false);
        sessionPromiseRef.current = null;
      }
    })();
    sessionPromiseRef.current = promise;
    return promise;
  }, [addr, suiClient, dAppKit, zk.address, enokiFlow]);

  // --- Decrypted message cache (keyed by blob id) ---------------------------
  const [decoded, setDecoded] = useState<Record<string, DecodedMessage>>({});

  // AUTO-DECRYPT on open + channel switch (GH#66): for gated users, mint the
  // session if needed (seamless for zkLogin; one prompt for a wallet) and decode
  // the channel — no manual click. Strictly gated on `gatedIn`, so a non-holder
  // never gets a signature prompt. We only touch posts not yet ATTEMPTED (an entry
  // exists once attempted, even if it failed) so failures don't auto-retry in a
  // loop — the fallback button / per-message retry re-signs. Results are committed
  // in ONE setState so the effect doesn't re-fire mid-decode.
  useEffect(() => {
    if (!gatedIn || !cred) return;
    const pending = channelPosts.filter((p) => decoded[p.blob_id] === undefined);
    if (pending.length === 0) return;

    let alive = true;
    (async () => {
      setDecrypting(true);
      try {
        const sk = await ensureSession();
        const results: Record<string, DecodedMessage> = {};
        for (const p of pending) {
          const base: DecodedMessage = {
            blobId: p.blob_id,
            channel: p.channel,
            author: p.author,
            tsMs: Number(p.ts_ms),
            text: null,
          };
          if (!sk) {
            // mint declined/failed — mark attempted (encrypted); the fallback re-signs.
            results[p.blob_id] = base;
            continue;
          }
          try {
            const body = await decryptForumMessage(suiClient, sk, p.blob_id, cred, id);
            results[p.blob_id] = { ...base, text: body.text };
          } catch {
            results[p.blob_id] = base;
          }
        }
        if (alive) setDecoded((m) => ({ ...m, ...results }));
      } finally {
        if (alive) setDecrypting(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [channelPosts, gatedIn, cred, suiClient, id, ensureSession, decoded]);

  // Fallback "re-sign / retry" action: re-mint the session (if expired) and
  // re-decode this channel, overwriting failed attempts. Auto-decrypt is the
  // primary path; this covers a declined/expired session or a failed decrypt.
  async function unlockMessages() {
    setDecrypting(true);
    try {
      const sk = await ensureSession();
      if (!sk || !cred) return;
      for (const p of channelPosts) {
        const base: DecodedMessage = {
          blobId: p.blob_id,
          channel: p.channel,
          author: p.author,
          tsMs: Number(p.ts_ms),
          text: null,
        };
        try {
          const body = await decryptForumMessage(suiClient, sk, p.blob_id, cred, id);
          setDecoded((m) => ({ ...m, [p.blob_id]: { ...base, text: body.text } }));
        } catch {
          setDecoded((m) => ({ ...m, [p.blob_id]: base }));
        }
      }
    } finally {
      setDecrypting(false);
    }
  }

  // --- Composer (optimistic send) -------------------------------------------
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<PendingMsg[]>([]);
  const pendingSeqRef = useRef(0);
  const inFlightRef = useRef(false);

  const MAX_MESSAGE_LEN = 1000;

  // Optimistic bubbles for the active channel not yet reconciled with the chain.
  const visiblePending = useMemo(
    () =>
      pending.filter(
        (p) => p.channel === channel && !(p.blobId && eventBlobIds.has(p.blobId)),
      ),
    [pending, channel, eventBlobIds],
  );

  // Enqueue: clear the input and show the bubble IMMEDIATELY; the processor below
  // does the encrypt → Walrus → on-chain work. (iMessage/WhatsApp/Discord feel.)
  function enqueueMessage() {
    const text = draft.trim();
    if (!text || !addr || !cred || !canPost) return;
    setPending((cur) => [
      ...cur,
      { localId: `p${pendingSeqRef.current++}`, channel, text, ts: Date.now(), status: "sending" },
    ]);
    setDraft("");
  }

  // Sequential processor — one in flight at a time. Forum posts reference the
  // sender's OWNED Ticket object, so concurrent txs risk equivocation; we queue.
  useEffect(() => {
    if (inFlightRef.current || !addr || !cred) return;
    const next = pending.find((p) => p.status === "sending");
    if (!next) return;
    inFlightRef.current = true;
    (async () => {
      try {
        // Encrypt to the event policy + pin on Walrus (skip if a retry already did).
        let blobId = next.blobId;
        if (!blobId) {
          blobId = await encryptForumMessage(suiClient, id, {
            text: next.text,
            author: addr,
            ts: next.ts,
          });
          const stored = blobId;
          setPending((cur) =>
            cur.map((p) => (p.localId === next.localId ? { ...p, blobId: stored } : p)),
          );
        }
        // Anchor on-chain — ticket holders via post, organizer via the cap.
        const tx =
          cred.kind === "ticket"
            ? forumPostTx(id, cred.ticketId, next.channel, blobId)
            : forumPostAsOrganizerTx(id, cred.capId, next.channel, blobId);
        const out = ENOKI_ENABLED
          ? await sponsored.mutateAsync({ transaction: tx, sender: addr })
          : await regular.mutateAsync({ transaction: tx });
        // Seed plaintext so the post renders instantly once refetch lands it.
        const seeded = blobId;
        setDecoded((m) => ({
          ...m,
          [seeded]: { blobId: seeded, channel: next.channel, author: addr, tsMs: next.ts, text: next.text },
        }));
        setPending((cur) =>
          cur.map((p) => (p.localId === next.localId ? { ...p, status: "sent" } : p)),
        );
        toast.success("Message posted", {
          description: <TxLink digest={out.digest} chars={10} />,
        });
        void ensureSession(); // so subsequent fetches can decrypt others'
        postsQ.refetch();
      } catch (e: unknown) {
        setPending((cur) =>
          cur.map((p) =>
            p.localId === next.localId ? { ...p, status: "failed", error: humanizeError(e) } : p,
          ),
        );
      } finally {
        inFlightRef.current = false;
      }
    })();
  }, [pending, addr, cred, suiClient, id, sponsored, regular, ensureSession, postsQ]);

  // Reconcile: once a sent message's blob is on-chain, drop its optimistic bubble
  // (the real post — with its plaintext already seeded — takes over seamlessly).
  useEffect(() => {
    setPending((cur) => {
      const next = cur.filter((p) => !(p.blobId && eventBlobIds.has(p.blobId)));
      return next.length === cur.length ? cur : next;
    });
  }, [eventBlobIds]);

  const retryPending = useCallback((localId: string) => {
    setPending((cur) =>
      cur.map((p) => (p.localId === localId ? { ...p, status: "sending", error: undefined } : p)),
    );
  }, []);
  const dismissPending = useCallback((localId: string) => {
    setPending((cur) => cur.filter((p) => p.localId !== localId));
  }, []);

  // --- Moderation (organizer only) ------------------------------------------
  const moderatingRef = useRef(false);
  async function runModerate(blobId: string, action: number) {
    if (!myCapId || !addr) return;
    // Re-entry guard so a double-tap on hide/pin can't fire two moderate txs
    // (the second aborts and surfaces a confusing error after the first succeeds).
    if (moderatingRef.current) return;
    moderatingRef.current = true;
    try {
      const tx = forumModerateTx(id, myCapId, blobId, action);
      const out = ENOKI_ENABLED
        ? await sponsored.mutateAsync({ transaction: tx, sender: addr })
        : await regular.mutateAsync({ transaction: tx });
      toast.success(
        action === MOD_HIDE
          ? "Post hidden"
          : action === MOD_UNHIDE
            ? "Post restored"
            : action === MOD_PIN
              ? "Post pinned"
              : "Post unpinned",
        { description: <TxLink digest={out.digest} chars={10} /> },
      );
      modQ.refetch();
    } catch (e: unknown) {
      toast.error(humanizeError(e));
    } finally {
      moderatingRef.current = false;
    }
  }

  // --- Render: not connected ------------------------------------------------
  if (!addr) {
    return (
      <ForumShell id={id}>
        <LockOverlay
          id={id}
          title="Connect your wallet"
          body="Forums are private to an event's ticket holders and its organizer. Connect your wallet to join the conversation."
          cta="View event"
        />
      </ForumShell>
    );
  }

  // --- Render: gate (checking / error) --------------------------------------
  if (ownedQ.isLoading || capsQ.isLoading) {
    return (
      <ForumShell id={id}>
        <Card className="mono p-4">Checking your access…</Card>
      </ForumShell>
    );
  }

  if (ownedQ.isError && capsQ.isError) {
    return (
      <ForumShell id={id}>
        <Card className="flex flex-row flex-wrap items-center gap-2 p-4 text-destructive">
          Could not verify your access.{" "}
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              ownedQ.refetch();
              capsQ.refetch();
            }}
          >
            Retry
          </Button>
        </Card>
      </ForumShell>
    );
  }

  if (!gatedIn) {
    return (
      <ForumShell id={id}>
        <LockOverlay
          id={id}
          title="Get a ticket to join"
          body="This is a private, end-to-end encrypted forum for ticket holders. Grab a ticket to unlock the channels, lineup chatter, ride-shares and the market. (Organizers get in with their event's organizer cap.)"
          cta="Get a ticket"
        />
      </ForumShell>
    );
  }

  // --- Render: gated-in (rail + stream + composer) --------------------------
  return (
    <ForumShell id={id}>
      <div
        className="grid gap-5 grid-cols-1 lg:grid-cols-[minmax(180px,220px)_1fr]"
        style={{ alignItems: "start" }}
      >
        {/* Left rail: channels (desktop only). On mobile a sticky rail here overlaps
            the chat, so channels collapse into a drawer opened from the chat header. */}
        <Card className="hidden p-4 lg:block" style={{ position: "sticky", top: 16 }}>
          <span className="section-label">Channels</span>
          <div className="mt-3">
            <ChannelNav channel={channel} onSelect={setChannel} isOrganizer={isOrganizer} />
          </div>
        </Card>

        {/* Center: message stream + composer. Definite height so the MessageScroller's
            size-full → flex-1 → viewport chain resolves and actually scrolls. */}
        <Card className="flex flex-col gap-0 p-0" style={{ height: "min(68vh, 560px)" }}>
          <header
            className="flex items-center justify-between border-b"
            style={{ padding: "14px 18px" }}
          >
            {/* Mobile: a compact dropdown switches channels (the rail is hidden below
                lg). Desktop: a plain label, since the rail is always visible. */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="-ml-2 gap-1.5 font-semibold lg:hidden">
                  <Icon icon={channelMeta?.icon ?? "ic:round-tag"} size={18} />
                  {channelMeta?.label ?? channel}
                  <Icon icon="ic:round-expand-more" size={16} />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-52">
                <DropdownMenuLabel>Channels</DropdownMenuLabel>
                <DropdownMenuRadioGroup value={channel} onValueChange={setChannel}>
                  {FORUM_CHANNELS.map((c) => (
                    <DropdownMenuRadioItem key={c.id} value={c.id}>
                      <Icon icon={c.icon} size={16} /> {c.label}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            <div className="hidden items-center gap-2 font-semibold lg:flex">
              <Icon icon={channelMeta?.icon ?? "ic:round-tag"} size={18} />
              {channelMeta?.label ?? channel}
            </div>
            <div className="flex items-center gap-2">
              {signing || decrypting ? (
                // Auto-unlock in progress (session mint / decrypt). For zkLogin this
                // is instant + popup-free; an external wallet shows one prompt.
                <Badge variant="secondary" aria-live="polite">
                  <Icon icon="ic:round-lock-open" size={11} />
                  {signing ? "Unlocking…" : "Decrypting…"}
                </Badge>
              ) : sessionReady ? (
                <Badge variant="secondary">
                  <Icon icon="ic:round-lock-open" size={11} /> Session active
                </Badge>
              ) : (
                // Fallback: auto-unlock was declined or the session expired.
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="outline" size="sm" onClick={unlockMessages}>
                      <Icon icon="ic:round-lock-open" size={14} /> Decrypt thread
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    Re-sign your session to decrypt (valid ~10 min).
                  </TooltipContent>
                </Tooltip>
              )}
            </div>
          </header>

          {/* autoScroll = sticky-bottom: follows new content + bubble reflow (async
              decrypt expanding the encrypted placeholder to plaintext) WHILE you're at
              the bottom, but disengages once you scroll up to read history. */}
          <MessageScrollerProvider autoScroll>
            <div className="min-h-0 flex-1 overflow-hidden">
              <MessageScroller>
                <MessageScrollerViewport>
                  <MessageScrollerContent className="gap-3 p-[18px]">
                    {forumTruncated && (
                      // Older posts/moderation actions exist beyond the loaded page bound.
                      <Marker variant="separator" className="text-xs">
                        <MarkerContent>
                          Older posts &amp; moderation actions aren&apos;t all loaded yet.
                        </MarkerContent>
                      </Marker>
                    )}
                    {postsQ.isLoading && channelPosts.length === 0 && visiblePending.length === 0 ? (
                      <div className="mono" style={{ color: "var(--fg3)" }}>
                        Loading messages…
                      </div>
                    ) : postsQ.isError && channelPosts.length === 0 && visiblePending.length === 0 ? (
                      <div
                        className="flex flex-col items-center justify-center grow text-center"
                        style={{ color: "var(--color-danger)", gap: 8, padding: "40px 0" }}
                      >
                        <Icon icon="ic:round-error-outline" size={40} />
                        <div className="font-semibold">Could not load messages</div>
                        <Button variant="outline" size="sm" onClick={() => postsQ.refetch()}>
                          Retry
                        </Button>
                      </div>
                    ) : channelPosts.length === 0 && visiblePending.length === 0 ? (
                      <div
                        className="flex flex-col items-center justify-center grow text-center"
                        style={{ color: "var(--fg3)", gap: 8, padding: "40px 0" }}
                      >
                        <Icon icon={organizerOnlyChannel ? "ic:round-campaign" : "ic:round-forum"} size={40} />
                        <div className="font-semibold" style={{ color: "var(--fg2)" }}>
                          {organizerOnlyChannel ? "No announcements yet" : "No messages yet"}
                        </div>
                        <p className="text-sm">
                          {organizerOnlyChannel
                            ? isOrganizer
                              ? "Post the first announcement — only you can post here; ticket holders read it."
                              : "The organizer hasn’t posted any announcements yet."
                            : `Be the first to post in #${channelMeta?.label}.`}
                        </p>
                      </div>
                    ) : (
                      <>
                        {orderedPosts.map((p) => (
                          // scrollAnchor on YOUR own posts: sending pins you to the
                          // bottom, but others' messages don't yank you mid-read.
                          <MessageScrollerItem
                            key={p.blob_id}
                            messageId={p.blob_id}
                            scrollAnchor={p.author === addr}
                          >
                            <MessageRow
                              msg={
                                decoded[p.blob_id] ?? {
                                  blobId: p.blob_id,
                                  channel: p.channel,
                                  author: p.author,
                                  tsMs: Number(p.ts_ms),
                                  text: null,
                                }
                              }
                              mine={p.author === addr}
                              isOrganizerPost={Boolean(organizerAddr && p.author === organizerAddr)}
                              mod={modState.get(p.blob_id)}
                              canModerate={isOrganizer}
                              onModerate={runModerate}
                              onResign={unlockMessages}
                              sessionReady={sessionReady}
                            />
                          </MessageScrollerItem>
                        ))}
                        {visiblePending.map((p) => (
                          <MessageScrollerItem key={p.localId} messageId={p.localId} scrollAnchor>
                            <PendingRow
                              msg={p}
                              onRetry={() => retryPending(p.localId)}
                              onDismiss={() => dismissPending(p.localId)}
                            />
                          </MessageScrollerItem>
                        ))}
                      </>
                    )}
                  </MessageScrollerContent>
                </MessageScrollerViewport>
                {/* Jump-to-latest — appears only when scrolled up from the bottom. */}
                <MessageScrollerButton />
              </MessageScroller>
            </div>
          </MessageScrollerProvider>

          {/* Composer — or a read-only notice in an organizer-only channel */}
          {canPost ? (
            <div className="border-t" style={{ padding: 14 }}>
              {/* Slim composer (Discord-style): single-line input that auto-grows.
                  Enter sends on a physical keyboard (fine pointer), Shift+Enter = newline;
                  on touch the soft-keyboard Enter makes a newline and the user taps the
                  send button beside the box. */}
              <div className="flex items-end gap-2">
                <InputGroup className="min-w-0 flex-1">
                  <InputGroupTextarea
                    rows={1}
                    className="max-h-40 min-h-0"
                    placeholder={
                      organizerOnlyChannel
                        ? "Post an announcement to all ticket holders…"
                        : `Message #${channelMeta?.label ?? channel}…`
                    }
                    value={draft}
                    maxLength={MAX_MESSAGE_LEN}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      // Send on Enter only with a physical keyboard (fine pointer) and not
                      // mid-IME-composition; Shift+Enter always inserts a newline. On touch,
                      // Enter falls through to a newline and the user taps the send button.
                      if (
                        e.key === "Enter" &&
                        !e.shiftKey &&
                        !e.nativeEvent.isComposing &&
                        typeof window !== "undefined" &&
                        window.matchMedia("(pointer: fine)").matches
                      ) {
                        e.preventDefault();
                        enqueueMessage();
                      }
                    }}
                    aria-label={organizerOnlyChannel ? "Write an announcement" : "Write a message"}
                  />
                </InputGroup>
                {/* Send button beside the box — desktop + mobile; disabled until there's text. */}
                <Button
                  variant="default"
                  size="icon"
                  aria-label={
                    organizerOnlyChannel
                      ? "Announce"
                      : isOrganizer && !myTicketId
                        ? "Send as organizer"
                        : "Send"
                  }
                  className="size-10 shrink-0"
                  disabled={!draft.trim()}
                  onClick={enqueueMessage}
                >
                  <Icon icon="ic:round-send" size={18} />
                </Button>
              </div>
              {/* Desktop hint — physical keyboard only (on touch, Enter inserts a newline). */}
              <p className="mono mt-1.5 hidden text-[10px] text-muted-foreground [@media(pointer:fine)]:block">
                <span className="font-semibold text-foreground">Enter</span> to send ·{" "}
                <span className="font-semibold text-foreground">Shift+Enter</span> for a new line
              </p>
            </div>
          ) : (
            <div className="border-t" style={{ padding: 16 }}>
              <Marker className="justify-center text-sm">
                <MarkerIcon>
                  <Icon icon="ic:round-campaign" size={15} />
                </MarkerIcon>
                <MarkerContent className="text-center">
                  Only the organizer can post in #{channelMeta?.label}. Their announcements show here.
                </MarkerContent>
              </Marker>
            </div>
          )}
        </Card>
      </div>
    </ForumShell>
  );
}

// ---------------------------------------------------------------------------
// Inline subcomponents
// ---------------------------------------------------------------------------

// Channel list — shared by the desktop rail and the mobile drawer.
function ChannelNav({
  channel,
  onSelect,
  isOrganizer,
}: {
  channel: string;
  onSelect: (v: string) => void;
  isOrganizer: boolean;
}) {
  return (
    <>
      <ToggleGroup
        type="single"
        value={channel}
        onValueChange={(v) => {
          if (v) onSelect(v);
        }}
        orientation="vertical"
        variant="outline"
        className="w-full"
      >
        {FORUM_CHANNELS.map((c) => (
          <ToggleGroupItem
            key={c.id}
            value={c.id}
            aria-label={c.label}
            className="w-full justify-start"
          >
            <Icon icon={c.icon} size={16} /> {c.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      {isOrganizer && (
        <Badge variant="secondary" className="mt-3">
          <Icon icon="streamline:star-badge-solid" size={11} /> Organizer
        </Badge>
      )}
      <div
        className="mono"
        style={{ marginTop: 16, fontSize: 11, color: "var(--fg3)", lineHeight: 1.5 }}
      >
        <Icon icon="ic:round-lock" size={12} /> Seal-encrypted ·{" "}
        {isOrganizer ? "organizer admin" : "ticket-gated"}
      </div>
    </>
  );
}

function ForumShell({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <div className="space-y-6 screen-in">
      <header className="relative">
        <div
          className="glow"
          style={{
            width: 360,
            height: 360,
            background: "rgba(0,124,250,.4)",
            top: -150,
            right: -40,
            opacity: 0.2,
          }}
        />
        <div className="flex items-center justify-between gap-3" style={{ marginTop: 12 }}>
          <h1 className="page-title" style={{ fontSize: 30 }}>
            Event chat
          </h1>
          <Button asChild variant="outline" size="sm">
            <Link href={`/event/${id}`}>
              <Icon icon="ic:round-arrow-back" size={15} /> Back to event
            </Link>
          </Button>
        </div>
        <p className="page-sub">
          Private, encrypted channels for ticket holders — powered by Walrus + Seal.
        </p>
      </header>
      {children}
    </div>
  );
}

function LockOverlay({
  id,
  title,
  body,
  cta,
}: {
  id: string;
  title: string;
  body: string;
  cta: string;
}) {
  return (
    <Card className="relative gap-0 overflow-hidden p-0">
      <div className="poster" style={{ height: 140, ["--p1" as string]: "var(--hi-blue)", ["--p2" as string]: "var(--hi-magenta)" } as React.CSSProperties}>
        <div className="poster-noise" />
        <span className="poster-glyph">
          <Icon icon="ic:round-lock" size={72} />
        </span>
      </div>
      <div className="flex flex-col items-center text-center" style={{ padding: "28px 22px 30px", gap: 10 }}>
        <h2 className="page-title" style={{ fontSize: 22 }}>
          {title}
        </h2>
        <p className="page-sub" style={{ maxWidth: 460 }}>
          {body}
        </p>
        <Button asChild size="lg" style={{ marginTop: 6 }}>
          <Link href={`/event/${id}`}>
            <Icon icon="ion:ticket" size={16} /> {cta}
          </Link>
        </Button>
      </div>
    </Card>
  );
}

function MessageRow({
  msg,
  mine,
  isOrganizerPost,
  mod,
  canModerate,
  onModerate,
  onResign,
  sessionReady,
}: {
  msg: DecodedMessage;
  mine: boolean;
  isOrganizerPost: boolean;
  mod: ModerationState | undefined;
  canModerate: boolean;
  onModerate: (blobId: string, action: number) => void;
  onResign: () => void;
  sessionReady: boolean;
}) {
  const time = new Date(msg.tsMs).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  const hidden = Boolean(mod?.hidden);
  const pinned = Boolean(mod?.pinned);

  return (
    <Message align={mine ? "end" : "start"}>
      <MessageContent>
        <MessageHeader className="gap-2">
          {pinned && (
            <Badge variant="secondary">
              <Icon icon="ic:round-push-pin" size={11} /> pinned
            </Badge>
          )}
          {isOrganizerPost && (
            <Badge variant="secondary">
              <Icon icon="streamline:star-badge-solid" size={11} /> organizer
            </Badge>
          )}
          {mine ? (
            <Badge variant="default">you</Badge>
          ) : (
            <AddressDisplay address={msg.author} suffix={4} />
          )}
          <span className="mono">{time}</span>
          {canModerate && (
            <span className="flex items-center gap-1">
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    className="inline-flex items-center justify-center min-h-11 min-w-11 sm:min-h-0 sm:min-w-0 text-muted-foreground hover:text-foreground transition-[color,transform] active:scale-[0.96]"
                    aria-label={pinned ? "Unpin" : "Pin"}
                    onClick={() => onModerate(msg.blobId, pinned ? MOD_UNPIN : MOD_PIN)}
                  >
                    <Icon icon={pinned ? "ic:round-push-pin" : "ic:outline-push-pin"} size={14} />
                  </button>
                </TooltipTrigger>
                <TooltipContent>{pinned ? "Unpin" : "Pin"}</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    className="inline-flex items-center justify-center min-h-11 min-w-11 sm:min-h-0 sm:min-w-0 text-muted-foreground hover:text-foreground transition-[color,transform] active:scale-[0.96]"
                    aria-label={hidden ? "Unhide" : "Hide"}
                    onClick={() => onModerate(msg.blobId, hidden ? MOD_UNHIDE : MOD_HIDE)}
                  >
                    <Icon icon={hidden ? "ic:round-visibility" : "ic:round-visibility-off"} size={14} />
                  </button>
                </TooltipTrigger>
                <TooltipContent>{hidden ? "Unhide" : "Hide"}</TooltipContent>
              </Tooltip>
            </span>
          )}
        </MessageHeader>

        {hidden ? (
          <Bubble variant="muted">
            <BubbleContent>
              <span className="flex items-center gap-1.5 text-sm text-muted-foreground italic">
                <Icon icon="ic:round-visibility-off" size={13} /> Hidden by organizer
              </span>
            </BubbleContent>
          </Bubble>
        ) : (
          <Bubble variant={mine ? "tinted" : "muted"}>
            <BubbleContent>
              {msg.text != null ? (
                <span className="whitespace-pre-wrap">{msg.text}</span>
              ) : (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground transition-[color,transform] active:scale-[0.96]"
                      onClick={onResign}
                    >
                      <Icon icon="ic:round-lock" size={13} />
                      [encrypted — re-sign session]
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>
                    {sessionReady ? "Decrypt failed — re-sign your session." : "Sign a session to decrypt."}
                  </TooltipContent>
                </Tooltip>
              )}
            </BubbleContent>
          </Bubble>
        )}
      </MessageContent>
    </Message>
  );
}

// Optimistic outgoing bubble: right-aligned like "you", with a sending spinner /
// sent check / failed-with-retry footer. Replaced by the real MessageRow once the
// on-chain post lands (reconciliation in ForumScreen).
function PendingRow({
  msg,
  onRetry,
  onDismiss,
}: {
  msg: PendingMsg;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  const time = new Date(msg.ts).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  const failed = msg.status === "failed";
  return (
    <Message align="end">
      <MessageContent>
        <MessageHeader className="gap-2">
          <Badge variant="default">you</Badge>
          <span className="mono">{time}</span>
        </MessageHeader>
        <Bubble variant="tinted" className={cn(msg.status === "sending" && "opacity-60")}>
          <BubbleContent>
            <span className="whitespace-pre-wrap">{msg.text}</span>
          </BubbleContent>
        </Bubble>
        <MessageFooter className={cn("mono gap-1.5", failed && "text-destructive")}>
          {msg.status === "sending" ? (
            <>
              <Icon icon="svg-spinners:3-dots-fade" size={12} /> Sending…
            </>
          ) : msg.status === "sent" ? (
            <>
              <Icon icon="ph:check-circle-fill" size={12} /> Sent
            </>
          ) : (
            <>
              <Icon icon="ic:round-error-outline" size={12} />
              {msg.error ?? "Failed to send"}
              <button onClick={onRetry} className="underline hover:text-foreground">
                Retry
              </button>
              <button onClick={onDismiss} className="underline hover:text-foreground">
                Dismiss
              </button>
            </>
          )}
        </MessageFooter>
      </MessageContent>
    </Message>
  );
}

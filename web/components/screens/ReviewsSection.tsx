"use client";

import * as React from "react";
import { motion, AnimatePresence } from "motion/react";
import { Loader2, Send, Star } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/States";
import { cn } from "@/lib/utils";
import { MAX_COMMENT_LEN, type Review } from "@/lib/reviews";
import { AddressDisplay } from "@/components/AddressDisplay";

// Purely presentational — all data + handlers arrive via props. The event page
// owns the POAP gate (canReview), the on-chain reads, and the submit flow. This
// component never touches Sui, localStorage, or lib/reviews directly: it just
// renders the star picker, the gate states, and the review list.
export interface ReviewsSectionProps {
  reviews: Review[];
  averageRating: number;
  reviewCount: number;
  /** Wallet connected AND holds this event's POAP. */
  canReview: boolean;
  /** This wallet has already reviewed this event. */
  hasReviewed: boolean;
  /** Mid-submit (real tx/store write) — disables the form + shows the spinner. */
  submitting: boolean;
  onSubmit: (rating: number, comment: string) => void;
  /**
   * Optional async-state hints for the review list fetch. The event page owns
   * the on-chain read (a react-query), so it can thread its `isLoading` /
   * `isError` / `refetch` straight through. All optional + default to a
   * resolved/no-error state so existing callers that only pass `reviews` keep
   * working: without these, the list still renders exactly as before.
   */
  isLoading?: boolean;
  isError?: boolean;
  onRetry?: () => void;
}

export function ReviewsSection({
  reviews,
  averageRating,
  reviewCount,
  canReview,
  hasReviewed,
  submitting,
  onSubmit,
  isLoading,
  isError,
  onRetry,
}: ReviewsSectionProps) {
  const [rating, setRating] = React.useState(0);
  const [hoverRating, setHoverRating] = React.useState(0);
  const [comment, setComment] = React.useState("");

  const handleSubmit = () => {
    const text = comment.trim();
    if (rating === 0 || !text || submitting) return;
    onSubmit(rating, text);
    // Reset eagerly; the parent flips `hasReviewed` once the write lands, which
    // hides the form anyway. Errors are surfaced by the parent (toast).
    setRating(0);
    setComment("");
  };

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="section-label flex items-center gap-1.5" style={{ margin: 0 }}>
          <Star className="h-3.5 w-3.5" /> Reviews
        </h2>
        {reviewCount > 0 && (
          <div className="flex items-center gap-1.5">
            <div className="flex">
              {[1, 2, 3, 4, 5].map((s) => (
                <Star
                  key={s}
                  className={cn(
                    "h-3.5 w-3.5",
                    s <= Math.round(averageRating)
                      ? "fill-amber-400 text-amber-400"
                      : "text-muted-foreground",
                  )}
                />
              ))}
            </div>
            <span className="text-xs font-medium">{averageRating.toFixed(1)}</span>
            <span className="text-xs text-muted-foreground">({reviewCount})</span>
          </div>
        )}
      </div>

      {/* Review form — only for POAP holders who haven't reviewed yet. */}
      {canReview && !hasReviewed && (
        <div className="rounded-xl border border-border/60 bg-muted/20 p-3">
          <p className="mb-2 text-xs font-medium">Share your experience</p>
          <div className="mb-2 flex items-center gap-1">
            {[1, 2, 3, 4, 5].map((s) => (
              <button
                key={s}
                type="button"
                disabled={submitting}
                onClick={() => setRating(s)}
                onMouseEnter={() => setHoverRating(s)}
                onMouseLeave={() => setHoverRating(0)}
                aria-label={`${s} star${s > 1 ? "s" : ""}`}
                className="rounded p-0.5 transition-transform hover:scale-110 active:scale-[0.95] disabled:cursor-not-allowed"
              >
                <Star
                  className={cn(
                    "h-5 w-5 transition-colors",
                    s <= (hoverRating || rating)
                      ? "fill-amber-400 text-amber-400"
                      : "text-muted-foreground",
                  )}
                />
              </button>
            ))}
            <span className="ml-2 text-xs text-muted-foreground">
              {rating > 0 && `${rating} star${rating > 1 ? "s" : ""}`}
            </span>
          </div>
          <Textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="How was the event?"
            maxLength={MAX_COMMENT_LEN}
            disabled={submitting}
            className="mb-2 min-h-[60px] resize-none rounded-lg text-sm"
          />
          <div className="flex items-center justify-between gap-2">
            <p className="text-[10px] text-muted-foreground tabular-nums">
              {comment.length}/{MAX_COMMENT_LEN} · only event POAP holders can review
            </p>
            <Button
              size="sm"
              onClick={handleSubmit}
              disabled={rating === 0 || !comment.trim() || submitting}
              className="gap-1.5 rounded-lg"
            >
              {submitting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Send className="h-3.5 w-3.5" />
              )}
              Post review
            </Button>
          </div>
        </div>
      )}

      {/* Gate state: cannot review (not connected / no POAP). */}
      {!canReview && !hasReviewed && (
        <div className="rounded-xl border border-dashed border-border/60 bg-muted/10 p-3 text-center">
          <p className="text-xs text-muted-foreground">
            Connect your wallet and hold a POAP for this event to leave a review.
          </p>
        </div>
      )}

      {/* Gate state: already reviewed. */}
      {hasReviewed && (
        <div className="rounded-xl border border-emerald-400/30 bg-emerald-400/10 p-3 text-center">
          <p className="text-xs text-emerald-400">
            You&apos;ve reviewed this event. Thanks for sharing!
          </p>
        </div>
      )}

      {/* Review list. Loading + error are checked BEFORE the empty state so a
          pending or failed fetch never masquerades as "No reviews yet". Both
          guards are gated on optional props, so callers that don't thread the
          query state fall straight through to the data branches as before. */}
      {isLoading && reviews.length === 0 ? (
        <div className="space-y-3" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="flex items-start gap-2 rounded-xl border border-border/60 bg-card/40 p-3"
            >
              <Skeleton className="h-8 w-8 shrink-0 rounded-full" />
              <div className="min-w-0 flex-1 space-y-1.5">
                <Skeleton className="h-3 w-24" />
                <Skeleton className="h-2.5 w-16" />
                <Skeleton className="h-3 w-full" />
              </div>
            </div>
          ))}
        </div>
      ) : isError && reviews.length === 0 ? (
        <ErrorState
          title="Couldn't load reviews"
          body="Something went wrong reading reviews from chain. This is usually transient."
          onRetry={onRetry}
        />
      ) : reviews.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 py-6 text-center">
          <Star className="h-5 w-5 text-muted-foreground" />
          <p className="text-xs text-muted-foreground">
            No reviews yet. Be the first to share!
          </p>
        </div>
      ) : (
        <ScrollArea className="max-h-64">
          <div className="space-y-3 pr-2">
            <AnimatePresence mode="popLayout" initial={false}>
              {reviews.map((r, i) => (
                <motion.div
                  key={r.id}
                  layout
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  transition={{ duration: 0.25, delay: Math.min(i * 0.04, 0.2) }}
                  className="rounded-xl border border-border/60 bg-card/40 p-3"
                >
                  <div className="flex items-start gap-2">
                    <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-gradient-to-br from-violet-500/40 to-fuchsia-500/40 text-[10px] font-bold">
                      {r.author.replace(/^0x/, "").slice(0, 2).toUpperCase()}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <AddressDisplay address={r.author} suffix={4} />
                      </div>
                      <div className="mt-0.5 flex items-center gap-0.5">
                        {[1, 2, 3, 4, 5].map((s) => (
                          <Star
                            key={s}
                            className={cn(
                              "h-2.5 w-2.5",
                              s <= r.rating
                                ? "fill-amber-400 text-amber-400"
                                : "text-muted-foreground",
                            )}
                          />
                        ))}
                        <span className="ml-1 text-[10px] text-muted-foreground">
                          {formatAgo(r.createdAt)}
                        </span>
                      </div>
                      <p className="mt-1.5 text-xs leading-relaxed text-foreground/90 break-words">
                        {r.comment}
                      </p>
                    </div>
                  </div>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        </ScrollArea>
      )}
    </section>
  );
}

function formatAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  return `${weeks}w ago`;
}

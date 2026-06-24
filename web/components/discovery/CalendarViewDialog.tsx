"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "motion/react";
import { Icon } from "@/components/Icon";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { CATEGORIES, catPalette } from "@/lib/data";
import {
  getEventStatus,
  ticketsLeft,
  formatTimeMs,
  type DiscoverEvent,
} from "@/lib/discovery";
import { coinInfo, fmtAmount } from "@/lib/config";

export interface CalendarViewDialogProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  events: DiscoverEvent[];
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

interface CalendarDay {
  date: Date;
  inMonth: boolean;
  events: DiscoverEvent[];
}

function priceLabel(e: DiscoverEvent): string {
  if (e.isFree) return "Free";
  if (e.priceUnits === undefined || e.coinType === undefined) return "";
  const ci = coinInfo(e.coinType);
  return `${fmtAmount(e.priceUnits, ci.decimals)} ${ci.symbol}`;
}

function getEventsOnDate(events: DiscoverEvent[], date: Date): DiscoverEvent[] {
  const target = date.toDateString();
  return events.filter((e) => new Date(e.startMs).toDateString() === target);
}

/** Category dot color (start of the category gradient palette). */
function catDot(category?: string): string {
  return catPalette(category)[0];
}

export function CalendarViewDialog({ open, onOpenChange, events }: CalendarViewDialogProps) {
  const router = useRouter();
  const today = useMemo(() => {
    const t = new Date();
    t.setHours(0, 0, 0, 0);
    return t;
  }, []);
  const [viewYear, setViewYear] = useState(today.getFullYear());
  const [viewMonth, setViewMonth] = useState(today.getMonth());
  const [selectedDay, setSelectedDay] = useState<Date | null>(null);

  // Opening the calendar lands on today: select it so the side panel shows
  // today's events straight away (the grid already defaults to today's month).
  useEffect(() => {
    if (open) setSelectedDay(today);
  }, [open, today]);

  const days = useMemo<CalendarDay[]>(() => {
    const firstOfMonth = new Date(viewYear, viewMonth, 1);
    const startDay = firstOfMonth.getDay();
    const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
    const grid: CalendarDay[] = [];
    for (let i = startDay - 1; i >= 0; i--) {
      const d = new Date(viewYear, viewMonth, -i);
      grid.push({ date: d, inMonth: false, events: getEventsOnDate(events, d) });
    }
    for (let d = 1; d <= daysInMonth; d++) {
      const date = new Date(viewYear, viewMonth, d);
      grid.push({ date, inMonth: true, events: getEventsOnDate(events, date) });
    }
    while (grid.length < 42) {
      const lastDate = grid[grid.length - 1].date;
      const d = new Date(lastDate);
      d.setDate(d.getDate() + 1);
      grid.push({ date: d, inMonth: false, events: getEventsOnDate(events, d) });
    }
    return grid;
  }, [events, viewYear, viewMonth]);

  const prevMonth = () => {
    if (viewMonth === 0) {
      setViewMonth(11);
      setViewYear((y) => y - 1);
    } else setViewMonth((m) => m - 1);
  };
  const nextMonth = () => {
    if (viewMonth === 11) {
      setViewMonth(0);
      setViewYear((y) => y + 1);
    } else setViewMonth((m) => m + 1);
  };
  const goToday = () => {
    setViewYear(today.getFullYear());
    setViewMonth(today.getMonth());
    setSelectedDay(today);
  };

  const monthEvents = days.filter((d) => d.inMonth).flatMap((d) => d.events);
  const selectedDayEvents = selectedDay ? getEventsOnDate(events, selectedDay) : [];

  const open_ = (id: string) => {
    onOpenChange(false);
    router.push(`/event/${id}`);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[92vh] flex-col gap-0 overflow-hidden rounded-2xl p-0 sm:max-w-3xl">
        <DialogTitle className="sr-only">Calendar view</DialogTitle>
        <DialogDescription className="sr-only">
          Browse events in a month grid. Click a day to see events.
        </DialogDescription>

        {/* pr-14 reserves room for the Dialog's absolute close button (top-2
            right-2) so it doesn't overlap the Today / prev / next controls. */}
        <div className="flex shrink-0 items-center justify-between border-b bg-muted/20 py-4 pl-4 pr-14">
          <div className="flex items-center gap-2">
            <div className="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-sky-500/30 to-violet-500/30">
              <Icon icon="proicons:calendar" size={16} />
            </div>
            <div>
              <p className="text-sm font-semibold leading-tight">
                {MONTHS[viewMonth]} {viewYear}
              </p>
              <p className="text-[11px] text-muted-foreground">
                {monthEvents.length} event{monthEvents.length === 1 ? "" : "s"} this month
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm" onClick={goToday} className="mr-1 rounded-lg text-xs">
              Today
            </Button>
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8 min-h-11 min-w-11 sm:min-h-0 sm:min-w-0 rounded-lg"
              onClick={prevMonth}
              aria-label="Previous month"
            >
              <Icon icon="ic:round-chevron-left" size={16} />
            </Button>
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8 min-h-11 min-w-11 sm:min-h-0 sm:min-w-0 rounded-lg"
              onClick={nextMonth}
              aria-label="Next month"
            >
              <Icon icon="ic:round-chevron-right" size={16} />
            </Button>
          </div>
        </div>

        {/* Body: one scroll container on mobile (grid stacks); on lg it becomes a
            fixed 2-col grid where only the events panel scrolls. min-h-0 + grow let
            it shrink and scroll instead of stretching the dialog past max-h. */}
        <div className="grid min-h-0 grow gap-0 overflow-y-auto lg:grid-cols-[1fr_280px] lg:overflow-hidden">
          <div className="p-3">
            <div className="grid grid-cols-7 gap-1 pb-1">
              {WEEKDAYS.map((d) => (
                <div
                  key={d}
                  className="py-1 text-center text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
                >
                  {d}
                </div>
              ))}
            </div>
            <div className="grid grid-cols-7 gap-1">
              {days.map((day, i) => {
                const isToday = day.date.getTime() === today.getTime();
                const isSelected =
                  selectedDay && day.date.toDateString() === selectedDay.toDateString();
                const hasEvents = day.events.length > 0;
                return (
                  <button
                    key={i}
                    type="button"
                    onClick={() => setSelectedDay(day.date)}
                    aria-label={`${day.date.toLocaleDateString("en-US", { month: "long", day: "numeric" })}${hasEvents ? `, ${day.events.length} event${day.events.length === 1 ? "" : "s"}` : ""}`}
                    className={cn(
                      "relative flex min-h-[56px] flex-col items-start rounded-lg border p-1 text-left transition-[color,transform] active:scale-[0.97] sm:min-h-[64px]",
                      day.inMonth ? "border-border/40 bg-card/40" : "border-transparent bg-transparent opacity-40",
                      isSelected
                        ? "border-primary ring-1 ring-primary"
                        : hasEvents
                          ? "hover:border-border hover:bg-accent/30"
                          : "hover:bg-accent/20",
                    )}
                  >
                    <span
                      className={cn(
                        "grid h-5 w-5 place-items-center rounded-full text-[10px] font-medium",
                        isToday
                          ? "bg-primary text-primary-foreground"
                          : day.inMonth
                            ? "text-foreground"
                            : "text-muted-foreground",
                      )}
                    >
                      {day.date.getDate()}
                    </span>
                    {hasEvents && (
                      <div className="mt-auto flex w-full flex-wrap gap-0.5">
                        {day.events.slice(0, 3).map((e) => (
                          <span
                            key={e.eventId}
                            className="h-1.5 min-w-[4px] flex-1 rounded-full"
                            style={{ backgroundColor: catDot(e.category) }}
                            title={`${e.name}${e.category ? ` (${e.category})` : ""}`}
                          />
                        ))}
                        {day.events.length > 3 && (
                          <span className="text-[8px] font-medium text-muted-foreground">
                            +{day.events.length - 3}
                          </span>
                        )}
                      </div>
                    )}
                    {hasEvents && day.inMonth && (
                      <span className="absolute right-0.5 top-0.5 text-[8px] font-bold text-muted-foreground">
                        {day.events.length}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/40 pt-3">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Categories:
              </span>
              {CATEGORIES.filter((c) => c.id !== "all").map((c) => (
                <span key={c.id} className="flex items-center gap-1 text-[10px] text-muted-foreground">
                  <span
                    className="h-2 w-2 rounded-full"
                    style={{ backgroundColor: catDot(c.id) }}
                  />
                  {c.label}
                </span>
              ))}
            </div>
          </div>

          <div className="relative border-t bg-muted/20 lg:border-l lg:border-t-0">
            {/* lg:absolute fills the grid cell (= calendar height) without letting
                a long event list stretch the row; the inner list scrolls instead. */}
            <div className="flex flex-col lg:absolute lg:inset-0">
              <div className="shrink-0 border-b border-border/40 p-3">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                {selectedDay
                  ? selectedDay.toLocaleDateString("en-US", {
                      weekday: "long",
                      month: "long",
                      day: "numeric",
                    })
                  : "Select a day"}
              </p>
              <p className="text-sm font-medium">
                {selectedDay
                  ? `${selectedDayEvents.length} event${selectedDayEvents.length === 1 ? "" : "s"}`
                  : "Click a day to see events"}
              </p>
            </div>
              <div className="p-2 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
                {selectedDayEvents.length === 0 ? (
                  <div className="flex flex-col items-center justify-center gap-2 py-8 text-center">
                    <Icon icon="proicons:calendar" size={24} className="text-muted-foreground" />
                    <p className="text-xs text-muted-foreground">No events on this day.</p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <AnimatePresence mode="popLayout">
                      {selectedDayEvents.map((e, i) => {
                        const status = getEventStatus(e);
                        const left = ticketsLeft(e);
                        return (
                          <motion.button
                            key={e.eventId}
                            type="button"
                            layout
                            initial={{ opacity: 0, y: 8 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: -8 }}
                            transition={{ duration: 0.25, delay: Math.min(i * 0.04, 0.2) }}
                            whileHover={{ x: 2 }}
                            onClick={() => open_(e.eventId)}
                            aria-label={`Open ${e.name}`}
                            className="flex w-full items-start gap-2 rounded-lg border bg-card/40 p-2 text-left transition-colors hover:border-foreground/30 hover:bg-accent/30"
                          >
                            <span
                              className="mt-0.5 h-9 w-1.5 shrink-0 rounded-full"
                              style={{ backgroundColor: catDot(e.category) }}
                            />
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-xs font-medium leading-tight">{e.name}</p>
                              <p className="flex items-center gap-1 text-[10px] text-muted-foreground">
                                <span className="mono">{formatTimeMs(e.startMs)}</span>
                                {e.city && (
                                  <>
                                    <span>·</span>
                                    <Icon icon="carbon:location" size={11} />
                                    <span className="truncate">{e.city}</span>
                                  </>
                                )}
                              </p>
                              <div className="mt-0.5 flex items-center gap-1.5">
                                {e.category && (
                                  <Badge variant="outline" className="h-4 px-1 text-[9px] font-normal">
                                    {e.category}
                                  </Badge>
                                )}
                                {status === "live" && (
                                  <span className="flex items-center gap-0.5 text-[9px] text-rose-400">
                                    <span className="h-1 w-1 animate-pulse rounded-full bg-rose-400" />
                                    Live
                                  </span>
                                )}
                                <span className="text-[9px] text-muted-foreground">
                                  {String(left)} left
                                </span>
                              </div>
                            </div>
                            <span className="shrink-0 text-[10px] font-semibold">{priceLabel(e)}</span>
                          </motion.button>
                        );
                      })}
                    </AnimatePresence>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

"use client";

import { format } from "date-fns";
import { ChevronDownIcon } from "lucide-react";

import { Calendar } from "@/components/ui/calendar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import * as React from "react";

const pad = (n: number) => String(n).padStart(2, "0");

/** Date → the "YYYY-MM-DDTHH:mm" local string the create flow stores (same shape
 *  the native datetime-local input produced, so downstream Date.parse is unchanged). */
function toLocalString(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

function combine(day: Date, time: string): string {
  const [h, m] = time.split(":").map(Number);
  const d = new Date(day);
  d.setHours(Number.isFinite(h) ? h : 0, Number.isFinite(m) ? m : 0, 0, 0);
  return toLocalString(d);
}

/**
 * shadcn "Time Picker": a Date dropdown (Calendar in a Popover) next to a Time
 * input. Value/onChange use the "YYYY-MM-DDTHH:mm" local string — a drop-in for
 * datetime-local (and for this component's previous calendar+time-input form).
 */
export function DateTimePicker({
  id,
  value,
  onChange,
  min,
  placeholder = "Select date",
}: {
  id?: string;
  value: string;
  onChange: (v: string) => void;
  /** Earliest selectable instant, as a "YYYY-MM-DDTHH:mm" string. */
  min?: string;
  placeholder?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const date = value ? new Date(value) : undefined;
  const valid = date && !Number.isNaN(date.getTime());
  const time = valid ? `${pad(date!.getHours())}:${pad(date!.getMinutes())}` : "";

  const minDate = min ? new Date(min) : undefined;
  const minValid = minDate && !Number.isNaN(minDate.getTime());

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            id={id}
            variant="outline"
            className="w-36 justify-between font-normal data-[empty=true]:text-muted-foreground"
            data-empty={!valid}
          >
            {valid ? format(date!, "PP") : placeholder}
            <ChevronDownIcon className="size-4 opacity-60" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto overflow-hidden p-0" align="start">
          <Calendar
            mode="single"
            selected={valid ? date : undefined}
            defaultMonth={valid ? date : minValid ? minDate : undefined}
            disabled={minValid ? { before: minDate! } : undefined}
            captionLayout="dropdown"
            onSelect={(day) => {
              if (!day) return;
              onChange(combine(day, time || "12:00"));
              setOpen(false);
            }}
            autoFocus
          />
        </PopoverContent>
      </Popover>
      <Input
        id={id ? `${id}-time` : undefined}
        type="time"
        value={time}
        onChange={(e) => onChange(combine(valid ? date! : new Date(), e.target.value))}
        aria-label="Time"
        className="w-[7.5rem] appearance-none [&::-webkit-calendar-picker-indicator]:hidden"
      />
    </div>
  );
}

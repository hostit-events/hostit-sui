"use client";

import { Calendar } from "@/components/ui/calendar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Icon } from "@/components/Icon";

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
 * shadcn Calendar + time input for a single local datetime. Value/onChange use
 * the "YYYY-MM-DDTHH:mm" string (local zone) — a drop-in for datetime-local.
 */
export function DateTimePicker({
  id,
  value,
  onChange,
  min,
  placeholder = "Pick date & time",
}: {
  id?: string;
  value: string;
  onChange: (v: string) => void;
  /** Earliest selectable instant, as a "YYYY-MM-DDTHH:mm" string. */
  min?: string;
  placeholder?: string;
}) {
  const date = value ? new Date(value) : undefined;
  const valid = date && !Number.isNaN(date.getTime());
  const time = valid ? `${pad(date!.getHours())}:${pad(date!.getMinutes())}` : "";

  const minDate = min ? new Date(min) : undefined;
  const minValid = minDate && !Number.isNaN(minDate.getTime());

  const label = valid
    ? date!.toLocaleString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : placeholder;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          id={id}
          variant="outline"
          className="w-full justify-start gap-2 font-normal data-[empty=true]:text-muted-foreground"
          data-empty={!valid}
        >
          <Icon icon="proicons:calendar" size={16} />
          {label}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="single"
          selected={valid ? date : undefined}
          defaultMonth={valid ? date : minValid ? minDate : undefined}
          disabled={minValid ? { before: minDate! } : undefined}
          onSelect={(day) => day && onChange(combine(day, time || "12:00"))}
          autoFocus
        />
        <div className="space-y-1.5 border-t p-3">
          <Label htmlFor={id ? `${id}-time` : undefined}>Time</Label>
          <Input
            id={id ? `${id}-time` : undefined}
            type="time"
            value={time}
            onChange={(e) => onChange(combine(valid ? date! : new Date(), e.target.value))}
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}

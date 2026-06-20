"use client";

import { Fragment } from "react";
import { Icon } from "@/components/Icon";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { SHORTCUTS } from "@/lib/useKeyboardShortcuts";

export interface ShortcutsHelpDialogProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

export function ShortcutsHelpDialog({ open, onOpenChange }: ShortcutsHelpDialogProps) {
  const nav = SHORTCUTS.filter((s) => s.group === "navigation");
  const actions = SHORTCUTS.filter((s) => s.group === "actions");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md overflow-hidden rounded-2xl p-0">
        <DialogTitle className="sr-only">Keyboard shortcuts</DialogTitle>
        <DialogDescription className="sr-only">
          List of keyboard shortcuts available on HostIt
        </DialogDescription>
        <div className="border-b bg-muted/20 p-4">
          <div className="flex items-center gap-2">
            <div className="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-violet-500/30 to-sky-500/30">
              <Icon icon="ic:round-keyboard" size={16} />
            </div>
            <div>
              <p className="text-sm font-semibold">Keyboard shortcuts</p>
              <p className="text-[11px] text-muted-foreground">Speed up your flow.</p>
            </div>
          </div>
        </div>
        <div className="space-y-5 p-4">
          <Section title="Navigation" items={nav} />
          <Section title="Actions" items={actions} />
          <p className="text-[11px] text-muted-foreground">
            Shortcuts are disabled while typing in inputs.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Section({ title, items }: { title: string; items: typeof SHORTCUTS }) {
  return (
    <section>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </h3>
      <ul className="space-y-1.5">
        {items.map((s) => (
          <li key={s.key} className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">{s.description}</span>
            <KeyCap text={s.key} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function KeyCap({ text }: { text: string }) {
  const parts = text.split(" ");
  return (
    <span className="flex items-center gap-1">
      {parts.map((p, i) => (
        <Fragment key={i}>
          {i > 0 && <span className="text-[10px] text-muted-foreground">then</span>}
          <kbd className="inline-grid h-6 min-w-6 place-items-center rounded-md border bg-muted px-1.5 font-mono text-[11px] font-medium shadow-sm">
            {p}
          </kbd>
        </Fragment>
      ))}
    </span>
  );
}

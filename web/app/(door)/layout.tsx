export default function DoorLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-1 flex-col bg-background text-foreground">{children}</div>
  );
}

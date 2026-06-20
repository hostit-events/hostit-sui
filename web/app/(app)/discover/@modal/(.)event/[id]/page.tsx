"use client";
import { useParams } from "next/navigation";
import { EventQuickViewModal } from "@/components/EventQuickViewModal";

// Intercepting route: `(.)event/[id]` catches a <Link href="/event/[id]">
// navigation that ORIGINATES from the /discover segment and renders the event
// as a Dialog quick-view over /discover (Back/Esc/overlay close → router.back()
// returns to /discover). A direct visit / refresh / shared link to /event/[id]
// is NOT intercepted and renders the full EventPageScreen via
// app/(app)/event/[id]/page.tsx — same URL, two presentations.
export default function InterceptedEventPage() {
  const { id } = useParams<{ id: string }>();
  return <EventQuickViewModal id={id} />;
}

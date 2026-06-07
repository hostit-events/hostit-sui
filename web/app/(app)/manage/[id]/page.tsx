"use client";
import { useParams } from "next/navigation";
import { EventManageScreen } from "@/components/screens/EventManageScreen";
export default function Page() {
  const { id } = useParams<{ id: string }>();
  return <EventManageScreen id={id} />;
}

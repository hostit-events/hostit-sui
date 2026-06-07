"use client";
import { useParams } from "next/navigation";
import { EventPageScreen } from "@/components/screens/EventPageScreen";
export default function Page() {
  const { id } = useParams<{ id: string }>();
  return <EventPageScreen id={id} />;
}

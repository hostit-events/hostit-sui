"use client";
import { useParams } from "next/navigation";
import { DoorScreen } from "@/components/screens/DoorScreen";
export default function Page() {
  const { id } = useParams<{ id: string }>();
  return <DoorScreen id={id} />;
}

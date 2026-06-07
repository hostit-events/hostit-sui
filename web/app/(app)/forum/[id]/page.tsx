"use client";
import { useParams } from "next/navigation";
import { ForumScreen } from "@/components/screens/ForumScreen";
export default function Page() {
  const { id } = useParams<{ id: string }>();
  return <ForumScreen id={id} />;
}

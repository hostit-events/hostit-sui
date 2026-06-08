import { DoorScreen } from "@/components/screens/DoorScreen";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <DoorScreen id={id} />;
}

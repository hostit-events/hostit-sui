"use client";

// Account avatar with a never-blank fallback chain (GH#96): uploaded profile
// avatar (public Walrus blob) → deterministic seeded swatch keyed on the address.
// (suiNS avatar records are a v2 nicety.)

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { useProfilePicture } from "@/lib/profile";
import { hashHue } from "@/lib/data";

export function UserAvatar({
  address,
  size = "default",
  className,
}: {
  address: string;
  size?: "default" | "sm" | "lg";
  className?: string;
}) {
  const { url } = useProfilePicture(address);
  const hue = hashHue(address || "0x0");
  const label = (address || "").replace(/^0x/, "").slice(0, 2).toUpperCase() || "··";
  return (
    <Avatar size={size} className={className}>
      {url && <AvatarImage src={url} alt="" />}
      <AvatarFallback style={{ background: `hsl(${hue} 55% 38%)`, color: "#fff" }}>
        {label}
      </AvatarFallback>
    </Avatar>
  );
}

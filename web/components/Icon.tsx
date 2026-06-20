import React from "react";
import {
  ArrowDownLeft, ArrowLeftRight, Bookmark, Box, Calendar, CircleAlert, CloudCheck, Coins, Cpu, Database, DollarSign, DoorClosed, DoorOpen, Globe, Hourglass, Image, Inbox, Info, LineChart, ListChecks, LoaderCircle, Medal, MessagesSquare, Monitor, Music, QrCode, Rocket, Save, Shield, Tag, Ticket, TriangleAlert, Trophy, Undo2, Wallet, Wine,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { ArrowLeft } from "@/components/animate-ui/icons/arrow-left";
import { ArrowRight } from "@/components/animate-ui/icons/arrow-right";
import { BadgeCheck } from "@/components/animate-ui/icons/badge-check";
import { ChartColumn } from "@/components/animate-ui/icons/chart-column";
import { Check } from "@/components/animate-ui/icons/check";
import { CircleCheck } from "@/components/animate-ui/icons/circle-check";
import { Clock } from "@/components/animate-ui/icons/clock";
import { Compass } from "@/components/animate-ui/icons/compass";
import { Copy } from "@/components/animate-ui/icons/copy";
import { Download } from "@/components/animate-ui/icons/download";
import { Fingerprint } from "@/components/animate-ui/icons/fingerprint";
import { Gavel } from "@/components/animate-ui/icons/gavel";
import { Lock } from "@/components/animate-ui/icons/lock";
import { LockOpen } from "@/components/animate-ui/icons/lock-open";
import { LogOut } from "@/components/animate-ui/icons/log-out";
import { MapPin } from "@/components/animate-ui/icons/map-pin";
import { Paintbrush } from "@/components/animate-ui/icons/paintbrush";
import { Plus } from "@/components/animate-ui/icons/plus";
import { RefreshCw } from "@/components/animate-ui/icons/refresh-cw";
import { RotateCw } from "@/components/animate-ui/icons/rotate-cw";
import { Search } from "@/components/animate-ui/icons/search";
import { Send } from "@/components/animate-ui/icons/send";
import { Settings } from "@/components/animate-ui/icons/settings";
import { Sparkle } from "@/components/animate-ui/icons/sparkle";
import { Sparkles } from "@/components/animate-ui/icons/sparkles";
import { Star } from "@/components/animate-ui/icons/star";
import { Trash2 } from "@/components/animate-ui/icons/trash-2";
import { User } from "@/components/animate-ui/icons/user";
import { Users } from "@/components/animate-ui/icons/users";
import { X } from "@/components/animate-ui/icons/x";

/**
 * Icon — the in-app icon set. Each name resolves to its animate-ui (motion)
 * equivalent where one exists (animated on hover); names animate-ui doesn't ship
 * (e.g. ticket, medal) fall back to the static lucide icon, and anything unmapped
 * (brand logos like `logos:google-icon`, the landing's decorative set) falls back
 * to the Iconify web component. API + call sites are unchanged.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnimateUiIcon = React.ComponentType<any>;

// Names with an animate-ui equivalent (animate on hover).
const ANIMATE_MAP: Record<string, AnimateUiIcon> = {
  "ph:calendar-star-fill": Star,
  "ph:sparkle-fill": Sparkle,
  "solar:magic-stick-3-bold": Sparkles,
  "ph:seal-check-fill": BadgeCheck,
  "streamline:star-badge-solid": BadgeCheck,
  "mdi:chart-bar": ChartColumn,
  "material-symbols-light:analytics-rounded": ChartColumn,
  "solar:user-rounded-bold": User,
  "solar:users-group-rounded-bold": Users,
  "ph:paint-brush-fill": Paintbrush,
  "ph:users-three-fill": Users,
  "ic:round-search": Search,
  "ic:round-refresh": RefreshCw,
  "ph:arrow-clockwise-bold": RotateCw,
  "ic:round-settings": Settings,
  "material-symbols-light:settings-rounded": Settings,
  "ic:round-lock": Lock,
  "material-symbols:lock-outline": Lock,
  "ph:lock-key-fill": Lock,
  "ic:round-lock-open": LockOpen,
  "ph:lock-key-open-fill": LockOpen,
  "ic:round-explore": Compass,
  "ic:round-arrow-forward": ArrowRight,
  "ph:arrow-right-bold": ArrowRight,
  "ic:round-arrow-back": ArrowLeft,
  "ph:arrow-left-bold": ArrowLeft,
  "ic:round-add": Plus,
  "ph:plus-bold": Plus,
  "ic:round-close": X,
  "ph:x-bold": X,
  "ic:round-send": Send,
  "ph:paper-plane-right-fill": Send,
  "ph:trash-fill": Trash2,
  "ic:round-delete-outline": Trash2,
  "ic:round-logout": LogOut,
  "solar:copy-linear": Copy,
  "ic:round-content-copy": Copy,
  "ic:round-fingerprint": Fingerprint,
  "ph:check-bold": Check,
  "ic:round-check": Check,
  "ph:check-circle-fill": CircleCheck,
  "solar:download-minimalistic-bold": Download,
  "ic:round-place": MapPin,
  "carbon:location": MapPin,
  "ph:gavel-bold": Gavel,
  "mdi:clock-outline": Clock,
};

// Names animate-ui doesn't ship (+ the spinner) — static lucide.
const LUCIDE_MAP: Record<string, LucideIcon> = {
  "ion:ticket": Ticket,
  "zondicons:inbox-check": Inbox,
  "ph:coins-bold": Coins,
  "proicons:calendar": Calendar,
  "ph:medal-fill": Medal,
  "mdi:chart-line": LineChart,
  "mdi:rocket-launch": Rocket,
  "ph:cube-transparent-fill": Box,
  "ion:musical-notes": Music,
  "ph:cpu-bold": Cpu,
  "ph:trophy-fill": Trophy,
  "ph:wine-fill": Wine,
  "ic:round-forum": MessagesSquare,
  "ion:chatbubbles": MessagesSquare,
  "ph:arrows-left-right-bold": ArrowLeftRight,
  "ph:arrow-down-left-bold": ArrowDownLeft,
  "ph:arrow-u-up-left-bold": Undo2,
  "mdi:cash-refund": Undo2,
  "ic:round-save": Save,
  "ph:tag-fill": Tag,
  "ic:round-tag": Tag,
  "ph:image-fill": Image,
  "ph:globe-simple-fill": Globe,
  "ph:database-fill": Database,
  "ic:round-qr-code-scanner": QrCode,
  "ic:round-monitor": Monitor,
  "solar:bookmark-bold": Bookmark,
  "ic:round-shield": Shield,
  "solar:safe-2-bold": Shield,
  "ph:list-checks-bold": ListChecks,
  "ph:cloud-check-fill": CloudCheck,
  "ic:round-meeting-room": DoorOpen,
  "mdi:door-open": DoorOpen,
  "material-symbols:door-front-outline": DoorClosed,
  "ic:round-account-balance-wallet": Wallet,
  "solar:wallet-bold": Wallet,
  "solar:wallet-money-bold": Wallet,
  "solar:dollar-minimalistic-bold": DollarSign,
  "ph:info-bold": Info,
  "ic:round-info": Info,
  "ph:warning-fill": TriangleAlert,
  "ph:warning-bold": TriangleAlert,
  "ph:warning-circle-fill": CircleAlert,
  "ic:round-error-outline": CircleAlert,
  "mdi:timer-sand": Hourglass,
  "svg-spinners:3-dots-fade": LoaderCircle,
};

// Names that should keep spinning (animated in the original Iconify set).
const SPINNERS = new Set(["svg-spinners:3-dots-fade"]);

export function Icon({
  icon,
  size = 18,
  className,
  style,
}: {
  icon: string;
  size?: number;
  className?: string;
  style?: React.CSSProperties;
}) {
  const inlineStyle: React.CSSProperties = {
    display: "inline-block",
    verticalAlign: "-0.125em",
    ...style,
  };

  const Animated = ANIMATE_MAP[icon];
  if (Animated) {
    return <Animated size={size} animateOnHover className={className} style={inlineStyle} />;
  }

  const Lucide = LUCIDE_MAP[icon];
  if (Lucide) {
    return (
      <Lucide
        size={size}
        className={cn(SPINNERS.has(icon) && "animate-spin", className)}
        style={inlineStyle}
      />
    );
  }

  // Fallback: brand logos + the landing's decorative set → Iconify web component.
  return React.createElement("iconify-icon", {
    icon,
    width: size,
    height: size,
    className,
    style: { display: "inline-flex", lineHeight: 0, verticalAlign: "-0.125em", ...style },
  });
}

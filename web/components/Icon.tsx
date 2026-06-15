import React from "react";
import {
  Ticket, Inbox, Coins, Calendar, Star, Sparkle, Sparkles, BadgeCheck, Medal,
  ChartColumn, LineChart, Rocket, Search, MapPin, Hourglass, Clock, RefreshCw,
  RotateCw, Wallet, User, Users, TriangleAlert, CircleAlert, Info, Settings, Lock,
  LockOpen, MessagesSquare, Compass, ArrowRight, ArrowLeft, ArrowLeftRight,
  ArrowDownLeft, Undo2, Plus, X, Send, Save, Trash2, Tag, Image, Globe, Database,
  Box, CloudCheck, CircleCheck, Check, DoorOpen, DoorClosed, Shield, Fingerprint,
  LogOut, QrCode, Monitor, Copy, Bookmark, Gavel, DollarSign, Download, Music, Cpu,
  Trophy, Paintbrush, Wine, ListChecks, LoaderCircle,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Icon — renders shadcn's icon set (lucide-react) for the in-app UI, mapping the
 * project's historical Iconify names to their lucide equivalent. Names not in
 * the map (brand logos like `logos:google-icon`, plus the landing page's
 * decorative set) fall back to the Iconify web component (loader in layout.tsx),
 * so the API and call sites are unchanged and nothing else has to move.
 */
const MAP: Record<string, LucideIcon> = {
  // domain
  "ion:ticket": Ticket,
  "zondicons:inbox-check": Inbox,
  "ph:coins-bold": Coins,
  "proicons:calendar": Calendar,
  "ph:calendar-star-fill": Star,
  "ph:sparkle-fill": Sparkle,
  "solar:magic-stick-3-bold": Sparkles,
  "ph:seal-check-fill": BadgeCheck,
  "streamline:star-badge-solid": BadgeCheck,
  "ph:medal-fill": Medal,
  "mdi:chart-bar": ChartColumn,
  "material-symbols-light:analytics-rounded": ChartColumn,
  "mdi:chart-line": LineChart,
  "mdi:rocket-launch": Rocket,
  "solar:user-rounded-bold": User,
  "solar:users-group-rounded-bold": Users,
  "ph:cube-transparent-fill": Box,
  // categories / glyphs (lib/data.ts)
  "ion:musical-notes": Music,
  "ph:cpu-bold": Cpu,
  "ph:trophy-fill": Trophy,
  "ph:paint-brush-fill": Paintbrush,
  "ph:wine-fill": Wine,
  "ph:users-three-fill": Users,
  // navigation / actions
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
  "ic:round-forum": MessagesSquare,
  "ion:chatbubbles": MessagesSquare,
  "ic:round-explore": Compass,
  "ic:round-arrow-forward": ArrowRight,
  "ph:arrow-right-bold": ArrowRight,
  "ic:round-arrow-back": ArrowLeft,
  "ph:arrow-left-bold": ArrowLeft,
  "ph:arrows-left-right-bold": ArrowLeftRight,
  "ph:arrow-down-left-bold": ArrowDownLeft,
  "ph:arrow-u-up-left-bold": Undo2,
  "mdi:cash-refund": Undo2,
  "ic:round-add": Plus,
  "ph:plus-bold": Plus,
  "ic:round-close": X,
  "ph:x-bold": X,
  "ic:round-send": Send,
  "ph:paper-plane-right-fill": Send,
  "ic:round-save": Save,
  "ph:trash-fill": Trash2,
  "ic:round-delete-outline": Trash2,
  "ph:tag-fill": Tag,
  "ic:round-tag": Tag,
  "ph:image-fill": Image,
  "ph:globe-simple-fill": Globe,
  "ph:database-fill": Database,
  "ic:round-logout": LogOut,
  "ic:round-qr-code-scanner": QrCode,
  "ic:round-monitor": Monitor,
  "solar:copy-linear": Copy,
  "ic:round-content-copy": Copy,
  "solar:bookmark-bold": Bookmark,
  "ic:round-shield": Shield,
  "solar:safe-2-bold": Shield,
  "ic:round-fingerprint": Fingerprint,
  "ph:list-checks-bold": ListChecks,
  "ph:check-bold": Check,
  "ic:round-check": Check,
  "ph:check-circle-fill": CircleCheck,
  "ph:cloud-check-fill": CloudCheck,
  "solar:download-minimalistic-bold": Download,
  "ic:round-place": MapPin,
  "carbon:location": MapPin,
  "ic:round-meeting-room": DoorOpen,
  "mdi:door-open": DoorOpen,
  "material-symbols:door-front-outline": DoorClosed,
  "ic:round-account-balance-wallet": Wallet,
  "solar:wallet-bold": Wallet,
  "solar:wallet-money-bold": Wallet,
  "ph:gavel-bold": Gavel,
  "solar:dollar-minimalistic-bold": DollarSign,
  // status / info
  "ph:info-bold": Info,
  "ic:round-info": Info,
  "ph:warning-fill": TriangleAlert,
  "ph:warning-bold": TriangleAlert,
  "ph:warning-circle-fill": CircleAlert,
  "ic:round-error-outline": CircleAlert,
  "mdi:timer-sand": Hourglass,
  "mdi:clock-outline": Clock,
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
  const Lucide = MAP[icon];
  if (Lucide) {
    return (
      <Lucide
        size={size}
        className={cn(SPINNERS.has(icon) && "animate-spin", className)}
        style={{ display: "inline-block", verticalAlign: "-0.125em", ...style }}
      />
    );
  }
  // Fallback: brand logos (e.g. logos:google-icon) + the landing's decorative
  // set + any unmapped name → Iconify web component (unchanged behavior).
  return React.createElement("iconify-icon", {
    icon,
    width: size,
    height: size,
    className,
    style: { display: "inline-flex", lineHeight: 0, verticalAlign: "-0.125em", ...style },
  });
}

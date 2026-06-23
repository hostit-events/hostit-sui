import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { MobileTabBar } from "@/components/MobileTabBar";
import { TestnetBanner } from "@/components/TestnetBanner";
import { DiscoveryCommand } from "@/components/discovery/DiscoveryCommand";
import { ProfileGate } from "@/components/EmailCaptureDialog";
import { ResumeBuy } from "@/components/ResumeBuy";
import { TurnstileWarmup } from "@/components/TurnstileWarmup";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="app-shell flex flex-1 flex-col bg-background text-foreground">
      <TestnetBanner />
      <Header />
      {/* pb-24 on mobile clears the fixed bottom tab bar */}
      <main className="flex-1 w-full mx-auto max-w-[1180px] px-5 sm:px-8 pt-8 pb-24 md:pb-8">{children}</main>
      <Footer />
      <MobileTabBar />
      {/* App-level Cmd+K palette + calendar + shortcuts (self-contained island). */}
      <DiscoveryCommand />
      {/* One-time email-binding prompt (GH#96) — no-ops unless EMAIL_ENABLED + connected + unbound. */}
      <ProfileGate />
      {/* Re-opens the buy dialog after the Google sign-in redirect so a purchase
          started signed-out continues instead of resetting (no-ops otherwise). */}
      <ResumeBuy />
      {/* Runs the bot-check once on app entry (never the landing page) so the
          gasless purchase mints its token silently — no mid-checkout checkbox. */}
      <TurnstileWarmup />
    </div>
  );
}

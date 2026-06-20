import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { MobileTabBar } from "@/components/MobileTabBar";
import { DiscoveryCommand } from "@/components/discovery/DiscoveryCommand";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="app-shell flex flex-1 flex-col bg-background text-foreground">
      <Header />
      {/* pb-24 on mobile clears the fixed bottom tab bar */}
      <main className="flex-1 w-full mx-auto max-w-[1180px] px-5 sm:px-8 pt-8 pb-24 md:pb-8">{children}</main>
      <Footer />
      <MobileTabBar />
      {/* App-level Cmd+K palette + calendar + shortcuts (self-contained island). */}
      <DiscoveryCommand />
    </div>
  );
}

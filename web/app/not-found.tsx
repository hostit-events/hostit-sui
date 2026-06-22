import Link from "next/link";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { MobileTabBar } from "@/components/MobileTabBar";
import { Icon } from "@/components/Icon";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

/**
 * Root not-found page. A Next 15 App Router root `not-found.tsx` renders inside
 * the ROOT layout (`app/layout.tsx`, landing-only — no app chrome) and does NOT
 * inherit the `app/(app)/` route-group layout. So we render the exact same
 * chrome (Header + constrained <main> + Footer + MobileTabBar) here, reusing the
 * shared components, to keep the 404 experience consistent with the app.
 */
export default function NotFound() {
  return (
    <>
      <Header />
      {/* pb-24 on mobile clears the fixed bottom tab bar (matches the (app) layout) */}
      <main className="flex-1 w-full mx-auto max-w-[1180px] px-5 sm:px-8 pt-8 pb-24 md:pb-8 flex items-center justify-center">
        <Card className="w-full max-w-md flex flex-col items-center p-8 text-center">
          <div className="mono text-muted-foreground">404</div>
          <h1 className="mt-1.5 text-xl font-semibold">Page not found</h1>
          <p className="mt-1.5 text-sm text-muted-foreground">
            The page you&apos;re looking for doesn&apos;t exist or may have moved.
          </p>
          <Button asChild className="mt-4">
            <Link href="/discover">
              <Icon icon="ic:round-explore" size={16} /> Back to Discover
            </Link>
          </Button>
        </Card>
      </main>
      <Footer />
      <MobileTabBar />
    </>
  );
}

import Link from "next/link";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { MobileTabBar } from "@/components/MobileTabBar";

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
        <div className="card text-center" style={{ maxWidth: 440 }}>
          <div className="mono" style={{ color: "var(--fg3)" }}>
            404
          </div>
          <h1 className="font-semibold" style={{ fontSize: 22, marginTop: 6 }}>
            Page not found
          </h1>
          <p className="text-sm" style={{ color: "var(--fg2)", marginTop: 6 }}>
            The page you&apos;re looking for doesn&apos;t exist or may have moved.
          </p>
          <Link href="/discover" className="btn btn-primary" style={{ marginTop: 18 }}>
            Back to Discover
          </Link>
        </div>
      </main>
      <Footer />
      <MobileTabBar />
    </>
  );
}

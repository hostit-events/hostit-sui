import "./globals.css";
import "./landing-v2.css";
import type { Metadata } from "next";
import Script from "next/script";
import { Providers } from "./providers";
import { Geist } from "next/font/google";
import { SpeedInsights } from "@vercel/speed-insights/next";

// shadcn's interface font. Exposed as a CSS variable on <html>; the app uses it
// as its single typeface (globals.css points --font-sans/-mono/-display at it),
// while the landing keeps the brand fonts (re-scoped on `.lv`). Literal-name
// fallback per the shadcn Tailwind-v4 guidance.
const geistSans = Geist({ subsets: ["latin"], variable: "--font-geist-sans" });

export const metadata: Metadata = {
  title: "HostIt — Events made easy",
  description:
    "Sell tickets, host events, and check in attendees — on Sui. Permissionless: anyone can host.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`dark ${geistSans.variable}`}>
      <body className="min-h-dvh flex flex-col">
        <Script
          src="https://code.iconify.design/iconify-icon/2.1.0/iconify-icon.min.js"
          strategy="afterInteractive"
        />
        <Providers>{children}</Providers>
        <SpeedInsights />
      </body>
    </html>
  );
}

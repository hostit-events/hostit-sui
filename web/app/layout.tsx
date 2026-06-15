import "./globals.css";
import "./landing-v2.css";
import type { Metadata } from "next";
import Script from "next/script";
import { Providers } from "./providers";
import { Geist, Geist_Mono } from "next/font/google";

// shadcn's interface fonts. Exposed as CSS variables on <html>; the app zone
// opts in via the `.app-shell` class (lib globals.css), while the landing keeps
// the brand fonts. Literal-name fallbacks per the shadcn Tailwind-v4 guidance.
const geistSans = Geist({ subsets: ["latin"], variable: "--font-geist-sans" });
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono" });

export const metadata: Metadata = {
  title: "HostIt — Events made easy",
  description:
    "Sell tickets, host events, and check in attendees — on Sui. Permissionless: anyone can host.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`dark ${geistSans.variable} ${geistMono.variable}`}>
      <body className="min-h-dvh flex flex-col">
        <Script
          src="https://code.iconify.design/iconify-icon/2.1.0/iconify-icon.min.js"
          strategy="afterInteractive"
        />
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}

import "./globals.css";
import "./landing-v2.css";
import type { Metadata } from "next";
import Script from "next/script";
import { Providers } from "./providers";

export const metadata: Metadata = {
  title: "HostIt — Events made easy",
  description:
    "Sell tickets, host events, and check in attendees — on Sui. Permissionless: anyone can host.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
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

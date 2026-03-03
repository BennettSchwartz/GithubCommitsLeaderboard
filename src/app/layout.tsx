import type { Metadata } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";

import { Providers } from "@/components/providers";
import { SeoJsonLd, siteMetadata } from "@/app/seo";
import "./globals.css";

const bodyFont = IBM_Plex_Sans({
  variable: "--font-body",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

const monoFont = IBM_Plex_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

export const metadata: Metadata = siteMetadata;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <head>
        <SeoJsonLd />
      </head>
      <body
        className={`${bodyFont.variable} ${monoFont.variable}`}
        data-color-mode="light"
        data-light-theme="light"
      >
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}

import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import { Nav } from "./nav";
import { PageFade } from "./page-fade";
import { AmbientLayer } from "./ambient/ambient-layer";
import { ThemeProvider } from "./theme/theme-provider";
import { RegisterServiceWorker } from "./pwa/register-sw";
import { InstallHint } from "./pwa/install-hint";

/** Default matcha accent — ThemeProvider updates the live meta when theme changes. */
const MATCHA_THEME = "#5e8a68";

export const metadata: Metadata = {
  title: "笔记中枢",
  description: "个人只读笔记中枢，无团队协作",
  applicationName: "笔记中枢",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "笔记中枢",
    statusBarStyle: "default",
  },
  icons: {
    icon: [
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  other: {
    "mobile-web-app-capable": "yes",
    "apple-mobile-web-app-capable": "yes",
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: MATCHA_THEME },
    { media: "(prefers-color-scheme: dark)", color: "#7fa88a" },
    { color: MATCHA_THEME },
  ],
  colorScheme: "light dark",
};

/** Runs before paint so a saved theme does not flash matcha first. */
const THEME_BOOT = `(function(){try{var r=localStorage.getItem("hub_theme");if(!r)return;var t=JSON.parse(r).theme;var h=document.documentElement;if(t==="ink"||t==="plain"){h.setAttribute("data-theme",t);h.style.colorScheme=t==="ink"?"dark":"light";}else{h.removeAttribute("data-theme");h.style.colorScheme="light";}}catch(e){}})();`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@400;500;600;700&family=Noto+Serif+SC:wght@500;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <ThemeProvider />
        <RegisterServiceWorker />
        <Nav />
        <main className="shell">
          <PageFade>{children}</PageFade>
        </main>
        <AmbientLayer />
        <InstallHint />
      </body>
    </html>
  );
}

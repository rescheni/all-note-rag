import type { ReactNode } from "react";
import "./globals.css";
import { Nav } from "./nav";
import { PageFade } from "./page-fade";

export const metadata = {
  title: "笔记中枢",
  description: "个人笔记与团队文档只读聚合层",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@400;500;600;700&family=Noto+Serif+SC:wght@500;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <Nav />
        <main className="shell">
          <PageFade>{children}</PageFade>
        </main>
      </body>
    </html>
  );
}

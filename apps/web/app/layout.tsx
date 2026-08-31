import type { ReactNode } from "react";
import "./globals.css";
import { Nav } from "./nav";

export const metadata = {
  title: "笔记中枢",
  description: "个人笔记只读聚合层",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        <Nav />
        <div className="wrap">{children}</div>
      </body>
    </html>
  );
}

"use client";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

/**
 * 换页只做一次极短的落定：位移 + 透明度，都是合成器属性。
 * 不再对整页做 blur / clip-path —— 那会让每一帧重新栅格化整页，
 * 点导航后要等将近半秒才「清晰」，读起来就是「反应很慢」。
 */
export function PageFade({ children }: { children: ReactNode }) {
  const path = usePathname();
  return (
    <div key={path} className="page-fade">
      {children}
    </div>
  );
}

"use client";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

export function PageFade({ children }: { children: ReactNode }) {
  const path = usePathname();
  return (
    <div key={path} className="page-fade">
      {children}
    </div>
  );
}

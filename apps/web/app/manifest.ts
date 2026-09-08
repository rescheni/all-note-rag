import type { MetadataRoute } from "next";

/** Matcha / warm-paper tokens from globals.css :root */
const MATCHA_ACCENT = "#5e8a68";
const WARM_DESK = "#f3eee4";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "笔记中枢",
    short_name: "笔记中枢",
    description: "个人只读笔记中枢，聚合多源笔记",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: WARM_DESK,
    theme_color: MATCHA_ACCENT,
    lang: "zh-CN",
    dir: "ltr",
    orientation: "any",
    icons: [
      {
        src: "/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icon-512-maskable.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}

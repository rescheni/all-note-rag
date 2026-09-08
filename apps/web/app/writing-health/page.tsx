"use client";
import Link from "next/link";

/** Demoted from primary nav — keep route with a one-line note. */
export default function DemotedWritingHealthPage() {
  return (
    <div className="hub-page">
      <header className="hub-page-head">
        <h1>写作</h1>
        <p className="readonly-banner">写作健康度已从主导航下线。写作仍在思源 / Notion / 飞书 / Obsidian；中枢只读聚合与问答。</p>
        <p className="hub-hint-pill">
          <Link href="/ask">去问答</Link>
           · 
          <Link href="/">回首页</Link>
        </p>
      </header>
    </div>
  );
}

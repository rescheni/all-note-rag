"use client";
import Link from "next/link";

/** Demoted from primary nav — keep route with a one-line note. */
export default function DemotedSkillsPage() {
  return (
    <div className="hub-page">
      <header className="hub-page-head">
        <h1>Skills</h1>
        <p className="readonly-banner">Skills 已从主导航下线，避免喧宾夺主。高级能力仍可从本页进入；日常请用问答与搜索。</p>
        <p className="hub-hint-pill">
          <Link href="/ask">去问答</Link>
           · 
          <Link href="/">回首页</Link>
        </p>
      </header>
    </div>
  );
}

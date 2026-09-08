"use client";
import Link from "next/link";

/** Demoted from primary nav — keep route with a one-line note. */
export default function DemotedMeetingsPage() {
  return (
    <div className="hub-page">
      <header className="hub-page-head">
        <h1>会议</h1>
        <p className="readonly-banner">会议能力已从主导航下线；日常请用问答与搜索。写作与纪要仍在源应用完成。</p>
        <p className="hub-hint-pill">
          <Link href="/ask">去问答</Link>
           · 
          <Link href="/">回首页</Link>
        </p>
      </header>
    </div>
  );
}

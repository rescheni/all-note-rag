"use client";
import { Suspense } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ConnectionForm, type SourceId } from "../connection-form";

function NewConnectionInner() {
  const sp = useSearchParams();
  const source = (sp.get("source") || "") as SourceId | "";
  return <ConnectionForm variant="create" source={source} />;
}

export default function NewConnectionPage() {
  return (
    <>
      <nav className="crumbs">
        <Link href="/connections">来源</Link>
        <span className="crumb-sep">/</span>
        <span>新接入</span>
      </nav>
      <Suspense fallback={<p className="muted">加载中…</p>}>
        <NewConnectionInner />
      </Suspense>
    </>
  );
}

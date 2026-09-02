"use client";
import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { ConnectionForm, type SourceId } from "../connection-form";

function NewConnectionInner() {
  const sp = useSearchParams();
  const source = (sp.get("source") || "") as SourceId | "";
  return <ConnectionForm variant="create" source={source} />;
}

export default function NewConnectionPage() {
  return (
    <Suspense fallback={<p className="muted">加载中…</p>}>
      <NewConnectionInner />
    </Suspense>
  );
}

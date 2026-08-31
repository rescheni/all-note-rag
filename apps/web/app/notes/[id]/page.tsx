"use client";
import { useEffect, useRef } from "react";
import { useParams } from "next/navigation";
import { API, getToken } from "@/lib/api";

export default function NotePreviewPage() {
  const params = useParams<{ id: string }>();
  const ref = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    if (!getToken()) { location.href = "/login"; return; }
    const id = params.id;
    const token = getToken();
    fetch(`${API}/v1/notes/${id}/preview`, {
      headers: { authorization: `Bearer ${token}` },
      credentials: "include",
    })
      .then((r) => r.text())
      .then((html) => {
        const doc = ref.current?.contentDocument;
        if (!doc) return;
        doc.open();
        doc.write(html);
        doc.close();
        const hash = location.hash;
        if (hash && doc.getElementById(hash.slice(1))) {
          doc.getElementById(hash.slice(1))?.scrollIntoView();
        }
      });
  }, [params.id]);
  return (
    <>
      <h1>预览</h1>
      <p className="muted">块锚点可通过 URL hash 定位（#b-…）。预览只读本地缓存，不回源。</p>
      <iframe className="preview-frame" ref={ref} title="note-preview" />
    </>
  );
}

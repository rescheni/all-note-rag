"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { API, api, getToken } from "@/lib/api";

type SimilarHit = {
  note_id: string;
  title: string;
  path: string;
  snippet: string;
  preview_url: string;
  score: number;
};

export default function NotePreviewPage() {
  const params = useParams<{ id: string }>();
  const ref = useRef<HTMLIFrameElement>(null);
  const [similar, setSimilar] = useState<SimilarHit[]>([]);
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
    api<{ similar?: SimilarHit[] }>(`/v1/notes/${id}/similar`)
      .then((out) => setSimilar(out.similar ?? []))
      .catch(() => setSimilar([]));
  }, [params.id]);
  return (
    <>
      <h1>预览</h1>
      <p className="muted">块锚点可通过 URL hash 定位（#b-…）。预览只读本地缓存，不回源。</p>
      <iframe className="preview-frame" ref={ref} title="note-preview" />
      {similar.length > 0 && (
        <section className="card">
          <h2>相似笔记</h2>
          <ul className="list">
            {similar.map((h) => (
              <li key={h.note_id}>
                <Link href={h.preview_url}>{h.title}</Link>
                <div className="muted">{h.path}</div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

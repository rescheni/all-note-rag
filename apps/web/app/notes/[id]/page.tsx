"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { api, apiOrigin, getToken } from "@/lib/api";
import { NoteWho } from "./note-who";

type SimilarHit = {
  note_id: string;
  title: string;
  path: string;
  snippet: string;
  preview_url: string;
  score: number;
};

function hubAssetUrl(src: string, noteId: string): string | null {
  const raw = (src || "").trim();
  if (!raw || raw.startsWith("data:") || raw.startsWith("blob:")) return null;
  const origin = apiOrigin();
  try {
    const base = typeof window !== "undefined" ? window.location.origin : origin;
    const absolute = raw.startsWith("http://") || raw.startsWith("https://") || raw.startsWith("/");
    if (absolute) {
      const u = new URL(raw, base);
      const loopback = u.hostname === "127.0.0.1" || u.hostname === "localhost";
      const same = u.origin === base || u.origin === origin || u.origin === "null";
      if (u.pathname.startsWith("/v1/") && (same || loopback)) {
        const q = new URLSearchParams(u.search);
        q.delete("token");
        const search = q.toString();
        return `${origin}${u.pathname}${search ? `?${search}` : ""}`;
      }
      return null;
    }
  } catch {
    /* relative */
  }
  const rel = raw.replace(/^\.\//, "");
  return `${origin}/v1/notes/${noteId}/assets?path=${encodeURIComponent(rel)}`;
}

function appendToken(url: string, token: string | null): string {
  if (!token) return url;
  try {
    const u = new URL(url);
    u.searchParams.set("token", token);
    return u.toString();
  } catch {
    const join = url.includes("?") ? "&" : "?";
    return `${url}${join}token=${encodeURIComponent(token)}`;
  }
}

/** Rewrite /v1 and relative assets/... img src to an absolute API URL with ?token=. */
function rewritePreviewHtmlForIframe(html: string, noteId: string, token: string | null): string {
  const rewriteSrc = (src: string): string => {
    const target = hubAssetUrl(src, noteId);
    if (!target) return src;
    return appendToken(target, token);
  };
  let body = html;
  body = body.replace(
    /(<img\b[^>]*\ssrc=")([^"]+)(")/gi,
    (_a, pre: string, src: string, post: string) => `${pre}${rewriteSrc(src)}${post}`,
  );
  body = body.replace(
    /(url\()(['"]?)([^'")]+)(\2\))/gi,
    (_a, pre: string, q: string, src: string, post: string) => {
      if (/^(https?:|data:|blob:)/i.test(src) && !/\/v1\//.test(src) && !/assets\//i.test(src)) {
        return `${pre}${q}${src}${post}`;
      }
      return `${pre}${q}${rewriteSrc(src)}${post}`;
    },
  );
  return body;
}

async function hydratePreviewAssets(doc: Document, noteId: string, token: string | null, blobs: string[]): Promise<void> {
  const auth: HeadersInit = token ? { authorization: `Bearer ${token}` } : {};
  const imgs = Array.from(doc.querySelectorAll("img"));
  for (const img of imgs) {
    const src = img.getAttribute("src") || "";
    const target = hubAssetUrl(src, noteId);
    if (!target) continue;
    try {
      const res = await fetch(target, { headers: auth, credentials: "include" });
      if (!res.ok) continue;
      const blob = await res.blob();
      const obj = URL.createObjectURL(blob);
      blobs.push(obj);
      img.setAttribute("src", obj);
    } catch {
      /* keep original src */
    }
  }
  const styled = Array.from(doc.querySelectorAll<HTMLElement>("[style]"));
  for (const el of styled) {
    const st = el.getAttribute("style") || "";
    const m = /url\((['"]?)([^'")]+)\1\)/i.exec(st);
    if (!m) continue;
    const target = hubAssetUrl(m[2], noteId);
    if (!target) continue;
    try {
      const res = await fetch(target, { headers: auth, credentials: "include" });
      if (!res.ok) continue;
      const blob = await res.blob();
      const obj = URL.createObjectURL(blob);
      blobs.push(obj);
      el.style.backgroundImage = `url("${obj}")`;
    } catch {
      /* keep */
    }
  }
}

export default function NotePreviewPage() {
  const params = useParams<{ id: string }>();
  const ref = useRef<HTMLIFrameElement>(null);
  const blobsRef = useRef<string[]>([]);
  const [srcDoc, setSrcDoc] = useState("");
  const [similar, setSimilar] = useState<SimilarHit[]>([]);
  const [meta, setMeta] = useState<{
    title: string;
    path: string;
    space_id: string;
    acl: { visibility: "space" | "owners" | "members"; user_ids: string[]; visible_in_space: boolean };
    can_patch_acl: boolean;
  } | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    if (!getToken()) { location.href = "/login"; return; }
    const id = params.id;
    const token = getToken();
    const blobs = blobsRef.current;
    let cancelled = false;
    fetch(`${apiOrigin()}/v1/notes/${id}/preview`, {
      headers: { authorization: `Bearer ${token}` },
      credentials: "include",
    })
      .then((r) => r.text())
      .then(async (html) => {
        if (cancelled) return;
        const rewritten = rewritePreviewHtmlForIframe(html, id, token);
        setSrcDoc(rewritten);
        const iframe = ref.current;
        if (iframe) iframe.srcdoc = rewritten;
        const doc = iframe?.contentDocument;
        if (doc) {
          await hydratePreviewAssets(doc, id, token, blobs);
          const hash = location.hash;
          if (hash && doc.getElementById(hash.slice(1))) {
            doc.getElementById(hash.slice(1))?.scrollIntoView();
          }
        }
      });
    api<{ similar?: SimilarHit[] }>(`/v1/notes/${id}/similar`)
      .then((out) => setSimilar(out.similar ?? []))
      .catch(() => setSimilar([]));
    api<{
        note?: {
          title: string;
          path: string;
          space_id: string;
          acl?: { visibility: "space" | "owners" | "members"; user_ids: string[]; visible_in_space: boolean };
        };
        can_patch_acl?: boolean;
      }>(`/v1/notes/${id}`)
      .then((out) => {
        if (out.note) {
          setMissing(false);
          setMeta({
            title: out.note.title,
            path: out.note.path,
            space_id: out.note.space_id,
            acl: out.note.acl ?? { visibility: "space", user_ids: [], visible_in_space: true },
            can_patch_acl: Boolean(out.can_patch_acl),
          });
        } else {
          setMissing(true);
        }
      })
      .catch(() => {
        setMeta(null);
        setMissing(true);
      });
    return () => {
      cancelled = true;
      for (const u of blobsRef.current) URL.revokeObjectURL(u);
      blobsRef.current = [];
    };
  }, [params.id]);
  if (missing) {
    return (
      <>
        <h1>找不到这篇</h1>
        <p className="muted">也许它还没同步进来，或只给空间里的一部分人看。</p>
        <p><Link href="/notes">回笔记目录</Link></p>
      </>
    );
  }
  return (
    <>
      <h1>{meta?.title || "预览"}</h1>
      {meta?.path && (
        <nav className="crumbs">
          <Link href="/notes">笔记</Link>
          {meta.path.split("/").map((part, i, arr) => (
            <span key={i}> / {i === arr.length - 1 ? part : part}</span>
          ))}
        </nav>
      )}
      <p className="muted">块锚点可通过 URL hash 定位（#b-…）。预览只读本地缓存，不回源。</p>
      {meta && (
        <NoteWho
          noteId={params.id}
          spaceId={meta.space_id}
          acl={meta.acl}
          canPatch={meta.can_patch_acl}
        />
      )}
      <iframe
        className="preview-frame"
        ref={ref}
        title="note-preview"
        srcDoc={srcDoc}
        onLoad={() => {
          const doc = ref.current?.contentDocument;
          if (!doc) return;
          const token = getToken();
          const id = params.id;
          void hydratePreviewAssets(doc, id, token, blobsRef.current).then(() => {
            const hash = location.hash;
            if (hash && doc.getElementById(hash.slice(1))) {
              doc.getElementById(hash.slice(1))?.scrollIntoView();
            }
          });
        }}
      />
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

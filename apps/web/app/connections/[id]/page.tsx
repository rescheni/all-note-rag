"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { api, getToken } from "@/lib/api";
import { ConnectionForm, type PublicConnection, type SecretFlags, type SourceId } from "../connection-form";
import { DeleteConnectionDialog, SOURCE_LABEL, type DeleteTarget } from "../delete-connection";

export default function EditConnectionPage() {
  const params = useParams<{ id: string }>();
  const [connection, setConnection] = useState<PublicConnection | null>(null);
  const [secrets, setSecrets] = useState<SecretFlags | undefined>();
  const [err, setErr] = useState("");
  const [target, setTarget] = useState<DeleteTarget | null>(null);

  useEffect(() => {
    if (!getToken()) {
      location.href = "/login";
      return;
    }
    const id = params.id;
    api<{ connection: PublicConnection; secrets: SecretFlags }>(`/v1/connections/${id}`)
      .then((r) => {
        setConnection(r.connection);
        setSecrets(r.secrets);
      })
      .catch((e) => setErr(e instanceof Error ? e.message : "加载失败"));
  }, [params.id]);

  if (err && !connection) return <p className="err">{err}</p>;
  if (!connection) return <p className="muted">加载中…</p>;

  return (
    <>
      <nav className="crumbs">
        <Link href="/connections">来源</Link>
        <span className="crumb-sep">/</span>
        <span>{connection.name}</span>
      </nav>
      <ConnectionForm
        variant="edit"
        source={(connection.source as SourceId) || ""}
        connection={connection}
        secrets={secrets}
      />
      <section className="hub-danger-zone" aria-labelledby="hub-del-zone">
        <h2 id="hub-del-zone">删除这个连接</h2>
        <p className="hint">
          「{connection.name}」（{SOURCE_LABEL[connection.source] ?? connection.source}
          {connection.status === "error" ? " · 当前状态：错误" : ""}
          {connection.status === "encrypted_unreadable" ? " · 当前状态：加密不可读" : ""}） 从中枢移除后，
          它同步进来的笔记、附件与检索片段会一起消失；源里的原始内容不受影响。授权已失效也能删除。
        </p>
        <p className="hint">删除前会先告诉你会少掉多少篇笔记，需要勾选确认。</p>
        <div className="hub-danger-zone-actions">
          <Link href="/connections" className="btn secondary">
            返回来源列表
          </Link>
          <button
            type="button"
            className="hub-danger"
            onClick={() =>
              setTarget({ id: connection.id, name: connection.name, source: connection.source })
            }
          >
            删除连接…
          </button>
        </div>
      </section>
      <DeleteConnectionDialog
        target={target}
        onCancel={() => setTarget(null)}
        onDeleted={() => {
          location.href = "/connections";
        }}
      />
    </>
  );
}

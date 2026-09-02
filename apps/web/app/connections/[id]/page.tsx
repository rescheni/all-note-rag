"use client";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { api, getToken } from "@/lib/api";
import { ConnectionForm, type PublicConnection, type SecretFlags, type SourceId } from "../connection-form";

export default function EditConnectionPage() {
  const params = useParams<{ id: string }>();
  const [connection, setConnection] = useState<PublicConnection | null>(null);
  const [secrets, setSecrets] = useState<SecretFlags | undefined>();
  const [err, setErr] = useState("");

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
    <ConnectionForm
      variant="edit"
      source={(connection.source as SourceId) || ""}
      connection={connection}
      secrets={secrets}
    />
  );
}

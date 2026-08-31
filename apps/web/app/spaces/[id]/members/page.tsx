"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { api, getToken } from "@/lib/api";
import { spaceKindLabel, storeSpaceId } from "@/lib/space";
import { MembersPanel } from "../../../members-panel";

export default function SpaceMembersPage() {
  const params = useParams<{ id: string }>();
  const [err, setErr] = useState("");
  const [space, setSpace] = useState<{ id: string; name: string; kind: string } | null>(null);
  const [role, setRole] = useState("viewer");

  useEffect(() => {
    if (!getToken()) {
      location.href = "/login";
      return;
    }
    const id = params.id;
    (async () => {
      try {
        const r = await api<{ space: { id: string; name: string; kind: string }; role: string }>(
          `/v1/spaces/${id}`,
        );
        setSpace(r.space);
        setRole(r.role);
        storeSpaceId(r.space.id);
      } catch (e) {
        setErr(e instanceof Error ? e.message : "加载失败");
      }
    })();
  }, [params.id]);

  return (
    <>
      <h1>{space ? `${space.name} · 成员` : "成员"}</h1>
      <p className="readonly-banner">中枢只读，不写回任何源。</p>
      {space && (
        <p className="muted">
          {spaceKindLabel(space.kind)}空间 · <Link href="/">返回空间</Link>
        </p>
      )}
      {err && <p className="err">{err}</p>}
      {space && <MembersPanel spaceId={space.id} role={role} />}
    </>
  );
}

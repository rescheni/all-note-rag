"use client";
import { FormEvent, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { roleLabel } from "@/lib/space";

type Member = {
  user_id: string;
  role: string;
  email: string;
  display_name: string | null;
  created_at: string;
};

export function MembersPanel({ spaceId, role }: { spaceId: string; role: string }) {
  const [members, setMembers] = useState<Member[]>([]);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const canManage = role === "owner";

  async function refresh() {
    const r = await api<{ members: Member[] }>(`/v1/spaces/${spaceId}/members`);
    setMembers(r.members);
  }

  useEffect(() => {
    setErr("");
    refresh().catch((e) => setErr(e instanceof Error ? e.message : "加载成员失败"));
  }, [spaceId]);

  async function onAdd(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErr("");
    setBusy(true);
    const fd = new FormData(e.currentTarget);
    try {
      await api(`/v1/spaces/${spaceId}/members`, {
        method: "POST",
        body: JSON.stringify({ email: fd.get("email"), role: fd.get("role") }),
      });
      (e.target as HTMLFormElement).reset();
      await refresh();
    } catch (er) {
      setErr(er instanceof Error ? er.message : "添加失败");
    } finally {
      setBusy(false);
    }
  }

  async function onRemove(userId: string) {
    setErr("");
    try {
      await api(`/v1/spaces/${spaceId}/members/${userId}`, { method: "DELETE" });
      await refresh();
    } catch (er) {
      setErr(er instanceof Error ? er.message : "移除失败");
    }
  }

  async function onRole(userId: string, next: string) {
    setErr("");
    try {
      await api(`/v1/spaces/${spaceId}/members/${userId}`, {
        method: "PUT",
        body: JSON.stringify({ role: next }),
      });
      await refresh();
    } catch (er) {
      setErr(er instanceof Error ? er.message : "更新角色失败");
    }
  }

  return (
    <div className="card">
      <h2>成员</h2>
      {err && <p className="err">{err}</p>}
      <ul className="list">
        {members.map((m) => (
          <li key={m.user_id}>
            <strong>{m.display_name || m.email}</strong>{" "}
            <span className="muted">{m.email} · {roleLabel(m.role)}</span>
            {canManage && (
              <div className="member-actions">
                <select
                  value={m.role}
                  onChange={(ev) => onRole(m.user_id, ev.target.value)}
                  aria-label="角色"
                >
                  <option value="owner">所有者</option>
                  <option value="editor">编辑</option>
                  <option value="viewer">只读</option>
                </select>
                <button type="button" className="secondary" onClick={() => onRemove(m.user_id)}>
                  移除
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {canManage && (
        <form className="member-add" onSubmit={onAdd}>
          <label>邮箱</label>
          <input name="email" type="email" required placeholder="已注册用户的邮箱" />
          <label>角色</label>
          <select name="role" defaultValue="viewer">
            <option value="owner">所有者</option>
            <option value="editor">编辑</option>
            <option value="viewer">只读</option>
          </select>
          <p><button type="submit" disabled={busy}>{busy ? "添加中…" : "添加成员"}</button></p>
        </form>
      )}
    </div>
  );
}

"use client";
import { FormEvent, useEffect, useState } from "react";
import { api, getToken } from "@/lib/api";
import { roleLabel } from "@/lib/space";

type Member = {
  user_id: string;
  role: string;
  email: string;
  display_name: string | null;
  created_at: string;
};

export function MembersPanel({
  spaceId,
  role,
  spaceKind = "team",
}: {
  spaceId: string;
  role: string;
  spaceKind?: string;
}) {
  const [members, setMembers] = useState<Member[]>([]);
  const [meId, setMeId] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const [ok, setOk] = useState("");
  const [busy, setBusy] = useState(false);
  const [resetFor, setResetFor] = useState<string | null>(null);
  const canManage = role === "owner";
  const isPersonal = spaceKind === "personal";

  async function refresh() {
    const r = await api<{ members: Member[] }>(`/v1/spaces/${spaceId}/members`);
    setMembers(r.members);
  }

  useEffect(() => {
    setErr("");
    refresh().catch((e) => setErr(e instanceof Error ? e.message : "加载成员失败"));
    if (getToken()) {
      api<{ user: { id: string } }>("/v1/me")
        .then((r) => setMeId(r.user.id))
        .catch(() => undefined);
    }
  }, [spaceId]);

  async function onAdd(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErr("");
    setOk("");
    setBusy(true);
    const fd = new FormData(e.currentTarget);
    try {
      await api(`/v1/spaces/${spaceId}/members`, {
        method: "POST",
        body: JSON.stringify({ email: fd.get("email"), role: fd.get("role") }),
      });
      (e.target as HTMLFormElement).reset();
      setOk("已添加成员");
      await refresh();
    } catch (er) {
      setErr(er instanceof Error ? er.message : "添加失败");
    } finally {
      setBusy(false);
    }
  }

  async function onCreateSub(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErr("");
    setOk("");
    setBusy(true);
    const fd = new FormData(e.currentTarget);
    try {
      await api(`/v1/spaces/${spaceId}/accounts`, {
        method: "POST",
        body: JSON.stringify({
          email: fd.get("email"),
          password: fd.get("password"),
          display_name: fd.get("display_name") || undefined,
          role: fd.get("role") || "viewer",
        }),
      });
      (e.target as HTMLFormElement).reset();
      setOk("子账号已创建");
      await refresh();
    } catch (er) {
      setErr(er instanceof Error ? er.message : "创建失败");
    } finally {
      setBusy(false);
    }
  }

  async function onRemove(userId: string) {
    setErr("");
    setOk("");
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

  async function onResetPassword(e: FormEvent<HTMLFormElement>, userId: string) {
    e.preventDefault();
    setErr("");
    setOk("");
    const fd = new FormData(e.currentTarget);
    const new_password = String(fd.get("new_password") ?? "");
    try {
      await api(`/v1/spaces/${spaceId}/accounts/${userId}/password`, {
        method: "PUT",
        body: JSON.stringify({ new_password }),
      });
      setResetFor(null);
      setOk("密码已重置");
    } catch (er) {
      setErr(er instanceof Error ? er.message : "重置失败");
    }
  }

  return (
    <div className="card">
      <h2>{isPersonal ? "子账号" : "成员"}</h2>
      {err && <p className="err">{err}</p>}
      {ok && <p className="ok-msg">{ok}</p>}
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
                {m.user_id !== meId && (
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => setResetFor(resetFor === m.user_id ? null : m.user_id)}
                  >
                    重置密码
                  </button>
                )}
                <button type="button" className="secondary" onClick={() => onRemove(m.user_id)}>
                  移除
                </button>
              </div>
            )}
            {canManage && resetFor === m.user_id && (
              <form className="member-add" onSubmit={(ev) => onResetPassword(ev, m.user_id)}>
                <label>新密码</label>
                <input name="new_password" type="password" required minLength={6} placeholder="至少 6 位" />
                <p>
                  <button type="submit">确认重置</button>{" "}
                  <button type="button" className="secondary" onClick={() => setResetFor(null)}>
                    取消
                  </button>
                </p>
              </form>
            )}
          </li>
        ))}
      </ul>

      {canManage && (
        <form className="member-add" onSubmit={onCreateSub}>
          <h3 style={{ margin: "0.5rem 0 0.35rem", fontSize: "1rem" }}>创建子账号</h3>
          <p className="hint" style={{ marginTop: 0 }}>
            {isPersonal
              ? "个人空间可通过子账号共享只读/编辑权限；不会为子账号再建个人空间。"
              : "新建账号并加入本空间。已注册邮箱请用下方「添加成员」。"}
          </p>
          <label>邮箱</label>
          <input name="email" type="email" required placeholder="子账号邮箱" />
          <label>显示名（可选）</label>
          <input name="display_name" type="text" placeholder="称呼" />
          <label>初始密码</label>
          <input name="password" type="password" required minLength={6} placeholder="至少 6 位" />
          <label>角色</label>
          <select name="role" defaultValue="viewer">
            <option value="owner">所有者</option>
            <option value="editor">编辑</option>
            <option value="viewer">只读</option>
          </select>
          <p>
            <button type="submit" disabled={busy}>
              {busy ? "创建中…" : "创建子账号"}
            </button>
          </p>
        </form>
      )}

      {canManage && !isPersonal && (
        <form className="member-add" onSubmit={onAdd}>
          <h3 style={{ margin: "0.5rem 0 0.35rem", fontSize: "1rem" }}>添加成员</h3>
          <p className="hint" style={{ marginTop: 0 }}>邀请已注册用户加入团队空间。</p>
          <label>邮箱</label>
          <input name="email" type="email" required placeholder="已注册用户的邮箱" />
          <label>角色</label>
          <select name="role" defaultValue="viewer">
            <option value="owner">所有者</option>
            <option value="editor">编辑</option>
            <option value="viewer">只读</option>
          </select>
          <p>
            <button type="submit" disabled={busy}>
              {busy ? "添加中…" : "添加成员"}
            </button>
          </p>
        </form>
      )}
    </div>
  );
}

"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";

type NoteAcl = {
  visibility: "space" | "owners" | "members";
  user_ids: string[];
  visible_in_space: boolean;
};

type Member = {
  user_id: string;
  role: string;
  email: string;
  display_name: string | null;
};

const OPTIONS: { value: NoteAcl["visibility"]; label: string; hint: string }[] = [
  { value: "space", label: "空间里的人", hint: "这个空间的成员都能打开。" },
  { value: "owners", label: "仅所有者", hint: "只有空间所有者能打开。" },
  { value: "members", label: "指定几位", hint: "勾选的人能打开；所有者始终能打开。" },
];

export function NoteWho({
  noteId,
  spaceId,
  acl,
  canPatch,
}: {
  noteId: string;
  spaceId: string;
  acl: NoteAcl;
  canPatch: boolean;
}) {
  const [visibility, setVisibility] = useState<NoteAcl["visibility"]>(acl.visibility);
  const [picked, setPicked] = useState<string[]>(acl.user_ids);
  const [members, setMembers] = useState<Member[]>([]);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setVisibility(acl.visibility);
    setPicked(acl.user_ids);
  }, [acl.visibility, acl.user_ids.join("|")]);

  useEffect(() => {
    if (!canPatch) return;
    api<{ members: Member[] }>(`/v1/spaces/${spaceId}/members`)
      .then((r) => setMembers(r.members))
      .catch(() => setMembers([]));
  }, [spaceId, canPatch]);

  async function save(nextVis: NoteAcl["visibility"], nextIds: string[]) {
    setBusy(true);
    setErr("");
    setMsg("");
    try {
      await api(`/v1/notes/${noteId}/acl`, {
        method: "PATCH",
        body: JSON.stringify({ visibility: nextVis, user_ids: nextIds }),
      });
      setVisibility(nextVis);
      setPicked(nextIds);
      setMsg("已记下");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "没能改成");
    } finally {
      setBusy(false);
    }
  }

  if (!canPatch) {
    if (acl.visibility === "space") return null;
    return (
      <p className="muted note-who-hint">
        {acl.visibility === "owners" ? "这篇只给所有者看。" : "这篇只给指定的几位成员看。"}
      </p>
    );
  }

  const hint = OPTIONS.find((o) => o.value === visibility)?.hint ?? "";

  return (
    <section className="note-who" aria-label="谁可以看这篇">
      <p className="note-who-title">谁可以看这篇</p>
      <div className="note-who-opts">
        {OPTIONS.map((o) => (
          <label key={o.value} className="note-who-opt">
            <input
              type="radio"
              name="note-who"
              value={o.value}
              checked={visibility === o.value}
              disabled={busy}
              onChange={() => void save(o.value, picked)}
            />
            {o.label}
          </label>
        ))}
      </div>
      <p className="muted note-who-hint">{hint}</p>
      {visibility === "members" && (
        <div className="note-who-members">
          {members.length === 0 ? (
            <p className="muted">这个空间里还没有其他成员。</p>
          ) : (
            members.map((m) => {
              const checked = m.role === "owner" || picked.includes(m.user_id);
              return (
                <label key={m.user_id} className="note-who-opt">
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={busy || m.role === "owner"}
                    onChange={() => {
                      const next = checked
                        ? picked.filter((id) => id !== m.user_id)
                        : [...picked, m.user_id];
                      void save("members", next);
                    }}
                  />
                  {m.display_name || m.email}
                  {m.role === "owner" ? "（所有者，始终能看）" : ""}
                </label>
              );
            })
          )}
        </div>
      )}
      {msg && <p className="muted">{msg}</p>}
      {err && <p className="err">{err}</p>}
    </section>
  );
}

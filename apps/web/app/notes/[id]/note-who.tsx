"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";

type NoteAcl = {
  visibility: "space" | "owners" | "members";
  user_ids: string[];
  visible_in_space: boolean;
};

/** Personal-notes product: no team ACL UX. Map legacy values to simple copy. */
const OPTIONS: { value: NoteAcl["visibility"]; label: string; hint: string }[] = [
  { value: "owners", label: "仅自己", hint: "只有你可以打开这篇。" },
  { value: "space", label: "仅自己", hint: "个人空间内可见，即仅你自己。" },
];

function labelFor(v: NoteAcl["visibility"]): string {
  if (v === "members") return "仅自己";
  return OPTIONS.find((o) => o.value === v)?.label ?? "仅自己";
}

function hintFor(v: NoteAcl["visibility"]): string {
  if (v === "members") return "私人笔记默认仅自己可见。";
  return OPTIONS.find((o) => o.value === v)?.hint ?? "只有你可以打开这篇。";
}

export function NoteWho({
  noteId,
  spaceId: _spaceId,
  acl,
  canPatch,
}: {
  noteId: string;
  spaceId: string;
  acl: NoteAcl;
  canPatch: boolean;
}) {
  const [visibility, setVisibility] = useState<NoteAcl["visibility"]>(
    acl.visibility === "members" ? "owners" : acl.visibility,
  );
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setVisibility(acl.visibility === "members" ? "owners" : acl.visibility);
  }, [acl.visibility]);

  async function save(nextVis: NoteAcl["visibility"]) {
    setBusy(true);
    setErr("");
    setMsg("");
    try {
      await api(`/v1/notes/${noteId}/acl`, {
        method: "PATCH",
        body: JSON.stringify({ visibility: nextVis, user_ids: [] }),
      });
      setVisibility(nextVis);
      setMsg("已记下");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "没能改成");
    } finally {
      setBusy(false);
    }
  }

  if (!canPatch) {
    return (
      <p className="muted note-who-hint">私人笔记 · 仅自己可见。</p>
    );
  }

  return (
    <details className="note-who" aria-label="谁可以看这篇">
      <summary className="note-who-title">谁可以看这篇 · {labelFor(visibility)}</summary>
      <div className="note-who-opts">
        <label className="note-who-opt">
          <input
            type="radio"
            name="note-who"
            value="owners"
            checked={visibility === "owners" || visibility === "space"}
            disabled={busy}
            onChange={() => void save("owners")}
          />
          仅自己
        </label>
      </div>
      <p className="muted note-who-hint">{hintFor(visibility)}</p>
      {msg && <p className="muted">{msg}</p>}
      {err && <p className="err">{err}</p>}
    </details>
  );
}

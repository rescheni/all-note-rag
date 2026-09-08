"use client";
import { useEffect } from "react";
import Link from "next/link";
import { getToken } from "@/lib/api";

/** Members route retired — personal notes only. Sub-accounts live on /account. */
export default function SpaceMembersPage() {
  useEffect(() => {
    if (!getToken()) {
      location.href = "/login";
      return;
    }
    location.replace("/account");
  }, []);

  return (
    <>
      <h1>子账号</h1>
      <p className="muted">
        笔记中枢是个人只读中枢。子账号与 API 令牌请前往{" "}
        <Link href="/account">账号</Link>。
      </p>
    </>
  );
}

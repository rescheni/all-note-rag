"use client";

import { useEffect, useId, useRef, useState } from "react";
import { api, friendlyErrorMessage } from "@/lib/api";

const SDK_SRC =
  "https://lf-package-cn.feishucdn.com/obj/feishu-static/lark/passport/qrcode/LarkSSOSDKWebQRCode-1.0.3.js";

type QrPayload = {
  client_id: string;
  redirect_uri: string;
  goto: string;
  state: string;
};

type QrHandle = {
  matchOrigin: (origin: string) => boolean;
  matchData: (data: unknown) => boolean;
};

function loadQrSdk(): Promise<(opts: Record<string, string>) => QrHandle> {
  const w = window as unknown as { QRLogin?: (opts: Record<string, string>) => QrHandle };
  if (typeof w.QRLogin === "function") return Promise.resolve(w.QRLogin);
  const existing = document.querySelector<HTMLScriptElement>(`script[data-feishu-qr="1"]`);
  if (existing) {
    return new Promise((resolve, reject) => {
      existing.addEventListener("load", () => {
        const fn = (window as unknown as { QRLogin?: (opts: Record<string, string>) => QrHandle }).QRLogin;
        if (fn) resolve(fn);
        else reject(new Error("无法加载飞书扫码组件"));
      });
      existing.addEventListener("error", () => reject(new Error("无法加载飞书扫码组件")));
    });
  }
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = SDK_SRC;
    s.async = true;
    s.dataset.feishuQr = "1";
    s.onload = () => {
      const fn = (window as unknown as { QRLogin?: (opts: Record<string, string>) => QrHandle }).QRLogin;
      if (fn) resolve(fn);
      else reject(new Error("无法加载飞书扫码组件"));
    };
    s.onerror = () => reject(new Error("无法加载飞书扫码组件"));
    document.head.appendChild(s);
  });
}

export function FeishuQr({
  spaceId,
  connectionId,
  name,
  onError,
}: {
  spaceId: string;
  connectionId?: string;
  name: string;
  onError: (msg: string) => void;
}) {
  const rawId = useId().replace(/:/g, "");
  const containerId = `feishu-qr-${rawId}`;
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [tick, setTick] = useState(0);
  const gotoRef = useRef("");
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  useEffect(() => {
    if (!spaceId) return;
    let cancelled = false;
    let qrObj: QrHandle | null = null;
    const handleMessage = (event: MessageEvent) => {
      if (!qrObj) return;
      try {
        if (!qrObj.matchOrigin(event.origin) || !qrObj.matchData(event.data)) return;
      } catch {
        return;
      }
      const tmp = (event.data as { tmp_code?: string } | null)?.tmp_code;
      if (!tmp || !gotoRef.current) return;
      window.location.href = `${gotoRef.current}&tmp_code=${encodeURIComponent(tmp)}`;
    };

    setStatus("loading");
    (async () => {
      try {
        const q = new URLSearchParams({
          space_id: spaceId,
          name: name.trim() || "我的飞书",
          origin: window.location.origin,
        });
        if (connectionId) q.set("connection_id", connectionId);
        const r = await api<QrPayload>(`/v1/connections/oauth/feishu/qr?${q.toString()}`);
        if (cancelled) return;
        gotoRef.current = r.goto;
        const QRLogin = await loadQrSdk();
        if (cancelled) return;
        const el = document.getElementById(containerId);
        if (el) el.replaceChildren();
        qrObj = QRLogin({
          id: containerId,
          goto: r.goto,
          width: "250",
          height: "250",
          style: "width:250px;height:250px;border:0;background:transparent;",
        });
        window.addEventListener("message", handleMessage);
        setStatus("ready");
      } catch (e) {
        if (cancelled) return;
        setStatus("error");
        onErrorRef.current(
          friendlyErrorMessage(e instanceof Error ? e.message : "无法显示飞书二维码", "无法显示飞书二维码"),
        );
      }
    })();

    return () => {
      cancelled = true;
      window.removeEventListener("message", handleMessage);
      const el = document.getElementById(containerId);
      if (el) el.replaceChildren();
    };
  }, [spaceId, connectionId, name, containerId, tick]);

  return (
    <div className="feishu-qr-wrap signature-frame">
      <div id={containerId} className={status === "ready" ? "feishu-qr is-ready" : "feishu-qr"} aria-label="飞书登录二维码" />
      {status === "loading" && <p className="empty-desk">正在生成二维码…</p>}
      {status === "error" && (
        <p className="hint">
          嵌入二维码无法显示，请用上方「用飞书扫码登录」。
          <button type="button" className="linkish" onClick={() => setTick((n) => n + 1)}>
            再试一次
          </button>
        </p>
      )}
    </div>
  );
}

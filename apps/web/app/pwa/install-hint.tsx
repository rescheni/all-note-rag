"use client";

import { useCallback, useEffect, useState } from "react";

const DISMISS_KEY = "hub_pwa_install_dismissed";

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

/**
 * Subtle, once-dismissible install hint when Chrome fires beforeinstallprompt.
 * iOS has no BIP — users use Share → 添加到主屏幕; we do not nag there.
 */
export function InstallHint() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      if (window.localStorage.getItem(DISMISS_KEY) === "1") return;
    } catch {
      return;
    }
    // Already installed / standalone — stay quiet.
    const standalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      // @ts-expect-error iOS Safari
      window.navigator.standalone === true;
    if (standalone) return;

    const onBip = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
      setVisible(true);
    };
    window.addEventListener("beforeinstallprompt", onBip);
    return () => window.removeEventListener("beforeinstallprompt", onBip);
  }, []);

  const dismiss = useCallback(() => {
    setVisible(false);
    setDeferred(null);
    try {
      window.localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      /* private mode */
    }
  }, []);

  const install = useCallback(async () => {
    if (!deferred) return;
    try {
      await deferred.prompt();
      await deferred.userChoice;
    } catch {
      /* user closed sheet */
    }
    dismiss();
  }, [deferred, dismiss]);

  if (!visible || !deferred) return null;

  return (
    <div className="pwa-install-hint" role="status" aria-live="polite">
      <div className="pwa-install-hint-body">
        <p className="pwa-install-hint-title">放到主屏幕</p>
        <p className="pwa-install-hint-copy">像一本随时可翻的小本子，离线也能打开壳子。</p>
      </div>
      <div className="pwa-install-hint-actions">
        <button type="button" className="btn" onClick={install}>
          安装
        </button>
        <button type="button" className="btn secondary" onClick={dismiss}>
          先不用
        </button>
      </div>
    </div>
  );
}

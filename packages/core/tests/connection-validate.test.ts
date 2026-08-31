import { describe, expect, it } from "vitest";
import { validateConnectionInput } from "../src/connection-validate.ts";
import { SIYUAN_OFFICIAL_S3_CODE, SIYUAN_OFFICIAL_S3_MESSAGE } from "../src/errors.ts";

describe("validateConnectionInput", () => {
  it("obsidian requires name and bucket, applies defaults", () => {
    const r = validateConnectionInput({
      source: "obsidian",
      name: "vault",
      config: { bucket: "obsidian-src" },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.source).toBe("obsidian");
    expect(r.value.config.bucket).toBe("obsidian-src");
    expect(r.value.config.region).toBe("us-east-1");
    expect(r.value.config.remote_prefix).toBe("vault1");
    expect(r.value.config.ignore).toEqual([".obsidian/", ".trash/"]);
    expect(r.value.config.force_path_style).toBe(true);
    expect(r.value.status).toBe("active");
    expect(r.value.config).not.toHaveProperty("access_key");
  });

  it("obsidian e2ee marks encrypted_unreadable", () => {
    const r = validateConnectionInput({
      source: "obsidian",
      name: "enc",
      config: { bucket: "b", e2ee: true },
      secrets: { access_key: "ak", secret_key: "sk" },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.status).toBe("encrypted_unreadable");
    expect(r.value.secrets.access_key).toBe("ak");
    expect(r.value.config).not.toHaveProperty("secret_key");
  });

  it("siyuan mode A defaults kernel url", () => {
    const r = validateConnectionInput({
      source: "siyuan",
      name: "内核",
      mode: "api",
      secrets: { token: "t" },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.mode).toBe("api");
    expect(r.value.config.kernel_base_url).toBe("http://127.0.0.1:6806");
    expect(r.value.secrets.token).toBe("t");
    expect(r.value.config).not.toHaveProperty("token");
  });

  it("siyuan mode B requires bucket and workspace_prefix", () => {
    const r = validateConnectionInput({
      source: "siyuan",
      name: "明文",
      config: { mode: "workspace", bucket: "siyuan-src", workspace_prefix: "workspace" },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.mode).toBe("workspace");
    expect(r.value.config.workspace_prefix).toBe("workspace");
  });

  it("siyuan official S3 flag is rejected", () => {
    const r = validateConnectionInput({
      source: "siyuan",
      name: "官方",
      mode: "workspace",
      config: { official_s3: true, bucket: "b", workspace_prefix: "data" },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe(SIYUAN_OFFICIAL_S3_CODE);
    expect(r.message).toBe(SIYUAN_OFFICIAL_S3_MESSAGE);
  });

  it("siyuan workspace_prefix containing repo is rejected", () => {
    const r = validateConnectionInput({
      source: "siyuan",
      name: "官方前缀",
      mode: "workspace",
      config: { bucket: "b", workspace_prefix: "sync/repo/objects" },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe(SIYUAN_OFFICIAL_S3_CODE);
    expect(r.message).toBe(SIYUAN_OFFICIAL_S3_MESSAGE);
  });

  it("notion requires token", () => {
    const bad = validateConnectionInput({ source: "notion", name: "n" });
    expect(bad.ok).toBe(false);
    const r = validateConnectionInput({
      source: "notion",
      name: "n",
      config: { workspace_id: "ws" },
      secrets: { token: "ntn_x" },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.config.workspace_id).toBe("ws");
    expect(r.value.secrets.token).toBe("ntn_x");
    expect(r.value.config).not.toHaveProperty("token");
  });

  it("feishu requires app_id and app_secret, defaults obj_types", () => {
    const bad = validateConnectionInput({
      source: "feishu",
      name: "飞书",
      secrets: { app_id: "cli" },
    });
    expect(bad.ok).toBe(false);
    const r = validateConnectionInput({
      source: "feishu",
      name: "飞书",
      config: { wiki_space_id: "spc" },
      secrets: { app_id: "cli", app_secret: "sec" },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.config.obj_types).toEqual(["docx"]);
    expect(r.value.config.wiki_space_id).toBe("spc");
    expect(r.value.secrets.app_secret).toBe("sec");
    expect(r.value.config).not.toHaveProperty("app_secret");
  });
});

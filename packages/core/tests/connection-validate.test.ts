import { describe, expect, it } from "vitest";
import { mergeConnectionSecrets, validateConnectionInput } from "../src/connection-validate.ts";

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

  it("siyuan official S3 flag is allowed and copies repo_password into secrets", () => {
    const r = validateConnectionInput({
      source: "siyuan",
      name: "官方",
      mode: "workspace",
      config: { official_s3: true, bucket: "b", workspace_prefix: "workspace" },
      secrets: { access_key: "ak", secret_key: "sk", repo_password: "cangku" },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.config.official_s3).toBe(true);
    expect(r.value.secrets.repo_password).toBe("cangku");
    expect(r.value.config).not.toHaveProperty("repo_password");
  });

  it("siyuan workspace_prefix containing repo is allowed", () => {
    const r = validateConnectionInput({
      source: "siyuan",
      name: "官方前缀",
      mode: "workspace",
      config: { bucket: "b", workspace_prefix: "sync/repo/objects" },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.config.workspace_prefix).toBe("sync/repo/objects");
  });

  it("notion requires token or oauth access_token", () => {
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

    const oauth = validateConnectionInput({
      source: "notion",
      name: "n",
      secrets: { access_token: "ntn_oauth" },
    });
    expect(oauth.ok).toBe(true);
    if (!oauth.ok) return;
    expect(oauth.value.secrets.access_token).toBe("ntn_oauth");
    expect(oauth.value.config).not.toHaveProperty("access_token");
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

describe("mergeConnectionSecrets", () => {
  it("ignores blank incoming strings and does not wipe stored keys", () => {
    const merged = mergeConnectionSecrets(
      { access_key: "ak", secret_key: "sk", repo_password: "pw" },
      { access_key: "", secret_key: "  ", repo_password: "", token: "" },
    );
    expect(merged).toEqual({ access_key: "ak", secret_key: "sk", repo_password: "pw" });
  });

  it("updates only secrets the user actually typed", () => {
    const merged = mergeConnectionSecrets(
      { access_key: "ak", secret_key: "sk", repo_password: "old" },
      { repo_password: "new-pw", access_key: "" },
    );
    expect(merged.access_key).toBe("ak");
    expect(merged.secret_key).toBe("sk");
    expect(merged.repo_password).toBe("new-pw");
  });
});

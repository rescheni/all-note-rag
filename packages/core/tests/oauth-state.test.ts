import { describe, expect, it } from "vitest";
import { signOAuthState, verifyOAuthState } from "../src/oauth-state.ts";

const SECRET = "hub-oauth-test-secret";

describe("oauth state CSRF", () => {
  it("roundtrips a signed state", () => {
    const { state, nonce } = signOAuthState(
      { uid: "user-1", sid: "space-1", name: "我的 Notion" },
      SECRET,
    );
    const payload = verifyOAuthState(state, SECRET);
    expect(payload).not.toBeNull();
    expect(payload?.uid).toBe("user-1");
    expect(payload?.sid).toBe("space-1");
    expect(payload?.name).toBe("我的 Notion");
    expect(payload?.n).toBe(nonce);
    expect(state).not.toContain(SECRET);
  });

  it("rejects tampered payload, wrong secret, and expired state", () => {
    const { state } = signOAuthState({ uid: "u", sid: "s" }, SECRET);
    const [body, sig] = state.split(".");
    const tweaked = Buffer.from(body, "base64url").toString("utf8").replace('"u"', '"x"');
    const tampered = `${Buffer.from(tweaked).toString("base64url")}.${sig}`;
    expect(verifyOAuthState(tampered, SECRET)).toBeNull();
    expect(verifyOAuthState(state, "other-secret")).toBeNull();
    expect(verifyOAuthState("not-a-state", SECRET)).toBeNull();
    expect(verifyOAuthState("", SECRET)).toBeNull();

    const expired = signOAuthState({ uid: "u", sid: "s" }, SECRET, -30);
    expect(verifyOAuthState(expired.state, SECRET)).toBeNull();
  });
});

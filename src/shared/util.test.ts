import { describe, expect, it } from "vitest";

import { redactSecrets } from "./util.js";

describe("redactSecrets", () => {
  it("removes PEM private keys and bearer tokens", () => {
    const value = [
      "Authorization: Bearer abc123",
      "-----BEGIN RSA PRIVATE KEY-----",
      "secret-material",
      "-----END RSA PRIVATE KEY-----",
    ].join("\n");
    const redacted = redactSecrets(value);
    expect(redacted).toContain("Bearer [REDACTED]");
    expect(redacted).toContain("[REDACTED PRIVATE KEY]");
    expect(redacted).not.toContain("secret-material");
    expect(redacted).not.toContain("abc123");
  });
});

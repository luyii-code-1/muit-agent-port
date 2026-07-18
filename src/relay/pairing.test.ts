import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { PairingService } from "./pairing.js";
import { MeshStore } from "./store.js";

const tempDirs: string[] = [];
afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("PairingService", () => {
  it("issues a single-use code and persists only the node token hash", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-mesh-pairing-test-"));
    tempDirs.push(dir);
    const store = new MeshStore(join(dir, "mesh.db"));
    const service = new PairingService(store, "admin-token-at-least-16-chars");
    const pairing = service.createCode(10);
    const token = service.pairNode(pairing.code, "new-mac");
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect(store.getNodeTokenHash("new-mac")).toBe(createHash("sha256").update(token!).digest("hex"));
    expect(service.pairNode(pairing.code, "second-use")).toBeUndefined();
    store.close();
  });
});

import { createHash, createHmac, randomBytes, randomInt } from "node:crypto";

import type { MeshStore } from "./store.js";

export interface PairingCode {
  code: string;
  expiresAt: number;
}

export class PairingService {
  constructor(
    private readonly store: MeshStore,
    private readonly secret: string,
  ) {}

  createCode(ttlMinutes = 10): PairingCode {
    const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
    const expiresAt = Date.now() + ttlMinutes * 60_000;
    this.store.createPairingCode(this.hashCode(code), expiresAt);
    return { code, expiresAt };
  }

  pairNode(code: string, nodeId: string): string | undefined {
    if (!/^\d{6}$/.test(code) || !this.store.consumePairingCode(this.hashCode(code))) return undefined;
    const token = randomBytes(32).toString("hex");
    this.store.setNodeTokenHash(nodeId, createHash("sha256").update(token).digest("hex"));
    return token;
  }

  private hashCode(code: string): string {
    return createHmac("sha256", this.secret).update(code).digest("hex");
  }
}

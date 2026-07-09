import { randomBytes } from "node:crypto";
import type { SessionType } from "./types.js";

const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"; // no lookalikes

export function randomId(len = 4): string {
  const bytes = randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

export function sessionId(type: SessionType): string {
  return `${type}-${randomId(4)}`;
}

export function entityId(prefix: string): string {
  return `${prefix}-${randomId(6)}`;
}

export function sessionToken(): string {
  return randomBytes(24).toString("hex");
}

export function now(): string {
  return new Date().toISOString();
}

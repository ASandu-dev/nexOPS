import {
  createPublicKey,
  createHash,
  randomBytes,
  timingSafeEqual,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";

/** SHA-256 hex digest — the single stored form for tokens and credentials. */
export function sha256(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

/** 32 random bytes, base64url encoded — enrolment tokens and bearer credentials. */
export function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Constant-time string equality (length-safe). */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    // Still perform a comparison to keep timing uniform on length mismatch.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/**
 * Parses a base64 Ed25519 public key. Agents send the raw 32-byte key; PEM
 * SPKI is also accepted for tooling convenience.
 */
export function parseEd25519PublicKey(key: string): KeyObject | null {
  const trimmed = key.trim();
  if (trimmed.includes("BEGIN PUBLIC KEY")) {
    try {
      return createPublicKey(trimmed);
    } catch {
      return null;
    }
  }
  let raw: Buffer;
  try {
    raw = Buffer.from(trimmed, "base64");
  } catch {
    return null;
  }
  if (raw.length !== 32) return null;
  try {
    return createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: raw.toString("base64url") },
      format: "jwk",
    });
  } catch {
    return null;
  }
}

/**
 * Verifies an Ed25519 signature over `message`.
 * Returns false (never throws) for malformed keys or signatures.
 */
export function verifyEd25519(publicKeyB64: string, message: Buffer, signatureB64: string): boolean {
  const key = parseEd25519PublicKey(publicKeyB64);
  if (!key) return false;
  let signature: Buffer;
  try {
    signature = Buffer.from(signatureB64, "base64");
  } catch {
    return false;
  }
  if (signature.length !== 64) return false;
  try {
    return cryptoVerify(null, message, key, signature);
  } catch {
    return false;
  }
}

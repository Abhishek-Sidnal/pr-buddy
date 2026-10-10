import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_ID_LENGTH = 16;

/** A secret as it is stored: unreadable without the master key it was encrypted under. */
export interface EncryptedSecret {
  /** The encrypted secret followed by its authentication tag. */
  readonly ciphertext: Buffer;
  /** Random, and new for every encryption. */
  readonly nonce: Buffer;
  /** Identifies the master key that encrypted it. Not secret. */
  readonly keyId: string;
}

/**
 * Thrown when a stored secret cannot be decrypted: it was altered, belongs to another row, or
 * was encrypted under a master key that is no longer configured. The message says no more.
 */
export class SecretDecryptionError extends Error {
  constructor() {
    super("The stored secret could not be decrypted.");
    this.name = "SecretDecryptionError";
  }
}

/**
 * Encrypts and decrypts secrets that are stored for customers. `context` names the row a secret
 * belongs to; it is authenticated with the ciphertext, so a secret moved to another row does not
 * decrypt. A key service can implement this interface in place of a local master key.
 */
export interface SecretCipher {
  encrypt(plaintext: string, context: string): EncryptedSecret;
  /** @throws {SecretDecryptionError} */
  decrypt(secret: EncryptedSecret, context: string): string;
}

/** A short, stable name for a master key, safe to store beside what it encrypted. */
function keyIdOf(key: Buffer): string {
  return createHash("sha256")
    .update("pr-buddy-key-id")
    .update(key)
    .digest("hex")
    .slice(0, KEY_ID_LENGTH);
}

/** Decodes a master key given as base64. Returns `undefined` unless it is exactly 32 bytes. */
export function decodeMasterKey(encoded: string): Buffer | undefined {
  // Buffer.from ignores what is not base64, so the text is checked first.
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(encoded)) {
    return undefined;
  }
  const key = Buffer.from(encoded, "base64");
  return key.length === KEY_BYTES ? key : undefined;
}

/**
 * A cipher using AES-256-GCM with master keys held in memory. New secrets are encrypted under
 * `current`; `previous` keys can still decrypt, which is what lets the master key be rotated.
 */
export function createLocalSecretCipher(
  current: Buffer,
  previous: readonly Buffer[] = [],
): SecretCipher {
  const keys = new Map([current, ...previous].map((key) => [keyIdOf(key), key]));
  const currentId = keyIdOf(current);

  return {
    encrypt(plaintext, context) {
      const nonce = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv(ALGORITHM, current, nonce);
      cipher.setAAD(Buffer.from(context, "utf8"));
      const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return {
        ciphertext: Buffer.concat([encrypted, cipher.getAuthTag()]),
        nonce,
        keyId: currentId,
      };
    },

    decrypt(secret, context) {
      const key = keys.get(secret.keyId);
      if (
        key === undefined ||
        secret.nonce.length !== NONCE_BYTES ||
        secret.ciphertext.length < TAG_BYTES
      ) {
        throw new SecretDecryptionError();
      }
      const body = secret.ciphertext.subarray(0, -TAG_BYTES);
      const tag = secret.ciphertext.subarray(-TAG_BYTES);
      try {
        const decipher = createDecipheriv(ALGORITHM, key, secret.nonce);
        decipher.setAAD(Buffer.from(context, "utf8"));
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
      } catch {
        throw new SecretDecryptionError();
      }
    },
  };
}

import { createHmac, timingSafeEqual } from "node:crypto";

const SIGNATURE_PREFIX = "sha256=";
const HEX_SHA256 = /^[0-9a-f]{64}$/;

/**
 * Checks GitHub's `X-Hub-Signature-256` header: an HMAC-SHA256 of the raw request body, keyed
 * with the webhook secret. The body must be the bytes as received; a re-serialised JSON body
 * would not match. The comparison is constant-time.
 */
export function verifyWebhookSignature(
  secret: string,
  rawBody: Uint8Array,
  signatureHeader: string | undefined,
): boolean {
  if (signatureHeader?.startsWith(SIGNATURE_PREFIX) !== true) {
    return false;
  }
  const received = signatureHeader.slice(SIGNATURE_PREFIX.length);
  if (!HEX_SHA256.test(received)) {
    return false;
  }
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  return timingSafeEqual(expected, Buffer.from(received, "hex"));
}

/** Computes the header value GitHub would send for a body. Useful for tests and tooling. */
export function signWebhookBody(secret: string, rawBody: Uint8Array | string): string {
  return SIGNATURE_PREFIX + createHmac("sha256", secret).update(rawBody).digest("hex");
}

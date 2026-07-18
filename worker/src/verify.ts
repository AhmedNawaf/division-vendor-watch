/**
 * Verify a Discord interaction request signature (Ed25519 over `timestamp + body`).
 * Discord requires every interactions webhook to reject unsigned/invalid requests with 401,
 * so this runs before any routing. Uses WebCrypto, which is available in Workers.
 */

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export async function verifyInteractionSignature(
  publicKeyHex: string,
  signatureHex: string,
  timestamp: string,
  body: string,
): Promise<boolean> {
  if (!signatureHex || !timestamp) return false;
  let key: CryptoKey;
  let signature: Uint8Array;
  try {
    key = await crypto.subtle.importKey(
      "raw",
      hexToBytes(publicKeyHex),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    signature = hexToBytes(signatureHex);
  } catch {
    return false;
  }
  const message = new TextEncoder().encode(timestamp + body);
  try {
    return await crypto.subtle.verify({ name: "Ed25519" }, key, signature, message);
  } catch {
    return false;
  }
}

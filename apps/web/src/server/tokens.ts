const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

export function generateToken(prefix: string, bytes = 24): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let out = "";
  for (const b of buf) out += ALPHABET[b % ALPHABET.length];
  return `${prefix}${out}`;
}

export function generateConnectCode(): string {
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (const b of buf) s += chars[b % chars.length];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

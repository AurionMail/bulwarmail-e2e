import type { Email } from "@/lib/jmap/types";

// Restrict filenames to ASCII letters/digits and a small set of safe
// punctuation. Everything else collapses to `_`. Keeps names predictable
// across Windows/macOS/Linux file systems and avoids emoji/RTL/zero-width
// surprises in subject lines.
const SAFE_CHARS = /[^A-Za-z0-9 _\-().,!@#&+=[\]{}']/g;

function sanitizePart(input: string, maxLen: number): string {
  const cleaned = input
    .replace(SAFE_CHARS, "_")
    .replace(/_+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[._-]+|[._-]+$/g, "");
  return cleaned.slice(0, maxLen);
}

function formatDate(iso: string | null | undefined): string {
  const d = iso ? new Date(iso) : new Date();
  if (Number.isNaN(d.getTime())) return "0000-00-00 00.00.00";
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}`
  );
}

function addressLabel(addr: { name?: string | null; email: string } | undefined, maxLen = 30): string {
  if (!addr) return "unknown";
  const raw = (addr.name && addr.name.trim()) || addr.email.split("@")[0] || addr.email;
  return sanitizePart(raw, maxLen) || "unknown";
}

// Produce `YYYY-MM-DD HH.mm.SS (from-to) subject.eml`. All components are
// sanitized to ASCII-safe filename characters.
export function emailExportFilename(email: Email): string {
  const date = formatDate(email.receivedAt || email.sentAt);
  const from = addressLabel(email.from?.[0]);
  const to = addressLabel(email.to?.[0]);
  const subject = sanitizePart(email.subject || "no subject", 80) || "no subject";
  return `${date} (${from}-${to}) ${subject}.eml`;
}

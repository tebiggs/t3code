const LOOPBACK_URL = /^https?:\/\/(?:127\.0\.0\.1|localhost):(\d+)\/?$/;

/** The port of a server on this phone's loopback, or null for any other environment. */
export function phoneServerPort(displayUrl: string): number | null {
  const match = LOOPBACK_URL.exec(displayUrl.trim());
  return match ? Number(match[1]) : null;
}

import { lookup } from 'node:dns/promises';
import net from 'node:net';

const ALLOW_PRIVATE = process.env.ALLOW_PRIVATE_URLS === 'true';

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith('::ffff:')) return isPrivateIp(v6.slice(7));
  return v6 === '::1' || v6 === '::' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80');
}

/** Hostnames that must never be reached, whatever DNS says. */
export function isBlockedHostname(hostname: string): boolean {
  if (ALLOW_PRIVATE) return false;
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal') || h.endsWith('.local')) return true;
  if (net.isIP(h)) return isPrivateIp(h);
  return false;
}

/** Validates the product URL the user gave. Throws a readable error when it is not allowed. */
export async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error('That does not look like a valid link. Use the full address, like https://your-website.com');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only http and https links can be tested.');
  if (url.username || url.password) throw new Error('Remove the username and password from the link and add them as a test login instead.');
  if (ALLOW_PRIVATE) return url;
  if (isBlockedHostname(url.hostname)) throw new Error('Local and private addresses cannot be tested from this server.');
  try {
    const addrs = await lookup(url.hostname, { all: true });
    if (addrs.some((a) => isPrivateIp(a.address))) throw new Error('This address points to a private network and cannot be tested from this server.');
  } catch (e) {
    if (e instanceof Error && e.message.includes('private')) throw e;
    throw new Error(`Could not find ${url.hostname}. Check the link and try again.`);
  }
  return url;
}

/** Removes secrets from any text before it is shown, logged or written to a file. */
export function maskSecrets(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 3) out = out.split(s).join('••••••');
  }
  return out;
}

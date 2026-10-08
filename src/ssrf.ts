import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { BlockList, isIP } from 'node:net';
import { Agent } from 'undici';

/**
 * Your customers give you a URL and your servers make requests to it. Without
 * a guard, "https://169.254.169.254/latest/meta-data/" is a perfectly valid
 * webhook URL, and your dispatcher will happily fetch your cloud credentials.
 */
const blocked = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) {
  blocked.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [['::', 96], ['fc00::', 7], ['fe80::', 10]] as const) {
  blocked.addSubnet(network, prefix, 'ipv6');
}

export function isPrivateAddress(address: string): boolean {
  // ::ffff:127.0.0.1 is 127.0.0.1 wearing an IPv6 costume. Unwrap it first.
  const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) return isPrivateAddress(mapped[1]!);
  const family = isIP(address);
  if (family === 0) return false;
  return blocked.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeUrlError';
  }
}

/** Cheap checks when the customer registers the URL. The real check happens at connect time. */
export function assertAcceptableUrl(raw: string, options: { allowHttp?: boolean } = {}): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError('Not a valid URL');
  }
  if (url.protocol !== 'https:' && !(options.allowHttp && url.protocol === 'http:')) {
    throw new UnsafeUrlError('Webhook URLs must use https');
  }
  if (url.username || url.password) throw new UnsafeUrlError('No credentials in webhook URLs');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) && isPrivateAddress(host)) throw new UnsafeUrlError(`${host} is a private address`);
  return url;
}

/**
 * An HTTP agent that refuses to connect to private addresses. The check runs
 * on the IP the socket actually connects to, after DNS, so a hostname that
 * resolves to 10.0.0.5 (or flips to it later: DNS rebinding) is caught too.
 */
export function createSafeAgent(options: { allowPrivate?: boolean; connectTimeoutMs?: number } = {}): Agent {
  return new Agent({
    connect: {
      timeout: options.connectTimeoutMs ?? 5_000,
      lookup(hostname, lookupOptions, callback) {
        dnsLookup(hostname, { ...lookupOptions, all: true }, (err, addresses) => {
          if (err) return callback(err, [] as LookupAddress[]);
          const list = addresses as LookupAddress[];
          const unsafe = list.find((a) => isPrivateAddress(a.address));
          if (unsafe && !options.allowPrivate) {
            return callback(new UnsafeUrlError(`${hostname} resolves to private address ${unsafe.address}`), [] as LookupAddress[]);
          }
          // Node asks for every address when it tries IPv4 and IPv6 side by side; hand back what it asked for.
          if ((lookupOptions as { all?: boolean }).all) return callback(null, list);
          const first = list[0]!;
          return (callback as unknown as (e: null, address: string, family: number) => void)(null, first.address, first.family);
        });
      },
    },
  });
}

/**
 * Outbound requests to addresses a user can influence (search results, DOIs,
 * later: user-supplied source URLs) must never reach this server's private
 * network or the cloud metadata service.
 *
 * Three layers, each closing what the one before cannot:
 *
 * 1. `isPublicUrl` — the URL as written: scheme, `localhost`, and IP literals
 *    in every notation (IPv4, IPv6, IPv4-mapped, NAT64, 6to4).
 * 2. Redirects are followed by hand and every hop is checked again. `fetch`
 *    with `redirect: 'follow'` checked the first URL only, so a public page
 *    answering 302 → http://169.254.169.254/ was fetched.
 * 3. `guardedDispatcher` validates the address at **connect time**, inside the
 *    DNS lookup the socket actually uses. Checking a name before the request
 *    leaves a window in which the name can resolve differently (DNS
 *    rebinding); checking the address being connected to leaves none.
 */

import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { isIP } from 'node:net';

import { Agent, type Dispatcher } from 'undici';

/* -------------------------------------------------------------------------- */
/*                              Address classes                               */
/* -------------------------------------------------------------------------- */

function ipv4ToInt(address: string): number | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

/** [network, prefix length] blocks that are not the public internet. */
const PRIVATE_V4: [string, number][] = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, incl. cloud metadata 169.254.169.254
  ['172.16.0.0', 12],
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16],
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, incl. broadcast
];

export function isPublicIpv4(address: string): boolean {
  const value = ipv4ToInt(address);
  if (value === null) return false;
  return !PRIVATE_V4.some(([network, bits]) => {
    const base = ipv4ToInt(network) as number;
    const size = 2 ** (32 - bits);
    return value >= base && value < base + size;
  });
}

/** The eight 16-bit groups of an IPv6 address, or null. Handles `::` and a dotted IPv4 tail. */
function ipv6Groups(address: string): number[] | null {
  let text = address.toLowerCase();
  const zone = text.indexOf('%');
  if (zone >= 0) text = text.slice(0, zone);

  /* A dotted IPv4 tail (::ffff:10.0.0.1) becomes two groups. */
  const dotted = text.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const v4 = ipv4ToInt(dotted[2] as string);
    if (v4 === null) return null;
    text = `${dotted[1]}${Math.floor(v4 / 65536).toString(16)}:${(v4 % 65536).toString(16)}`;
  }

  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 && missing !== 0) return null;
  if (missing < 0) return null;

  const groups = [...head, ...new Array(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  if (groups.length !== 8) return null;
  const numbers = groups.map((group) => (/^[0-9a-f]{1,4}$/.test(group) ? parseInt(group, 16) : Number.NaN));
  return numbers.some(Number.isNaN) ? null : numbers;
}

const v4FromGroups = (high: number, low: number) =>
  `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;

export function isPublicIpv6(address: string): boolean {
  const g = ipv6Groups(address);
  if (!g) return false;
  const [a, b, c, d, e, f, g6, h] = g as [number, number, number, number, number, number, number, number];

  if (g.every((x) => x === 0)) return false; // ::
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0 && g6 === 0 && h === 1) return false; // ::1

  /* Embedded IPv4: the IPv4 rules decide. */
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0xffff) return isPublicIpv4(v4FromGroups(g6, h)); // ::ffff:a.b.c.d
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0) return isPublicIpv4(v4FromGroups(g6, h)); // ::a.b.c.d (deprecated)
  if (a === 0x64 && b === 0xff9b && c === 0 && d === 0 && e === 0 && f === 0) return isPublicIpv4(v4FromGroups(g6, h)); // NAT64
  if (a === 0x2002) return isPublicIpv4(v4FromGroups(b, c)); // 6to4

  if ((a & 0xfe00) === 0xfc00) return false; // fc00::/7 unique local
  if ((a & 0xffc0) === 0xfe80) return false; // fe80::/10 link-local
  if ((a & 0xffc0) === 0xfec0) return false; // fec0::/10 site-local (deprecated)
  if ((a & 0xff00) === 0xff00) return false; // multicast
  if (a === 0x2001 && b === 0x0db8) return false; // documentation
  if (a === 0x0100 && b === 0 && c === 0 && d === 0) return false; // discard-only 100::/64

  return true;
}

export function isPublicIp(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isPublicIpv4(address);
  if (version === 6) return isPublicIpv6(address);
  return false;
}

/* -------------------------------------------------------------------------- */
/*                                   URLs                                     */
/* -------------------------------------------------------------------------- */

/**
 * Whether a URL may be fetched, judged on the URL as written.
 *
 * The WHATWG parser already normalises the odd IPv4 notations
 * (`http://2130706433/`, `http://0x7f.1/`) to dotted form and puts IPv6 in
 * brackets, so the literal checks below see canonical addresses.
 */
export function isPublicUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
  if (parsed.username || parsed.password) return false;

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host.length === 0) return false;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return false;
  }
  if (host === 'metadata.google.internal') return false;

  if (isIP(host)) return isPublicIp(host);
  return true;
}

/* -------------------------------------------------------------------------- */
/*                         Connect-time address check                         */
/* -------------------------------------------------------------------------- */

export class BlockedAddressError extends Error {
  constructor(readonly hostname: string, readonly address: string) {
    super(`refused to connect to non-public address for ${hostname}`);
    this.name = 'BlockedAddressError';
  }
}

type LookupCallback = (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/**
 * A `dns.lookup` replacement that refuses non-public results.
 *
 * Every resolved address must be public: a name resolving to both a public and
 * a private address is refused, because which one a connection reaches is not
 * something this can control.
 */
export function guardedLookup(
  hostname: string,
  options: { all?: boolean; family?: number } | number | undefined,
  callback: LookupCallback,
): void {
  const opts = typeof options === 'object' && options ? options : {};
  dnsLookup(hostname, { ...opts, all: true }, (error, addresses) => {
    if (error) return callback(error, []);
    const list = addresses as LookupAddress[];
    const blocked = list.find((entry) => !isPublicIp(entry.address));
    if (list.length === 0 || blocked) {
      return callback(new BlockedAddressError(hostname, blocked?.address ?? 'none') as NodeJS.ErrnoException, []);
    }
    if (opts.all) return callback(null, list);
    const first = list[0] as LookupAddress;
    return callback(null, first.address, first.family);
  });
}

let dispatcher: Dispatcher | null = null;

/** An undici Agent whose every connection goes through `guardedLookup`. */
export function guardedDispatcher(): Dispatcher {
  dispatcher ??= new Agent({
    connect: { lookup: guardedLookup as never, timeout: 8_000 },
    headersTimeout: 10_000,
    bodyTimeout: 15_000,
  });
  return dispatcher;
}

/* -------------------------------------------------------------------------- */
/*                         Fetch with checked redirects                       */
/* -------------------------------------------------------------------------- */

export const MAX_REDIRECTS = 5;

export type Fetcher = (url: string, init: { redirect: 'manual'; signal?: AbortSignal; headers?: Record<string, string> }) => Promise<Response>;

/**
 * Fetches a URL, following redirects by hand and checking every hop.
 *
 * Returns `null` when any hop is refused. `fetcher` is injectable for tests;
 * by default it is undici's fetch through the guarded dispatcher.
 */
export async function guardedFetch(
  url: string,
  init: { signal?: AbortSignal; headers?: Record<string, string> } = {},
  fetcher?: Fetcher,
): Promise<{ response: Response; finalUrl: string } | null> {
  const run: Fetcher =
    fetcher ??
    (async (target, options) => {
      const { fetch: undiciFetch } = await import('undici');
      return (await undiciFetch(target, { ...options, dispatcher: guardedDispatcher() } as never)) as unknown as Response;
    });

  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (!isPublicUrl(current)) return null;

    let response: Response;
    try {
      response = await run(current, { ...init, redirect: 'manual' });
    } catch (error) {
      if (error instanceof BlockedAddressError || (error as { cause?: unknown })?.cause instanceof BlockedAddressError) return null;
      throw error;
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await response.body?.cancel().catch(() => undefined);
      if (!location) return null;
      current = new URL(location, current).toString();
      continue;
    }

    return { response, finalUrl: current };
  }

  return null;
}

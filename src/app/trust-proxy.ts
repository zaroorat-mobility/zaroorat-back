import { isIP } from 'node:net';

/// Which peers' `X-Forwarded-For` Fastify may believe — and therefore what `request.ip`
/// is for audit rows and rate limits. Trusting more than the real topology lets any
/// client choose the IP recorded against its actions; trusting less makes every client
/// look like the proxy. So the topology is declared, never assumed:
///
///   TRUSTED_PROXIES     comma-separated addresses / CIDRs of the proxies in front of the
///                       API (preferred: only those exact peers are believed), or the
///                       proxy-addr names `loopback`, `linklocal`, `uniquelocal`;
///   TRUSTED_PROXY_HOPS  a count of proxy hops in front of the API; 0 trusts none;
///   neither             trust nothing — `request.ip` is the socket peer.
///
/// The authenticated actor never comes from here: it is the JWT subject.
export type TrustProxySetting = boolean | number | string[];

const NAMED_RANGES = new Set(['loopback', 'linklocal', 'uniquelocal']);

function isAddressOrCidr(entry: string): boolean {
  if (NAMED_RANGES.has(entry)) return true;
  const [address, prefix, ...rest] = entry.split('/');
  if (rest.length > 0 || !address) return false;
  const family = isIP(address);
  if (family === 0) return false;
  if (prefix === undefined) return true;
  const bits = Number(prefix);
  return Number.isInteger(bits) && bits >= 0 && bits <= (family === 4 ? 32 : 128);
}

export function resolveTrustProxy(env: NodeJS.ProcessEnv): TrustProxySetting {
  const proxies = (env.TRUSTED_PROXIES ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (proxies.length > 0) {
    const invalid = proxies.filter((entry) => !isAddressOrCidr(entry));
    if (invalid.length > 0) {
      throw new Error(`TRUSTED_PROXIES has invalid entries: ${invalid.join(', ')}`);
    }
    return proxies;
  }

  const hops = env.TRUSTED_PROXY_HOPS?.trim();
  if (hops) {
    const count = Number(hops);
    if (!Number.isInteger(count) || count < 0) {
      throw new Error(`TRUSTED_PROXY_HOPS must be a non-negative integer, got "${hops}"`);
    }
    return count === 0 ? false : count;
  }
  return false;
}

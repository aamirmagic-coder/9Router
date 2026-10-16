import dns from "dns";

// Force public DNS to bypass OS negative cache (mDNSResponder holds NXDOMAIN)
let resolver = null;
try {
  if (dns?.promises?.Resolver) {
    resolver = new dns.promises.Resolver();
    if (typeof resolver.setServers === "function") {
      resolver.setServers(["1.1.1.1", "1.0.0.1", "8.8.8.8"]);
    }
  }
} catch {
  resolver = null;
}

// Try custom public DNS first, fall back to OS resolver
// (Cloudflare DNS may not resolve all hostnames, e.g. *.ts.net)
export async function resolveDns(hostname, timeoutMs) {
  const tryResolver = (fn) => Promise.race([
    fn(),
    new Promise((_, rej) => setTimeout(() => rej(new Error("dns timeout")), timeoutMs)),
  ]).then(() => true).catch(() => false);

  if (resolver && typeof resolver.resolve4 === "function") {
    try {
      if (await tryResolver(() => resolver.resolve4(hostname))) return true;
    } catch {
      // fallback to OS resolver
    }
  }
  if (dns?.promises?.resolve4) {
    return tryResolver(() => dns.promises.resolve4(hostname));
  }
  return false;
}

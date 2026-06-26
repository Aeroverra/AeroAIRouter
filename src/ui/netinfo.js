import { networkInterfaces, hostname } from "os";

// Tailscale assigns addresses in the 100.64.0.0/10 CGNAT range.
function isTailscale(ip) {
  const m = ip.match(/^100\.(\d+)\./);
  if (!m) return false;
  const second = parseInt(m[1], 10);
  return second >= 64 && second <= 127;
}

// Enumerate all non-internal IPv4 addresses, classified.
export function listAddresses() {
  const out = [];
  const ifaces = networkInterfaces();
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const a of addrs || []) {
      if (a.family !== "IPv4" || a.internal) continue;
      out.push({
        iface: name,
        address: a.address,
        kind: isTailscale(a.address) ? "tailscale" : "lan",
      });
    }
  }
  // Tailscale first, then LAN, for nicer display.
  out.sort((x, y) => (x.kind === y.kind ? 0 : x.kind === "tailscale" ? -1 : 1));
  return out;
}

export function accessUrls(port) {
  const urls = listAddresses().map((a) => ({
    kind: a.kind,
    iface: a.iface,
    url: "http://" + a.address + ":" + port,
  }));
  urls.unshift({ kind: "local", iface: "loopback", url: "http://localhost:" + port });
  return urls;
}

// Best-effort mDNS advertisement (.local). bonjour-service is an optional dep;
// if it isn't installed, this silently does nothing.
export async function advertiseMdns(port) {
  try {
    const mod = await import("bonjour-service").catch(() => null);
    if (!mod) return null;
    const Bonjour = mod.default || mod.Bonjour || mod;
    const instance = typeof Bonjour === "function" ? new Bonjour() : new mod.Bonjour();
    const name = "AeroAIRouter (" + hostname() + ")";
    instance.publish({ name, type: "http", port, txt: { path: "/" } });
    return instance;
  } catch {
    return null;
  }
}

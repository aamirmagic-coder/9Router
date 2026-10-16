import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock DNS lookup so we control which host resolves to what IP.
// The product calls lookup(host, { all: true }), which resolves to an ARRAY of
// records: a single-object mock makes every lookup fail closed, so the SSRF
// cases below would pass even with no IP filtering at all.
const lookupMock = vi.fn();
vi.mock("node:dns/promises", () => ({ lookup: (...a) => lookupMock(...a) }));

import { fetchImageAsBase64 } from "../../open-sse/translator/concerns/image.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const resolvesTo = (...addresses) =>
  lookupMock.mockResolvedValue(addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })));

function mockFetchOnce(bytes, ok = true) {
  const body = {
    getReader() {
      let sent = false;
      return {
        read: async () => sent ? { done: true } : (sent = true, { done: false, value: new Uint8Array(bytes) }),
        cancel: async () => {},
      };
    },
  };
  globalThis.fetch = vi.fn(async () => ({ ok, body }));
}

beforeEach(() => {
  lookupMock.mockReset();
  resolvesTo("93.184.216.34"); // public by default
});
afterEach(() => { vi.restoreAllMocks(); });

describe("fetchImageAsBase64 hardening", () => {
  it("rejects non-http url", async () => {
    expect(await fetchImageAsBase64("ftp://x/y.png")).toBeNull();
    expect(await fetchImageAsBase64("data:image/png;base64,xx")).toBeNull();
  });

  it("SSRF: rejects blocked hostname localhost", async () => {
    mockFetchOnce(PNG);
    expect(await fetchImageAsBase64("http://localhost/x.png")).toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  // Each case would return a PNG if the IP filter were missing: the fetch mock
  // serves a valid image, so only the private-IP check can make it null.
  it.each([
    ["private 10.x", "10.0.0.5"],
    ["cloud metadata", "169.254.169.254"],
    ["IPv4 loopback", "127.0.0.1"],
    ["IPv6 loopback", "::1"],
    ["IPv6 unspecified", "::"],
    ["IPv6 unique-local", "fd00::1"],
    ["IPv6 link-local", "fe80::1"],
    ["IPv4-mapped loopback", "::ffff:127.0.0.1"],
    ["IPv4-mapped loopback (hex)", "::ffff:7f00:1"],
    ["NAT64", "64:ff9b::a00:1"],
    ["benchmarking 198.18/15", "198.18.0.1"],
    ["multicast", "224.0.0.1"],
    ["broadcast", "255.255.255.255"],
  ])("SSRF: rejects %s (%s) without fetching", async (_label, address) => {
    resolvesTo(address);
    mockFetchOnce(PNG);
    expect(await fetchImageAsBase64("http://internal.example/x.png")).toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("SSRF: rejects when ANY resolved record is private (multi-A trick)", async () => {
    resolvesTo("93.184.216.34", "10.0.0.5");
    mockFetchOnce(PNG);
    expect(await fetchImageAsBase64("http://mixed.example/x.png")).toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("accepts valid PNG from public host", async () => {
    mockFetchOnce(PNG);
    const r = await fetchImageAsBase64("https://example.com/a.png");
    expect(r).not.toBeNull();
    expect(r.mimeType).toBe("image/png");
    expect(r.url.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("does not follow redirects (public URL redirecting to a private one)", async () => {
    mockFetchOnce(PNG);
    await fetchImageAsBase64("https://example.com/a.png");
    expect(globalThis.fetch.mock.calls[0][1].redirect).toBe("manual");
  });

  it("rejects disguised non-image payload (magic byte mismatch)", async () => {
    mockFetchOnce(Buffer.from("<?php system($_GET[c]); ?>"));
    expect(await fetchImageAsBase64("https://example.com/evil.png")).toBeNull();
  });

  it("rejects payload over size cap", async () => {
    mockFetchOnce(Buffer.alloc(1024));
    expect(await fetchImageAsBase64("https://example.com/big.png", { maxBytes: 100 })).toBeNull();
  });

  it("returns null when fetch not ok", async () => {
    mockFetchOnce(PNG, false);
    expect(await fetchImageAsBase64("https://example.com/404.png")).toBeNull();
  });
});

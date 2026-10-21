/**
 * HTTP/2 client sessions, optionally tunneled through an HTTP CONNECT or SOCKS proxy.
 *
 * Node's http2.connect() is a direct TCP/TLS connection and ignores HTTP_PROXY.
 * Cursor's AgentService (GetUsableModels and Run) is HTTP/2-only, so we must
 * keep h2 and tunnel it: CONNECT (or SOCKS) → TLS(ALPN=h2) → http2 session.
 */

import net from "net";
import tls from "tls";
import http2 from "http2";

function waitForHttp2Session(client, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (client.destroyed) {
      reject(new Error("HTTP/2 session destroyed"));
      return;
    }
    if (!client.connecting) {
      resolve(client);
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("HTTP/2 session connect timed out"));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      client.off("connect", onConnect);
      client.off("error", onError);
    };
    const onConnect = () => {
      cleanup();
      resolve(client);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    client.once("connect", onConnect);
    client.once("error", onError);
  });
}

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_CONNECT_HEADER_BYTES = 64 * 1024;
const SOCKS_PROTOCOLS = new Set(["socks:", "socks4:", "socks4a:", "socks5:", "socks5h:"]);

export function isSocksProxyUrl(proxyUrl) {
  try {
    return SOCKS_PROTOCOLS.has(new URL(proxyUrl).protocol);
  } catch {
    return false;
  }
}

export function buildHttpConnectRequest(targetHost, targetPort, proxyUrl) {
  const proxy = new URL(proxyUrl);
  let auth = "";
  if (proxy.username || proxy.password) {
    const user = decodeURIComponent(proxy.username || "");
    const pass = decodeURIComponent(proxy.password || "");
    auth = `Proxy-Authorization: Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}\r\n`;
  }
  return (
    `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n` +
    `Host: ${targetHost}:${targetPort}\r\n` +
    auth +
    `\r\n`
  );
}

async function connectViaHttpProxy(proxyUrl, targetHost, targetPort, timeoutMs) {
  const proxy = new URL(proxyUrl);
  if (proxy.protocol !== "http:" && proxy.protocol !== "https:") {
    throw new Error(`Unsupported proxy protocol: ${proxy.protocol}`);
  }
  const proxyPort = Number(proxy.port) || (proxy.protocol === "https:" ? 443 : 80);

  return new Promise((resolve, reject) => {
    const options = { host: proxy.hostname, port: proxyPort };
    const socket = proxy.protocol === "https:"
      ? tls.connect({ ...options, servername: proxy.hostname, ALPNProtocols: ["http/1.1"] })
      : net.connect(options);
    let settled = false;
    let buf = Buffer.alloc(0);

    const cleanup = () => {
      socket.setTimeout(0);
      socket.off("error", fail);
      socket.off("timeout", onTimeout);
      socket.off("close", onClose);
      socket.off("data", onData);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const onTimeout = () => fail(new Error("Proxy CONNECT timed out"));
    const onClose = () => fail(new Error("Proxy CONNECT closed before response headers"));
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const headerEnd = buf.indexOf("\r\n\r\n");
      if (headerEnd === -1) {
        if (buf.length > MAX_CONNECT_HEADER_BYTES) {
          fail(new Error("Proxy CONNECT response headers too large"));
        }
        return;
      }
      if (headerEnd + 4 > MAX_CONNECT_HEADER_BYTES) {
        fail(new Error("Proxy CONNECT response headers too large"));
        return;
      }
      const statusLineEnd = buf.indexOf("\r\n");
      const statusLine = buf.subarray(0, statusLineEnd).toString("latin1");
      const code = Number(statusLine.split(" ")[1]);
      if (code !== 200) {
        fail(new Error(`Proxy CONNECT failed: ${statusLine.trim()}`));
        return;
      }
      const leftover = buf.subarray(headerEnd + 4);
      if (leftover.length) socket.unshift(leftover);
      settled = true;
      cleanup();
      resolve(socket);
    };

    socket.once("error", fail);
    socket.once("timeout", onTimeout);
    socket.once("close", onClose);
    socket.setTimeout(timeoutMs);
    socket.once(proxy.protocol === "https:" ? "secureConnect" : "connect", () => {
      socket.setNoDelay(true);
      socket.write(buildHttpConnectRequest(targetHost, targetPort, proxyUrl));
    });
    socket.on("data", onData);
  });
}

async function connectViaSocks(proxyUrl, targetHost, targetPort, timeoutMs) {
  const { SocksProxyAgent } = await import("socks-proxy-agent");
  const agent = new SocksProxyAgent(proxyUrl, { timeout: timeoutMs });
  let socket;
  const req = {
    destroy() { socket?.destroy(); },
    protocol: "http:",
    host: targetHost,
    port: Number(targetPort),
    path: `${targetHost}:${targetPort}`,
    method: "CONNECT",
  };
  const opts = {
    host: targetHost,
    port: Number(targetPort),
    secureEndpoint: false,
  };
  if (typeof agent.connect !== "function") {
    throw new Error("SOCKS agent does not expose connect()");
  }
  socket = await agent.connect(req, opts);
  // The agent's timeout is for setup, not an idle limit on the h2 tunnel.
  socket.setTimeout(0);
  return socket;
}

async function createProxiedTlsSocket(proxyUrl, targetHost, targetPort, timeoutMs) {
  const plain = isSocksProxyUrl(proxyUrl)
    ? await connectViaSocks(proxyUrl, targetHost, targetPort, timeoutMs)
    : await connectViaHttpProxy(proxyUrl, targetHost, targetPort, timeoutMs);

  return new Promise((resolve, reject) => {
    const tlsSocket = tls.connect({
      socket: plain,
      servername: targetHost,
      ALPNProtocols: ["h2"],
    });
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      tlsSocket.off("error", onError);
      tlsSocket.off("close", onClose);
      if (error) {
        tlsSocket.destroy();
        reject(error);
      } else {
        tlsSocket.setNoDelay(true);
        resolve(tlsSocket);
      }
    };
    const onError = (error) => finish(error);
    const onClose = () => finish(new Error("TLS connection through proxy closed during handshake"));
    const timer = setTimeout(
      () => finish(new Error("TLS handshake through proxy timed out")),
      timeoutMs,
    );
    tlsSocket.once("secureConnect", () => {
      if (tlsSocket.alpnProtocol !== "h2") {
        finish(new Error(`TLS peer did not negotiate h2 via ALPN (got ${tlsSocket.alpnProtocol || "none"})`));
        return;
      }
      finish();
    });
    tlsSocket.once("error", onError);
    tlsSocket.once("close", onClose);
  });
}

/**
 * Open an HTTP/2 client session to `url`.
 * When `proxyUrl` is set (http://, https://, socks5://, …), tunnel via CONNECT/SOCKS.
 */
export async function connectHttp2(url, { proxyUrl, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const urlObj = new URL(url);
  const host = urlObj.hostname;
  const port = Number(urlObj.port) || 443;
  const authority = `https://${host}${urlObj.port ? `:${urlObj.port}` : ""}`;

  if (!proxyUrl) {
    const client = http2.connect(authority);
    try {
      return await waitForHttp2Session(client, timeoutMs);
    } catch (error) {
      try { client.close(); } catch {}
      throw error;
    }
  }

  const tlsSocket = await createProxiedTlsSocket(proxyUrl, host, port, timeoutMs);
  const client = http2.connect(authority, {
    createConnection: () => tlsSocket,
  });
  const destroySocket = () => {
    try { tlsSocket.destroy(); } catch {}
  };
  client.once("close", destroySocket);
  client.once("error", destroySocket);
  try {
    return await waitForHttp2Session(client, timeoutMs);
  } catch (error) {
    try { client.close(); } catch {}
    destroySocket();
    throw error;
  }
}

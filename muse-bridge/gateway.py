"""Muse personal-gateway protocol client: HTTPS + Noise XX + protobuf.

Protocol notes and the framing model are documented in muse-cli
(github.com/nikships/muse-cli, MIT) — that project derived this gateway
protocol from the muse.ai web bundle. This file is a trimmed port used by
the 9router `muse-ai` provider bridge; the licence notice sits in README.md.

Everything that touches the network runs through curl_cffi with
impersonate="chrome". That is not cosmetic. The edge in front of the
personal VM resets a plain TLS handshake, and hatch.metaaivm.com only
answers a browser-like ClientHello. A protocol-correct Node client is
still refused for exactly this reason (verified: our Node Noise XX
handshake matched the reference byte for byte and was still cut), which
is why the 9router side delegates transport to this process instead of
reimplementing it in JavaScript.
"""
import json
import os
import struct
import threading
import time
import urllib.parse
import uuid

from curl_cffi import requests as rq
from curl_cffi.requests import WebSocket
from noise.connection import Keypair, NoiseConnection
from google.protobuf import descriptor_pb2, descriptor_pool, message_factory

_HERE = os.path.dirname(os.path.abspath(__file__))

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36")
GATEWAY_HOST = "hatch.metaaivm.com"

# Service ids on the VM: daemon 0, sentinel 1, vault 2, authd 3.
SERVICE_IDS = {"daemon": 0, "sentinel": 1, "vault": 2, "authd": 3}

# ── protobuf schemas ──────────────────────────────────────────────────────
# The .bin files are FileDescriptorProtos lifted from the muse.ai web client
# bundle (the same descriptors muse-cli ships). Loading them keeps the wire
# format honest instead of hand-rolling varint parsing.
_pool = descriptor_pool.DescriptorPool()
for _i in (0, 1):
    _fd = descriptor_pb2.FileDescriptorProto()
    with open(os.path.join(_HERE, f"desc{_i}.bin"), "rb") as _fh:
        _fd.ParseFromString(_fh.read())
    _pool.Add(_fd)


def _msg(name):
    return message_factory.GetMessageClass(_pool.FindMessageTypeByName(name))


NoiseTransportFrame = _msg("ingress_rev_proxy.NoiseTransportFrame")
ServiceRequest = _msg("hatch.noise.ServiceRequest")
ServiceResponse = _msg("hatch.noise.ServiceResponse")
ServiceFrame = _msg("hatch.noise.ServiceFrame")
ApplicationRequest = _msg("hatch.noise.ApplicationRequest")

with open(os.path.join(_HERE, "routes.json")) as _fh:
    ROUTES = {e["method"]: e for e in json.load(_fh)}


class AuthError(RuntimeError):
    """Cookies expired or the account cannot be resolved — the user must act."""


class GatewayError(RuntimeError):
    """The gateway answered, but with a non-2xx status or a reset stream."""

    def __init__(self, status, payload):
        super().__init__(f"gateway status={status} payload={payload!r}")
        self.status = status
        self.payload = payload


class TransportError(RuntimeError):
    """The WebSocket transport itself broke (reset, timeout, connect failure).

    Deliberately separate from GatewayError: the socket dying is transient and
    retryable (reconnect + try again), while a GatewayError carries a status
    the server meant. curl_cffi raises CurlError here, which is NOT an
    OSError subclass — catching (GatewayError, TimeoutError, OSError) alone
    misses it and the raw exception escapes as an HTTP 500.
    """


def _hatch_headers(cookies, access_token=None):
    h = {
        "User-Agent": UA,
        "Referer": "https://muse.ai/",
        "Origin": "https://muse.ai",
        "Sec-Fetch-Site": "same-origin",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Dest": "empty",
        "Accept": "application/json",
        "Content-Type": "application/json",
        "Cookie": cookies,
    }
    if access_token:
        h["Authorization"] = f"Bearer {access_token}"
    return h


def fetch_access_token(cookies):
    r = rq.post("https://muse.ai/api/auth/check", headers=_hatch_headers(cookies),
                data=b"", impersonate="chrome", timeout=20)
    if r.status_code != 200:
        raise AuthError(
            f"auth/check -> {r.status_code} {r.text[:120]} "
            "(cookies expired? re-export them)")
    return r.json()["access_token"]


def fetch_session_info(cookies):
    """Discover the assigned personal VM id."""
    r = rq.get("https://muse.ai/api/session", headers=_hatch_headers(cookies),
               impersonate="chrome", timeout=20)
    if r.status_code != 200:
        raise AuthError(f"api/session -> {r.status_code} (cookies expired? re-export)")
    try:
        info = r.json()
    except ValueError:
        raise AuthError(f"api/session returned non-JSON ({r.text[:80]!r})")
    if "vm_id" not in info:
        # The VM is restarting: {"status":"unavailable", ...}. Not an auth
        # problem, so say so — a retry usually clears it.
        raise GatewayError(-1, f"VM unavailable ({info!r}); retry shortly")
    return info


def fetch_hatch_token(cookies, access_token, vm_id):
    r = rq.post(
        "https://muse.ai/api/hatch/token",
        headers=_hatch_headers(cookies, access_token),
        json={"vmAddress": f"wss://{vm_id}.metaaivm.com/", "vmName": vm_id},
        impersonate="chrome", timeout=20,
    )
    if r.status_code != 200:
        raise AuthError(f"hatch/token -> {r.status_code} {r.text[:160]}")
    return r.json()["token"]


def load_cookies(path):
    """Accept 'a=b; c=d', {"cookies": {...}} JSON, or a Netscape cookie jar."""
    raw = open(path, encoding="utf-8").read().strip()
    if not raw:
        raise AuthError(f"cookies file {path} is empty")
    if raw.startswith("{"):
        try:
            d = json.loads(raw)
            if isinstance(d, dict) and isinstance(d.get("cookies"), dict):
                d = d["cookies"]
            if isinstance(d, dict):
                return "; ".join(f"{k}={v}" for k, v in d.items())
        except json.JSONDecodeError:
            pass
    if "hatch_sess=" in raw or "datr=" in raw:
        for line in raw.splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line and ";" in line:
                return line
        return " ".join(raw.split())
    parts = []
    for line in raw.splitlines():
        if not line or line.startswith("#"):
            continue
        cols = line.split("\t")
        if len(cols) >= 7:
            parts.append(f"{cols[5]}={cols[6]}")
    if not parts:
        raise AuthError(f"could not parse cookies file {path}")
    return "; ".join(parts)


class Gateway:
    """One authenticated connection to the personal VM gateway."""

    def __init__(self, cookies, vm_id=None, access_token=None, hatch_token=None):
        # All network I/O here runs through curl_cffi, whose CurlError is NOT
        # an OSError subclass. A dead socket during (re)connect must surface as
        # TransportError (retryable) — never raw — or it escapes the retry
        # logic in server.py and becomes a blank HTTP 500.
        # AuthError/GatewayError pass through untouched: they carry meaning
        # (expired cookies, VM restarting) that TransportError must not swallow.
        self.ws = None
        try:
            if vm_id is None:
                vm_id = fetch_session_info(cookies)["vm_id"]
            self.vm_id = vm_id
            access_token = access_token or fetch_access_token(cookies)
            hatch_token = hatch_token or fetch_hatch_token(cookies, access_token, vm_id)
            url = (f"wss://{GATEWAY_HOST}/v1/noise?vm_id={vm_id}"
                   f"&auth_token={urllib.parse.quote(hatch_token, safe='')}")
            self.ws = WebSocket()
            # verify=True matters: curl_cffi's WebSocket.connect defaults to
            # verify=None, which disables certificate verification outright.
            self.ws.connect(url, impersonate="chrome", timeout=20, verify=True)
            noise = NoiseConnection.from_name(b"Noise_XX_25519_AESGCM_SHA256")
            noise.set_as_initiator()
            noise.set_keypair_from_private_bytes(Keypair.STATIC, os.urandom(32))
            noise.start_handshake()
            self.ws.send_bytes(bytes(noise.write_message(b"")))
            m2, _ = self.ws.recv()
            noise.read_message(bytes(m2))
            self.ws.send_bytes(bytes(noise.write_message(b"")))
            if not noise.handshake_finished:
                raise GatewayError(-1, "Noise handshake did not finish")
            self.noise = noise
            self.stream = 1
            self._send_lock = threading.Lock()
            self._recv_lock = threading.Lock()
        except (AuthError, GatewayError):
            raise
        except Exception as exc:  # noqa: BLE001 — see comment above
            if self.ws is not None:
                try:
                    self.ws.close()
                except Exception:  # noqa: BLE001 — already dying, just clean up
                    pass
            raise TransportError(
                f"connect failed: {type(exc).__name__}: {exc}") from exc

    # ── low-level framing ─────────────────────────────────────────────────
    def _send_envelope(self, service_id, frame_bytes):
        outer = ServiceRequest(service=service_id, payload=frame_bytes)
        chunk_id = struct.unpack("<q", os.urandom(8))[0]
        fr = NoiseTransportFrame(chunk_id=chunk_id, chunk_index=0, total_chunks=1,
                                 payload=outer.SerializeToString())
        try:
            with self._send_lock:
                self.ws.send_bytes(bytes(self.noise.encrypt(fr.SerializeToString())))
        except Exception as exc:  # noqa: BLE001 — curl_cffi errors are transport death
            raise TransportError(f"send failed: {type(exc).__name__}: {exc}") from exc

    def _read_frame(self):
        # Serialized so two threads can never interleave recv/decrypt, which
        # corrupts the stateful Noise transport (fatal BAD_DECRYPT).
        try:
            with self._recv_lock:
                data, _flags = self.ws.recv()
                pt = bytes(self.noise.decrypt(bytes(data)))
        except Exception as exc:  # noqa: BLE001 — same reasoning as _send_envelope
            raise TransportError(f"recv failed: {type(exc).__name__}: {exc}") from exc
        ntf = NoiseTransportFrame()
        ntf.ParseFromString(pt)
        sr = ServiceResponse()
        sr.ParseFromString(ntf.payload)
        sf = ServiceFrame()
        sf.ParseFromString(sr.payload)
        return sf

    def _open(self, method, path_params=None, body=None, query=None):
        """Send a request without waiting. Returns the stream id."""
        route = ROUTES[method]
        path = route["path"]
        for k, v in (path_params or {}).items():
            path = path.replace("{" + k + "}", urllib.parse.quote(str(v), safe=""))
        if query:
            qs = urllib.parse.urlencode({k: v for k, v in query.items() if v is not None})
            if qs:
                path = path + ("&" if "?" in path else "?") + qs
        raw = b"" if body is None else (
            body if isinstance(body, bytes) else json.dumps(body).encode())
        req = ApplicationRequest(verb=route["http"], path=path, body=raw, end_body=True)
        h = req.headers.add()
        h.key = "x-request-id"
        h.value = str(uuid.uuid4())
        if raw:
            h2 = req.headers.add()
            h2.key = "content-type"
            h2.value = "application/json"
        frame = ServiceFrame(stream_id=self.stream)
        frame.request.CopyFrom(req)
        sid = self.stream
        self.stream += 1
        self._send_envelope(SERVICE_IDS.get(route.get("service", "daemon"), 0),
                            frame.SerializeToString())
        return sid

    # ── unary request/response ────────────────────────────────────────────
    def request(self, method, path_params=None, body=None, query=None, timeout=30):
        route = ROUTES[method]
        if route["http"] == "GET" and body is not None and query is None:
            query, body = body, None
        sid = self._open(method, path_params, body, query)
        status, chunks, deadline = None, [], time.time() + timeout
        while time.time() < deadline:
            sf = self._read_frame()
            if sf.stream_id != sid:
                # Frames from an earlier subscription (chat.stream echo) land
                # here; they are not ours, so drop them and keep reading.
                continue
            kind = sf.WhichOneof("kind")
            if kind == "response":
                status = sf.response.status
                if sf.response.body:
                    chunks.append(bytes(sf.response.body))
                if sf.response.end_body:
                    break
            elif kind == "body_chunk":
                chunks.append(bytes(sf.body_chunk.data))
                if sf.body_chunk.end_body:
                    break
            elif kind == "reset":
                raise GatewayError(-1, f"stream reset {sf.reset.code}: {sf.reset.reason}")
        if status is None:
            raise TimeoutError(f"no response for {method}")
        payload = b"".join(chunks)
        if status < 200 or status >= 300:
            raise GatewayError(status, payload[:500].decode("utf-8", "replace"))
        return payload

    def call_json(self, method, path_params=None, body=None, query=None, timeout=30):
        raw = self.request(method, path_params, body, query, timeout)
        try:
            d = json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            raise GatewayError(-1, f"non-JSON response: {raw[:200]!r}")
        if isinstance(d, dict) and d.get("ok") is False:
            raise GatewayError(-1, f"api error: {d.get('error')}")
        return d.get("result", d) if isinstance(d, dict) else d

    def close(self):
        try:
            if self.ws is not None:
                self.ws.close()
        except Exception:  # noqa: BLE001 — closing a dead socket is not an error
            pass

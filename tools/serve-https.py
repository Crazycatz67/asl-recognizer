#!/usr/bin/env python3
"""HTTPS static server for testing on a PHONE over your Wi-Fi (macOS / Linux).

    python3 tools/serve-https.py            # serves the repo on https://<LAN-IP>:8443
    python3 tools/serve-https.py --port 9443

Why: phones only allow the camera on a "secure context" (https:// or
localhost), and a phone can't reach your Mac's localhost. This serves the repo
over https on the local network with a self-signed certificate (the Mac
equivalent of start-phone.cmd / serve-https.ps1 on Windows).

On the phone (same Wi-Fi as the Mac), open the printed link:
  - Chrome on Android: "Your connection is not private" -> Advanced -> Proceed.
  - Chrome / Safari on iPhone: "This connection is not private" -> Show details
    -> visit this website -> Visit Website.
  That's a one-time warning per certificate; after it the camera works.

Debug the phone from the Mac:
  - Android Chrome: phone Settings > Developer options > USB debugging; plug in;
    Mac Chrome -> chrome://inspect -> your tab -> inspect.
  - iPhone Chrome: in Chrome on the iPhone, Settings > Content Settings > Web
    Inspector ON (Chrome 115+); iPhone Settings > Safari > Advanced > Web
    Inspector ON; plug in; Mac Safari > Develop > [your iPhone] > the page.
    (Chrome on iPhone uses Safari's engine, so this is the same inspector.)

The certificate lives in .certs/ (git-ignored) and is re-made when your LAN IP
changes. No dependencies beyond Python 3 and the system `openssl`.
"""
import argparse
import functools
import http.server
import os
import socket
import ssl
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CERTS = os.path.join(ROOT, ".certs")


def lan_ip():
    # the address this machine would use to reach the internet = its LAN IP
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))  # no packets are sent
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def ensure_cert(ip):
    os.makedirs(CERTS, exist_ok=True)
    cert, key, stamp = (os.path.join(CERTS, n) for n in ("cert.pem", "key.pem", "ip.txt"))
    if os.path.exists(cert) and os.path.exists(key) and os.path.exists(stamp):
        with open(stamp) as f:
            if f.read().strip() == ip:
                return cert, key
    print(f"Making a self-signed certificate for {ip} ...")
    subprocess.run(
        ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256",
         "-days", "825", "-keyout", key, "-out", cert,
         "-subj", "/CN=ASL trainer (local test)",
         "-addext", f"subjectAltName=IP:{ip},IP:127.0.0.1,DNS:localhost"],
        check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    with open(stamp, "w") as f:
        f.write(ip)
    return cert, key


class Handler(http.server.SimpleHTTPRequestHandler):
    # no caching while testing: every reload gets the files you just changed
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):  # quieter log: just the path + status
        sys.stderr.write("%s %s\n" % (self.command, args[1] if len(args) > 1 else ""))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=8443)
    a = ap.parse_args()
    ip = lan_ip()
    cert, key = ensure_cert(ip)
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(cert, key)
    httpd = http.server.ThreadingHTTPServer(("0.0.0.0", a.port), functools.partial(Handler, directory=ROOT))
    httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)
    url = f"https://{ip}:{a.port}/"
    bar = "=" * (len(url) + 8)
    print(f"\n{bar}\n    {url}\n{bar}", flush=True)
    print("Open that on your phone (same Wi-Fi). Add ?perf for the performance report,")
    print("?fresh for a first-visit run. Ctrl+C to stop.\n", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()

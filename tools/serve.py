"""Serve proto/ over HTTPS so the Quest browser allows WebXR on the LAN.

usage: python3 tools/serve.py   (then open https://<pc-ip>:8443 on the Quest, accept the certificate warning)
"""
import functools, http.server, ssl
from pathlib import Path

root = Path(__file__).resolve().parent.parent
cert = root / ".cert"  # self-signed: openssl req -x509 -newkey rsa:2048 -nodes -days 365 -keyout key.pem -out cert.pem -subj /CN=musicvr
handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=root / "proto")
httpd = http.server.ThreadingHTTPServer(("0.0.0.0", 8443), handler)
tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
tls.load_cert_chain(cert / "cert.pem", cert / "key.pem")
httpd.socket = tls.wrap_socket(httpd.socket, server_side=True)
print("https://0.0.0.0:8443")
httpd.serve_forever()

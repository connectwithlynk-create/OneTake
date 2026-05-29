#!/usr/bin/env python3
"""Export cookies for a domain from Arc (a Chromium fork) to a Netscape
cookies.txt that yt-dlp can consume via --cookies / YTDLP_COOKIES_FILE.

yt-dlp's --cookies-from-browser has no `arc` option, and pointing its
chrome extractor at Arc's profile fails because Arc encrypts cookie
values with an "Arc Safe Storage" keychain key (not "Chrome Safe
Storage"). This reads the correct key and decrypts the v10 values.

Usage:
  python3 export-arc-cookies.py <domain-substring> <out-path> [profile]
  e.g. python3 export-arc-cookies.py instagram.com ~/.onetake/ig-cookies.txt
"""
import sys
import os
import sqlite3
import subprocess
import hashlib
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

ARC_USER_DATA = os.path.expanduser(
    "~/Library/Application Support/Arc/User Data"
)


def safe_storage_key() -> bytes:
    pw = subprocess.check_output(
        ["security", "find-generic-password", "-ws", "Arc Safe Storage"]
    ).strip()
    return hashlib.pbkdf2_hmac("sha1", pw, b"saltysalt", 1003, dklen=16)


def decrypt(enc: bytes, key: bytes) -> str | None:
    if not enc or enc[:3] != b"v10":
        return None
    dec = (
        Cipher(algorithms.AES(key), modes.CBC(b" " * 16))
        .decryptor()
    )
    raw = dec.update(enc[3:]) + dec.finalize()
    if not raw:
        return None
    raw = raw[: -raw[-1]]  # strip PKCS7 padding
    # Recent Chromium prepends a 32-byte SHA256 domain hash to the value.
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return raw[32:].decode("utf-8", "replace")


def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    domain_filter = sys.argv[1]
    out_path = os.path.expanduser(sys.argv[2])
    key = safe_storage_key()

    rows: list[tuple] = []
    # Default holds the IG session here; merge any profile that has it.
    for prof in sorted(os.listdir(ARC_USER_DATA)):
        db = os.path.join(ARC_USER_DATA, prof, "Cookies")
        if not os.path.isfile(db):
            continue
        con = sqlite3.connect(f"file:{db}?immutable=1", uri=True)
        try:
            cur = con.execute(
                "SELECT host_key,name,encrypted_value,path,expires_utc,"
                "is_secure FROM cookies WHERE host_key LIKE ?",
                (f"%{domain_filter}%",),
            )
            rows += cur.fetchall()
        finally:
            con.close()

    lines = ["# Netscape HTTP Cookie File", ""]
    n_ok = 0
    for host, name, enc, path, exp, secure in rows:
        val = decrypt(enc, key)
        if val is None:
            continue
        # Chromium expires_utc: microseconds since 1601-01-01.
        unix_exp = 0 if not exp else int(exp / 1_000_000 - 11_644_473_600)
        if unix_exp < 0:
            unix_exp = 0
        lines.append(
            "\t".join(
                [
                    host,
                    "TRUE" if host.startswith(".") else "FALSE",
                    path or "/",
                    "TRUE" if secure else "FALSE",
                    str(unix_exp),
                    name,
                    val,
                ]
            )
        )
        n_ok += 1

    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w") as f:
        f.write("\n".join(lines) + "\n")
    os.chmod(out_path, 0o600)
    has_session = any("\tsessionid\t" in ln for ln in lines)
    print(f"wrote {n_ok} cookies for *{domain_filter}* to {out_path}")
    print(f"instagram session cookie present: {has_session}")
    return 0 if has_session else 1


if __name__ == "__main__":
    sys.exit(main())

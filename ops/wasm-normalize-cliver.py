#!/usr/bin/env python3
"""Rewrite the `cliver` entry of a Soroban wasm's contractmetav0 section to "<version>#" (no commit).

Why: `stellar contract build` stamps its own version and git commit into the wasm (`cliver`), so two
builds of the same source with the same rustc differ in that string and nothing else, and a CLI that
stamped no commit (the mainnet LumenDrop reads `cliver: 25.2.0#`) gives a hash no release binary can
match directly. Normalizing the stamp makes a rebuild comparable: on 2026-11-10 the escrow built from
this repository with stellar-cli 25.2.0 and rustc 1.96.0, passed through this script, was byte-identical
to the mainnet pin 38941538b964af2110a6fd2fae4c1c3de2ff6585ef0da5d1a59de2ce29edec6a (21,323 bytes).

Usage: python3 ops/wasm-normalize-cliver.py <in.wasm> <out.wasm>
Then: shasum -a 256 <out.wasm>, and compare with LUMENDROP_WASM_HASH for the network in question.
Only the custom section is touched; code, data and every other section are copied through untouched.
"""
import hashlib
import struct
import sys


def read_leb(buf: bytes, i: int) -> tuple[int, int]:
    result = shift = 0
    while True:
        c = buf[i]
        i += 1
        result |= (c & 0x7F) << shift
        shift += 7
        if not c & 0x80:
            return result, i


def leb(n: int) -> bytes:
    out = bytearray()
    while True:
        c = n & 0x7F
        n >>= 7
        if n:
            out.append(c | 0x80)
        else:
            out.append(c)
            return bytes(out)


def xdr_string(s: bytes) -> bytes:
    return struct.pack(">I", len(s)) + s + b"\0" * ((-len(s)) % 4)


def normalize(wasm: bytes) -> bytes:
    if wasm[:8] != b"\0asm\1\0\0\0":
        raise SystemExit("not a wasm v1 file")
    out = bytearray(wasm[:8])
    i = 8
    hits = 0
    while i < len(wasm):
        section_id = wasm[i]
        size, j = read_leb(wasm, i + 1)
        body = wasm[j : j + size]
        i = j + size
        if section_id == 0:
            name_len, k = read_leb(body, 0)
            name = body[k : k + name_len]
            if name == b"contractmetav0":
                payload = body[k + name_len :]
                rebuilt = bytearray()
                p = 0
                while p < len(payload):
                    (kind,) = struct.unpack(">I", payload[p : p + 4])
                    p += 4
                    if kind != 0:
                        raise SystemExit(f"unknown ScMetaEntry kind {kind}")
                    (key_len,) = struct.unpack(">I", payload[p : p + 4])
                    p += 4
                    key = payload[p : p + key_len]
                    p += (key_len + 3) // 4 * 4
                    (val_len,) = struct.unpack(">I", payload[p : p + 4])
                    p += 4
                    val = payload[p : p + val_len]
                    p += (val_len + 3) // 4 * 4
                    if key == b"cliver":
                        print(f"cliver: {val.decode()} -> {val.split(b'#')[0].decode()}#")
                        val = val.split(b"#")[0] + b"#"
                        hits += 1
                    rebuilt += struct.pack(">I", 0) + xdr_string(key) + xdr_string(val)
                body = leb(name_len) + name + bytes(rebuilt)
        out += bytes([section_id]) + leb(len(body)) + body
    if hits != 1:
        raise SystemExit(f"expected one cliver entry, found {hits}")
    return bytes(out)


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    src, dst = sys.argv[1], sys.argv[2]
    data = open(src, "rb").read()
    result = normalize(data)
    open(dst, "wb").write(result)
    print(f"{len(data)} -> {len(result)} bytes, sha256 {hashlib.sha256(result).hexdigest()}")


if __name__ == "__main__":
    main()

"""Retained qualification-only ZIP audit; production archive limits are unchanged."""

import io
import stat
import struct
import zipfile
from pathlib import PurePosixPath


def preflight(f, files=4096):
    f.seek(0, 2)
    size = f.tell()
    assert 22 <= size <= 1024**3, "packed bound"
    f.seek(max(0, size - 65557))
    tail = f.read(65557)
    end = -1
    for i in range(len(tail) - 22, -1, -1):
        if tail[i : i + 4] == b"PK\x05\x06" and i + 22 + struct.unpack_from("<H", tail, i + 20)[0] == len(tail):
            end = i
            break
    assert end >= 0, "terminal EOCD"
    e = struct.unpack_from("<4s4H2IH", tail, end)
    disk, cdisk, dcnt, count, csize, start, comment = e[1:]
    assert disk == cdisk == 0 and dcnt == count and 0 < count <= files and count != 65535, "raw count/multipart"
    assert (
        csize <= 4 * 1024**2 and start + csize == size - len(tail) + end and start != 0xFFFFFFFF and comment <= 1024
    ), "raw directory bound/ZIP64"
    f.seek(start)
    raw = f.read(csize)
    assert len(raw) == csize
    c = 0
    seen = set()
    rows = []
    expanded = 0
    while c < len(raw):
        assert len(rows) < files and c + 46 <= len(raw) and raw[c : c + 4] == b"PK\x01\x02", "raw record bound"
        flags, method = struct.unpack_from("<HH", raw, c + 8)
        packed, unpacked = struct.unpack_from("<II", raw, c + 20)
        n, x, k = struct.unpack_from("<HHH", raw, c + 28)
        diskstart = struct.unpack_from("<H", raw, c + 34)[0]
        attr, local = struct.unpack_from("<II", raw, c + 38)
        assert 0 < n <= 1024 and x <= 4096 and k <= 1024 and c + 46 + n + x + k <= len(raw), (
            "name/extra/comment metadata bounds"
        )
        assert not flags & 1 and method in (0, 8) and diskstart == 0, "encryption/method/multipart"
        assert packed <= 1024**3 and unpacked <= 512 * 1024**2 and local < start, "member bounds"
        name = raw[c + 46 : c + 46 + n].decode("utf-8" if flags & 0x800 else "cp437")
        p = PurePosixPath(name)
        assert (
            "\x00" not in name
            and "\\" not in name
            and ":" not in name
            and not p.is_absolute()
            and all(v not in ("", "..", ".") for v in name.rstrip("/").split("/"))
        ), "unsafe path"
        assert name.casefold() not in seen, "duplicate/collision"
        seen.add(name.casefold())
        mode = stat.S_IFMT(attr >> 16)
        assert mode in (0, stat.S_IFREG, stat.S_IFDIR), "link/special entry"
        assert not name.endswith("/") or unpacked == 0, "nonempty directory"
        extra = raw[c + 46 + n : c + 46 + n + x]
        z = 0
        while z < len(extra):
            assert z + 4 <= len(extra), "truncated extra"
            kind, length = struct.unpack_from("<HH", extra, z)
            assert kind != 1, "ZIP64 unsupported"
            z += 4
            assert z + length <= len(extra), "extra record bounds"
            z += length
        expanded += unpacked
        assert expanded <= 2 * 1024**3, "expanded bound"
        rows.append({"path": name, "bytes": unpacked, "packed": packed, "local": local})
        c += 46 + n + x + k
    assert c == len(raw) and len(rows) == count, "raw directory/count consistency"
    # Bound local metadata before ZipFile.open can read or interpret it.
    local_metadata = 0
    for row in rows:
        f.seek(row["local"])
        header = f.read(30)
        assert len(header) == 30 and header[:4] == b"PK\x03\x04", "raw local header"
        flags, method = struct.unpack_from("<HH", header, 6)
        n, x = struct.unpack_from("<HH", header, 26)
        assert not flags & 1 and method in (0, 8) and 0 < n <= 1024 and x <= 4096, "local metadata bounds"
        assert row["local"] + 30 + n + x + row["packed"] <= start, "local member crosses directory"
        local_metadata += 30 + n + x
        assert local_metadata <= 4 * 1024**2, "cumulative local metadata bound"
        name = f.read(n).decode("utf-8" if flags & 0x800 else "cp437")
        assert name == row["path"], "local name mismatch"
    return rows


def controls():
    b = io.BytesIO()
    with zipfile.ZipFile(b, "w") as z:
        for i in range(8):
            z.writestr(f"near-boundary/{i}.txt", b"x")
    assert len(preflight(io.BytesIO(b.getvalue()), 8)) == 8
    for label, raw in [
        ("count", struct.pack("<4s4H2IH", b"PK\x05\x06", 0, 0, 4097, 4097, 0, 0, 0)),
        ("metadata", struct.pack("<4s4H2IH", b"PK\x05\x06", 0, 0, 1, 1, 4 * 1024**2 + 1, 0, 0)),
        ("truncated", b.getvalue()[:-1]),
    ]:
        try:
            preflight(io.BytesIO(raw))
            raise RuntimeError("accepted " + label)
        except AssertionError:
            pass
    for offset, label, value in [(26, "local-name", 1025), (28, "local-extra", 4097)]:
        bad = bytearray(b.getvalue())
        struct.pack_into("<H", bad, offset, value)
        try:
            preflight(io.BytesIO(bad))
            raise RuntimeError("accepted " + label)
        except AssertionError:
            pass
    print("6 raw-preflight controls passed; actual artifact not yet read")


if __name__ == "__main__":
    controls()

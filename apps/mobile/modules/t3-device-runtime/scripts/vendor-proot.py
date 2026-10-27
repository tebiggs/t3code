#!/usr/bin/env python3
"""Rebuilds android/src/main/jniLibs from Termux's proot packages.

Android 10+ apps can only execute files from their native library directory, which
packages only fill with lib*.so files. So the proot binary and its loader ship renamed,
and proot's NEEDED libtalloc.so.2 becomes libtalloc.so. RUNPATH becomes $ORIGIN so the
libraries resolve next to proot without LD_LIBRARY_PATH leaking into the guest.

Termux keeps only the newest build of each package, so update the pins below to rerun.
"""

import hashlib
import io
import lzma
import pathlib
import struct
import sys
import tarfile
import urllib.request

REPO = "https://packages.termux.dev/apt/termux-main/"
PREFIX = "data/data/com.termux/files/usr/"
# Android ABI -> Termux packages: (path, SHA-256, {file in the package: name in jniLibs}).
# x86_64 is for emulators.
PACKAGES = {
    "arm64-v8a": [
        (
            "pool/main/p/proot/proot_5.1.107.101_aarch64.deb",
            "a28355e9be257e1f87f4e9294b3118470d4fd7a5442fed8b278f4443c83407d7",
            {"bin/proot": "libproot.so", "libexec/proot/loader": "libproot-loader.so"},
        ),
        (
            "pool/main/libt/libtalloc/libtalloc_2.5.0_aarch64.deb",
            "556591f43bb773ad8777e1a29522640866a55f95dab71914418b94a8c58ad5a7",
            {"lib/libtalloc.so.2.5.0": "libtalloc.so"},
        ),
        (
            "pool/main/liba/libandroid-shmem/libandroid-shmem_0.7_aarch64.deb",
            "0da3a24d558b93c92bcf8d611e0826a99ff96e396b148e6cdf33b47c47c57ff6",
            {"lib/libandroid-shmem.so": "libandroid-shmem.so"},
        ),
    ],
    "x86_64": [
        (
            "pool/main/p/proot/proot_5.1.107.101_x86_64.deb",
            "85adb8d0d2e1edc6c56e60c17136adf05e54ce75f69407ec7116a4c5997eaed5",
            {"bin/proot": "libproot.so", "libexec/proot/loader": "libproot-loader.so"},
        ),
        (
            "pool/main/libt/libtalloc/libtalloc_2.5.0_x86_64.deb",
            "b8c6d95f20075dc1f9ec6573575b2444e8d526e48e0d8d6d5cf4e071e6e06530",
            {"lib/libtalloc.so.2.5.0": "libtalloc.so"},
        ),
        (
            "pool/main/liba/libandroid-shmem/libandroid-shmem_0.7_x86_64.deb",
            "ffa9e4c87467b158b148d0ff92dda796aa038276c2075af3269cdcdb06f25797",
            {"lib/libandroid-shmem.so": "libandroid-shmem.so"},
        ),
    ],
}
# (dynamic tag, old string, new string); tags: 1 NEEDED, 14 SONAME, 29 RUNPATH.
RUNPATH = (29, "/" + PREFIX + "lib", "$ORIGIN")
PATCHES = {
    "libproot.so": [(1, "libtalloc.so.2", "libtalloc.so"), RUNPATH],
    "libtalloc.so": [(14, "libtalloc.so.2", "libtalloc.so"), RUNPATH],
    "libandroid-shmem.so": [RUNPATH],
}
JNI_LIBS = pathlib.Path(__file__).resolve().parent.parent / "android/src/main/jniLibs"


def deb_data(deb: bytes) -> tarfile.TarFile:
    if not deb.startswith(b"!<arch>\n"):
        raise SystemExit("not an ar archive")
    offset = 8
    while offset < len(deb):
        name = deb[offset : offset + 16].decode().strip().rstrip("/")
        size = int(deb[offset + 48 : offset + 58].decode().strip())
        body = deb[offset + 60 : offset + 60 + size]
        if name == "data.tar.xz":
            return tarfile.open(fileobj=io.BytesIO(lzma.decompress(body)))
        offset += 60 + size + (size & 1)
    raise SystemExit("deb has no data.tar.xz")


def c_string(data: bytes, offset: int) -> str:
    return data[offset : data.index(b"\0", offset)].decode()


def patch_dynamic(data: bytearray, patches: list[tuple[int, str, str]]) -> None:
    shoff, = struct.unpack_from("<Q", data, 0x28)
    shentsize, shnum = struct.unpack_from("<HH", data, 0x3A)
    sections = [struct.unpack_from("<IIQQQQIIQQ", data, shoff + i * shentsize) for i in range(shnum)]
    dynamic = next(s for s in sections if s[1] == 6)
    dynstr = sections[dynamic[6]]
    strtab = dynstr[4]

    # Every dynstr offset in use, so a shortened string can't cut one that shares its tail.
    used = set()
    entries = []
    for at in range(dynamic[4], dynamic[4] + dynamic[5], 16):
        tag, value = struct.unpack_from("<qQ", data, at)
        if tag == 0:
            break
        if tag in (1, 14, 15, 29):
            used.add(value)
            entries.append((tag, value))
    for s in sections:
        if s[1] == 11 and s[6] == dynamic[6]:
            used.update(struct.unpack_from("<I", data, s[4] + i)[0] for i in range(0, s[5], 24))
        elif s[1] == 0x6FFFFFFE:
            at = s[4]
            while True:
                _, count, file, aux, next_need = struct.unpack_from("<HHIII", data, at)
                used.add(file)
                aux_at = at + aux
                for _ in range(count):
                    _, _, _, name, next_aux = struct.unpack_from("<IHHII", data, aux_at)
                    used.add(name)
                    aux_at += next_aux
                if not next_need:
                    break
                at += next_need

    for tag, old, new in patches:
        match = [v for t, v in entries if t == tag and c_string(data, strtab + v) == old]
        if len(match) != 1 or len(new) > len(old):
            raise SystemExit(f"can't patch tag {tag} {old!r}: found {len(match)}")
        start = match[0]
        if any(start < u <= start + len(old) for u in used):
            raise SystemExit(f"{old!r} shares bytes with another dynamic string")
        encoded = new.encode().ljust(len(old) + 1, b"\0")
        data[strtab + start : strtab + start + len(encoded)] = encoded


def main() -> None:
    for abi, packages in PACKAGES.items():
        out = JNI_LIBS / abi
        out.mkdir(parents=True, exist_ok=True)
        for path, sha256, files in packages:
            vendor(path, sha256, files, out)


def vendor(path: str, sha256: str, files: dict[str, str], out: pathlib.Path) -> None:
    deb = urllib.request.urlopen(REPO + path).read()
    if hashlib.sha256(deb).hexdigest() != sha256:
        raise SystemExit(f"{path}: SHA-256 mismatch")
    data = deb_data(deb)
    for source, target in files.items():
        member = data.extractfile("./" + PREFIX + source)
        if member is None:
            raise SystemExit(f"{path} lacks {source}")
        elf = bytearray(member.read())
        if target in PATCHES:
            patch_dynamic(elf, PATCHES[target])
        (out / target).write_bytes(elf)
        print(f"{out.name}/{target}: {len(elf)} bytes", file=sys.stderr)


if __name__ == "__main__":
    main()

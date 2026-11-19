"""Check the distributed ZIP and exercise its actual server files after relocation."""
import argparse
import hashlib
from pathlib import Path
import plistlib
import shutil
import struct
import tempfile
import sys
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from verify_service import check_server
from package_app import APP, LAUNCHER, NODE_SHA256, require_arm64, sha256


def verify_macho_hashes(program, special_slots=None):
    image = program.read_bytes()
    commands = struct.unpack_from("<I", image, 16)[0]
    offset = 32
    for _ in range(commands):
        command, length = struct.unpack_from("<II", image, offset)
        if command == 0x1d:  # LC_CODE_SIGNATURE
            start, size = struct.unpack_from("<II", image, offset + 8)
            signature = image[start:start + size]
            break
        offset += length
    else:
        raise ValueError(f"Missing code signature in {program.name}")
    magic, _, count = struct.unpack_from(">III", signature)
    assert magic == 0xfade0cc0
    digests = []
    for index in range(count):
        _, offset = struct.unpack_from(">II", signature, 12 + index * 8)
        magic, length = struct.unpack_from(">II", signature, offset)
        if magic != 0xfade0c02:  # CodeDirectory
            continue
        directory = signature[offset:offset + length]
        _, _, _, flags, hashes, _, specials, slots, limit = struct.unpack_from(">9I", directory)
        width, algorithm, _, shift = struct.unpack_from("4B", directory, 36)
        algo = {1: "sha1", 2: "sha256", 3: "sha256", 4: "sha384"}[algorithm]
        if not limit:
            limit = struct.unpack_from(">Q", directory, 56)[0]
        page = (1 << shift) if shift else limit
        assert slots == (limit + page - 1) // page and limit <= start
        for slot in range(slots):
            block = image[slot * page:min((slot + 1) * page, limit)]
            assert directory[hashes + slot * width:hashes + (slot + 1) * width] == hashlib.new(algo, block).digest()[:width]
        if special_slots:
            assert flags & 2, "Expected an ad-hoc signature on the test application"
            for slot, content in special_slots.items():
                assert specials >= slot
                assert directory[hashes - slot * width:hashes - (slot - 1) * width] == hashlib.new(algo, content).digest()[:width]
        digests.append(hashlib.new(algo, directory).digest()[:20])
    assert digests, f"Missing signed code directory in {program.name}"
    return digests


def check_bundle_seal(contents):
    seal = (contents / "_CodeSignature/CodeResources").read_bytes()
    verify_macho_hashes(contents / "MacOS" / LAUNCHER, {1: (contents / "Info.plist").read_bytes(), 3: seal})
    node_hashes = verify_macho_hashes(contents / "Helpers/node")
    entries = plistlib.loads(seal)["files2"]
    assert entries["Helpers/node"]["cdhash"] in node_hashes
    for path in (contents / "Resources").rglob("*"):
        if path.is_file():
            data = path.read_bytes()
            assert entries[path.relative_to(contents).as_posix()]["hash2"] == hashlib.sha256(data).digest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("--node", default=shutil.which("node"))
    parser.add_argument("--check-feed", action="store_true")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="Trend Workbench ZIP ") as tmp:
        with zipfile.ZipFile(args.archive) as archive:
            assert archive.testzip() is None
            for info in archive.infolist():
                name = info.filename
                mode = info.external_attr >> 16
                assert info.create_system == 3 and not set(Path(name).parts).intersection({"..", ".git", "logs", "node_modules"})
                assert not name.lower().endswith((".exe", ".lnk", ".vbs", ".ps1", ".log"))
                if name.endswith((f"/MacOS/{LAUNCHER}", "/Helpers/node")):
                    assert mode & 0o777 == 0o755, f"Missing execute bit on {name}"
            archive.extractall(tmp)
        contents = Path(tmp) / APP / "Contents"
        with (contents / "Info.plist").open("rb") as f:
            info = plistlib.load(f)
        assert info["CFBundleExecutable"] == LAUNCHER and info["CFBundlePackageType"] == "APPL"
        assert (contents / "_CodeSignature/CodeResources").stat().st_size > 0
        require_arm64(contents / "MacOS" / LAUNCHER)
        require_arm64(contents / "Helpers/node")
        assert sha256(contents / "Helpers/node") == NODE_SHA256
        check_bundle_seal(contents)
        check_server(contents / "Resources", args.node, args.check_feed)
    print("Archive, arm64 code pages, bundle resource seals, permissions, relocated service, and exit verified.")


if __name__ == "__main__":
    main()

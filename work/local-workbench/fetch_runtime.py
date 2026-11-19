"""Fetch an official Node distribution, verify its digest and extract just Node and its license."""
import argparse
import hashlib
from pathlib import Path
import shutil
import tarfile
import tempfile
from urllib.request import urlopen
import zipfile

VERSION = "24.14.1"
ARCHIVES = {
    "win-x64": ("zip", "6e50ce5498c0cebc20fd39ab3ff5df836ed2f8a31aa093cecad8497cff126d70", "node.exe"),
    "darwin-arm64": ("tar.gz", "25495ff85bd89e2d8a24d88566d7e2f827c6b0d3d872b2cebf75371f93fcb1fe", "bin/node"),
}


def fetch_runtime(target, output):
    extension, expected_hash, executable = ARCHIVES[target]
    prefix = f"node-v{VERSION}-{target}"
    url = f"https://nodejs.org/dist/v{VERSION}/{prefix}.{extension}"
    with tempfile.TemporaryDirectory() as tmp:
        archive = Path(tmp) / "runtime"
        with urlopen(url, timeout=90) as remote, archive.open("wb") as dest:
            shutil.copyfileobj(remote, dest)
        with archive.open("rb") as source:
            if hashlib.file_digest(source, "sha256").hexdigest() != expected_hash:
                raise ValueError(f"SHA-256 mismatch for {url}")
        opener = zipfile.ZipFile if extension == "zip" else tarfile.open
        with opener(archive) as source:
            for relative in (executable, "LICENSE"):
                path = output / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                name = f"{prefix}/{relative}"
                part = source.open(name) if extension == "zip" else source.extractfile(name)
                with part, path.open("wb") as dest:
                    shutil.copyfileobj(part, dest)
        (output / executable).chmod(0o755)
    print(f"Verified {url}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("target", choices=ARCHIVES)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    fetch_runtime(args.target, args.output)

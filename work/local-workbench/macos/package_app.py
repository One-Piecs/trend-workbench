"""Assemble the arm64 workbench, sign the bundle and write a Finder-compatible ZIP."""
import argparse
import hashlib
import os
from pathlib import Path
import plistlib
import shutil
import stat
import struct
import subprocess
import tempfile
import time
import zipfile



HERE = Path(__file__).resolve().parent
WORK = HERE.parent.parent
NAME = "趋势判断工作台"
APP = NAME + ".app"
LAUNCHER = "TrendWorkbench"
NODE_SHA256 = "35d4bc736bbe4161f0c074aa140ddb74586e46969bc2ad63d32c838bec4463ff"
INSTRUCTIONS = """趋势判断工作台 · macOS 版

在 Mac 上双击 ZIP 解压，将「趋势判断工作台」拖入「应用程序」，然后双击打开。
工作台在独立窗口运行，已包含 Apple 芯片版运行环境。查看在线行情需要网络。
关闭工作台窗口或按 ⌘Q 会退出程序和本地行情服务。自选、语言和预判记录保存在这台 Mac。

本测试版未经 Apple 公证。首次启动的系统提示说明可查阅 Apple 支持：
https://support.apple.com/zh-cn/102445

开发者（DeFi狙击手）  https://x.com/bi_9527zx
社区交流  https://t.me/jujishou9527
"""


def sha256(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def require_arm64(path):
    with path.open("rb") as f:
        header = f.read(16)
    if len(header) != 16 or struct.unpack("<IIII", header)[:2] != (0xFEEDFACF, 0x0100000C):
        raise ValueError(f"Expected an Apple silicon Mach-O executable: {path}")
    if struct.unpack_from("<I", header, 12)[0] != 2:
        raise ValueError(f"Expected a macOS executable: {path}")


def pack_folder(folder, output):
    packaged_at = time.localtime()[:6]
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for path in sorted(folder.rglob("*")):
            name = path.relative_to(folder).as_posix()
            if path.is_dir():
                info = zipfile.ZipInfo(name + "/", packaged_at)
                info.create_system = 3
                info.external_attr = ((stat.S_IFDIR | 0o755) << 16) | 0x10
                archive.writestr(info, b"")
                continue
            executable = name in (f"{APP}/Contents/MacOS/{LAUNCHER}", f"{APP}/Contents/Helpers/node")
            info = zipfile.ZipInfo(name, packaged_at)
            info.create_system = 3
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = (stat.S_IFREG | (0o755 if executable else 0o644)) << 16
            with path.open("rb") as source, archive.open(info, "w") as target:
                shutil.copyfileobj(source, target, 1024 * 1024)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--launcher", type=Path, required=True)
    parser.add_argument("--signer", type=Path, help="Optional rcodesign executable for cross-builds; macOS defaults to codesign.")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--node-dir", type=Path, default=HERE / "vendor/node-v24.14.1-darwin-arm64")
    args = parser.parse_args()
    output = args.output.resolve()
    runtime = args.node_dir / "bin/node"
    require_arm64(args.launcher)
    require_arm64(runtime)
    if sha256(runtime) != NODE_SHA256:
        raise ValueError("Node binary differs from the verified upstream arm64 distribution")
    with tempfile.TemporaryDirectory(prefix="trend-mac-") as tmp:
        root = Path(tmp) / "distribution"
        bundle = root / APP
        contents = bundle / "Contents"
        resources = contents / "Resources"
        macos, helpers = contents / "MacOS", contents / "Helpers"
        for directory in (resources, macos, helpers):
            directory.mkdir(parents=True, exist_ok=True)
        subprocess.run(["node", str(HERE.parent / "build.mjs"), "--shared-assets", str(resources)], check=True)
        main_program = macos / LAUNCHER
        node = helpers / "node"
        shutil.copyfile(args.launcher, main_program)
        shutil.copyfile(runtime, node)
        main_program.chmod(0o755)
        node.chmod(0o755)
        licenses = resources / "Licenses"
        licenses.mkdir()
        for document in ("LICENSE", "NOTICE"):
            shutil.copyfile(WORK.parent / document, licenses / document)
        shutil.copyfile(args.node_dir / "LICENSE", licenses / "Node.txt")
        for package in ("react", "react-dom", "scheduler", "lucide-react", "tailwindcss"):
            shutil.copyfile(WORK / "chan-market/node_modules" / package / "LICENSE", licenses / (package + ".txt"))
        shutil.copyfile(HERE.parent / "assets/Workbench.icns", resources / "Workbench.icns")
        metadata = {
            "CFBundleDevelopmentRegion": "zh_CN", "CFBundleLocalizations": ["zh_CN", "en"],
            "CFBundleExecutable": LAUNCHER, "CFBundleName": NAME, "CFBundleDisplayName": NAME,
            "CFBundleIdentifier": "app.trendworkbench.desktop", "CFBundleIconFile": "Workbench.icns",
            "CFBundleInfoDictionaryVersion": "6.0", "CFBundlePackageType": "APPL",
            "CFBundleShortVersionString": "1.3.0", "CFBundleVersion": "1.3.0",
            "LSMinimumSystemVersion": "15.0", "LSApplicationCategoryType": "public.app-category.finance",
            "NSHighResolutionCapable": True, "NSPrincipalClass": "NSApplication",
            "NSAppTransportSecurity": {"NSExceptionDomains": {"127.0.0.1": {"NSExceptionAllowsInsecureHTTPLoads": True}}},
        }
        (contents / "Info.plist").write_bytes(plistlib.dumps(metadata))
        (root / "使用说明.txt").write_text(INSTRUCTIONS, encoding="utf-8")
        if args.signer:
            subprocess.run([str(args.signer.resolve()), "sign", "--shallow", "--exclude", "**/node", "--timestamp-url", "none", str(bundle)], check=True)
        else:
            subprocess.run(["/usr/bin/codesign", "--force", "--sign", "-", str(bundle)], check=True)
            subprocess.run(["/usr/bin/codesign", "--verify", "--strict", "--deep", str(bundle)], check=True)
        if sha256(node) != NODE_SHA256:
            raise ValueError("Signing changed the original Node binary")
        if not (contents / "_CodeSignature/CodeResources").is_file():
            raise ValueError("Application resource envelope was not written")
        output.parent.mkdir(parents=True, exist_ok=True)
        # Finish and verify a new ZIP before replacing a previous build.
        with tempfile.NamedTemporaryFile(dir=output.parent, suffix=".partial", delete=False) as temp:
            pending = Path(temp.name)
        try:
            pack_folder(root, pending)
            with zipfile.ZipFile(pending) as archive:
                corrupt = archive.testzip()
                if corrupt:
                    raise ValueError(f"ZIP checksum mismatch for {corrupt}")
            os.replace(pending, output)
        finally:
            pending.unlink(missing_ok=True)
    print(f"{output} ({output.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()

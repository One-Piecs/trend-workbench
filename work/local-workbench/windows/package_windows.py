"""Build a relocatable Windows x64 package from the shared desktop source."""
import argparse
import hashlib
from pathlib import Path
import shutil
import subprocess
import tempfile
import zipfile

HERE = Path(__file__).resolve().parent
NAME = "趋势判断工作台"
NODE_SHA256 = "58e74bf02fc5bbacc41dcb8bef089961cd5bddd37830b87784e4fc624d145d1f"
README = """趋势判断工作台 · Windows x64

在 Windows 10 或 11 上解压整个文件夹，双击「启动工作台.vbs」。
请将目录放在可写入的位置。程序使用系统 Microsoft Edge 打开独立窗口，已包含 Node 运行环境。
在线行情需要网络。关闭工作台窗口后，本机行情服务会退出。

开发者（DeFi狙击手）  https://x.com/bi_9527zx
社区交流  https://t.me/jujishou9527
"""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--node-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    runtime = args.node_dir / "node.exe"
    with runtime.open("rb") as source:
        if hashlib.file_digest(source, "sha256").hexdigest() != NODE_SHA256:
            raise ValueError("Unexpected Node binary, use fetch_runtime.py win-x64")
    with tempfile.TemporaryDirectory(prefix="Trend-Workbench-Windows-") as tmp:
        root = Path(tmp) / NAME
        subprocess.run(["node", str(HERE.parent / "build.mjs"), "--shared-assets", str(root)], check=True)
        for file in ("launcher.ps1", "启动工作台.vbs", "停止本机服务.ps1"):
            shutil.copyfile(HERE / file, root / file)
        (root / "runtime").mkdir()
        shutil.copyfile(runtime, root / "runtime/node.exe")
        shutil.copyfile(HERE.parent / "assets/workbench.ico", root / "工作台.ico")
        (root / "使用说明.txt").write_text(README, encoding="utf-8-sig")
        licenses = root / "Licenses"
        licenses.mkdir()
        for document in ("LICENSE", "NOTICE"):
            shutil.copyfile(HERE.parents[2] / document, root / document)
        shutil.copyfile(args.node_dir / "LICENSE", licenses / "Node.txt")
        for package in ("react", "react-dom", "scheduler", "lucide-react", "tailwindcss"):
            shutil.copyfile(HERE.parent.parent / "chan-market/node_modules" / package / "LICENSE", licenses / (package + ".txt"))
        args.output.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=args.output.parent, delete=False, suffix=".pending") as file:
            pending = Path(file.name)
        try:
            with zipfile.ZipFile(pending, "w", zipfile.ZIP_DEFLATED) as bundle:
                for entry in sorted(root.rglob("*")):
                    if entry.is_file():
                        bundle.write(entry, entry.relative_to(root.parent))
            with zipfile.ZipFile(pending) as bundle:
                if bundle.testzip():
                    raise ValueError("ZIP integrity check failed")
            pending.replace(args.output)
        finally:
            pending.unlink(missing_ok=True)
    print(args.output.resolve())


if __name__ == "__main__":
    main()

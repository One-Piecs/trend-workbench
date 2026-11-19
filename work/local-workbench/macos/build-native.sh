#!/usr/bin/env bash
set -euo pipefail

# Native: ./build-native.sh <output-path>
# Cross:  SDKROOT=/path/to/MacOSX14.5.sdk ZIG=/path/to/zig ./build-native.sh <output-path>
source_dir=$(cd "$(dirname "$0")" && pwd)
output=${1:?Supply the output path for the TrendWorkbench executable}
mkdir -p "$(dirname "$output")"
flags=(-O2 -g0 -fobjc-arc -fblocks -Wall -Wextra -Wno-unused-parameter -Werror=return-type)
if [[ "$(uname -s)" == Darwin && -z "${ZIG:-}" ]]; then
    xcrun --sdk macosx clang -arch arm64 -mmacosx-version-min=14.0 \
        "${flags[@]}" "$source_dir/TrendWorkbench.m" -framework Cocoa -framework WebKit -o "$output"
else
    : "${SDKROOT:?Use a macOS SDK with Apple silicon headers and link stubs}"
    : "${ZIG:?Use a Zig distribution with the Clang frontend}"
    "$ZIG" cc -target aarch64-macos.14.0 -isysroot "$SDKROOT" -isystem "$SDKROOT/usr/include" \
        -iframework "$SDKROOT/System/Library/Frameworks" -F "$SDKROOT/System/Library/Frameworks" -L "$SDKROOT/usr/lib" \
        "${flags[@]}" "$source_dir/TrendWorkbench.m" -framework Cocoa -framework WebKit -lobjc -o "$output"
fi

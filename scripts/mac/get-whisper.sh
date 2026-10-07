#!/usr/bin/env bash
# Builds the speech-to-text engine (whisper.cpp's whisper-cli) for Apple Silicon from the pinned, verified source and
# puts it into --dest (default: resources/whisper), which the .dmg bundles (package.json -> build.extraResources).
# The macOS counterpart of scripts/linux/get-whisper.sh, for the macOS CI job.
#
#   scripts/mac/get-whisper.sh                      -> resources/whisper
#   scripts/mac/get-whisper.sh --dest <folder>
#   JOBS=3 NICE=10 WHISPER_WORK_DIR=<folder> scripts/mac/get-whisper.sh
#
# Source: scripts/whisper-source.mjs fetches the pinned release tag and checks its source-tree SHA-256 first.
#
# Build: arm64, one static executable (no dylibs to sign or find): ggml with Metal for the GPU and the Metal shader
# library embedded in the binary (GGML_METAL_EMBED_LIBRARY), so nothing looks for a .metal / .metallib file at run
# time; Accelerate for BLAS; GGML_NATIVE=OFF with the generic Apple Silicon CPU target, so it runs on every M-series
# Mac (macOS 12 or later). The binary is signed with the app by electron-builder (it is a Mach-O file in Resources).
#
# Writes into --dest: whisper-cli, WHISPER-LICENSE.txt (MIT) and WHISPER-BUILD.txt. Needs Xcode command line tools,
# cmake, node, tar and git (fallback).
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
dest="$root/resources/whisper"
jobs="${JOBS:-2}"
niceness="${NICE:-10}"

usage() { sed -n '2,8p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }
while (($#)); do
  case "$1" in
    -d|--dest) dest="${2:?$1 needs a folder}"; shift 2 ;;
    --dest=*) dest="${1#--dest=}"; shift ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "[ReCut] Unknown option: $1" >&2; usage >&2; exit 2 ;;
    *) dest="$1"; shift ;;
  esac
done

if [[ "$(uname -s)" != Darwin || "$(uname -m)" != arm64 ]]; then
  echo "[ReCut] scripts/mac/get-whisper.sh builds the Apple Silicon engine and must run on an arm64 Mac (this is $(uname -s) $(uname -m))." >&2
  exit 1
fi
for tool in cmake node tar otool codesign; do
  command -v "$tool" >/dev/null 2>&1 || { echo "[ReCut] $tool is required (install it and run again)." >&2; exit 1; }
done

if [[ -n "${WHISPER_WORK_DIR:-}" ]]; then
  work="$WHISPER_WORK_DIR"; mkdir -p "$work"
else
  work="$(mktemp -d "${TMPDIR:-/tmp}/recut-whisper.XXXXXX")"
  trap 'rm -rf "$work"' EXIT
fi
pin_json="$(node "$root/scripts/whisper-source.mjs" --pin)"
pin() { node -e 'console.log(JSON.parse(process.argv[1])[process.argv[2]])' "$pin_json" "$1"; }
tag="$(pin tag)"; commit="$(pin commit)"; tree="$(pin treeSha256)"
if [[ -f "$work/src/.recut-source.txt" && "$(node "$root/scripts/whisper-source.mjs" --hash "$work/src")" == "$tree" ]]; then
  echo "[ReCut] Reusing the verified source in $work/src"
else
  rm -rf "$work/src" "$work/build"
  node "$root/scripts/whisper-source.mjs" --dest "$work/src"
fi

flags=(
  -DCMAKE_BUILD_TYPE=Release
  -DCMAKE_OSX_ARCHITECTURES=arm64
  -DCMAKE_OSX_DEPLOYMENT_TARGET=12.0
  -DBUILD_SHARED_LIBS=OFF
  -DGGML_NATIVE=OFF
  -DGGML_METAL=ON
  -DGGML_METAL_EMBED_LIBRARY=ON
  -DGGML_BLAS=ON
  -DGGML_OPENMP=OFF
  -DGGML_CCACHE=OFF
  -DWHISPER_BUILD_IS_DEV=OFF
  -DWHISPER_BUILD_TESTS=OFF
  -DWHISPER_BUILD_SERVER=OFF
  -DWHISPER_BUILD_EXAMPLES=ON
  -DWHISPER_SDL2=OFF
  -DWHISPER_CURL=OFF
  -DWHISPER_COREML=OFF
  -DWHISPER_ALL_WARNINGS=OFF
)
echo "[ReCut] Configuring whisper.cpp $tag (arm64, Metal)"
cmake -S "$work/src" -B "$work/build" "${flags[@]}" >"$work/configure.log" 2>&1 || { tail -40 "$work/configure.log" >&2; exit 1; }
echo "[ReCut] Building whisper-cli with $jobs jobs"
nice -n "$niceness" cmake --build "$work/build" --config Release -j "$jobs" --target whisper-cli >"$work/build.log" 2>&1 || { tail -60 "$work/build.log" >&2; exit 1; }
bin="$work/build/bin/whisper-cli"
[[ -x "$bin" ]] || { echo "[ReCut] build produced no $bin" >&2; exit 1; }

rm -rf "$dest"; mkdir -p "$dest"
cp "$bin" "$dest/whisper-cli"
strip -x "$dest/whisper-cli"
# Only system libraries and frameworks: nothing from Homebrew or the build folder.
if otool -L "$dest/whisper-cli" | tail -n +2 | awk '{print $1}' | grep -vE '^(/usr/lib/|/System/Library/)'; then
  echo "[ReCut] whisper-cli links to a library outside the system" >&2; exit 1
fi
version_out="$("$dest/whisper-cli" --version 2>&1)"
help_out="$("$dest/whisper-cli" --help 2>&1 || true)"
for opt in --output-json --print-progress --language --translate --threads --output-file; do
  grep -q -- "$opt" <<<"$help_out" || { echo "[ReCut] whisper-cli --help does not list $opt" >&2; exit 1; }
done
grep -q 'GGML_METAL_EMBED_LIBRARY:BOOL=ON' "$work/build/CMakeCache.txt" || { echo '[ReCut] the Metal library is not embedded' >&2; exit 1; }

cp "$work/src/LICENSE" "$dest/WHISPER-LICENSE.txt"
{
  echo "whisper.cpp speech-to-text engine bundled with ReCut"
  echo
  echo "Project:     https://github.com/ggml-org/whisper.cpp (MIT licence, see WHISPER-LICENSE.txt; includes ggml, MIT)"
  echo "Version:     $tag (commit $commit)"
  echo "Source:      https://github.com/ggml-org/whisper.cpp/archive/refs/tags/$tag.tar.gz"
  echo "             (the same files as the tag in git; source-tree SHA-256 $tree, see scripts/whisper-source.mjs)"
  sed 's/^/Fetched:     /' "$work/src/.recut-source.txt" | head -1
  echo "Built:       $(date -u +%Y-%m-%dT%H:%M:%SZ) on macOS $(sw_vers -productVersion) arm64, $(cc --version | head -1), $(cmake --version | head -1)"
  echo "Script:      scripts/mac/get-whisper.sh"
  echo "CMake flags: ${flags[*]}"
  echo "Engine:      $version_out"
  echo
  echo "Linkage of whisper-cli:"
  otool -L "$dest/whisper-cli" | tail -n +2
  echo
  echo "Files:"
  (cd "$dest" && ls -l whisper-cli | awk '{print "  " $5 "  " $NF}')
} >"$dest/WHISPER-BUILD.txt"
echo "[ReCut] whisper.cpp $tag -> $dest ($(stat -f %z "$dest/whisper-cli") bytes): $version_out"

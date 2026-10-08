#!/usr/bin/env bash
# Builds the speech-to-text engine (whisper.cpp's whisper-cli) for macOS from the pinned, verified source, for arm64
# (Apple Silicon, the default) or x64 (Intel), and puts it into --dest (default: resources/whisper), which the .dmg
# bundles (package.json -> build.extraResources). The macOS counterpart of scripts/linux/get-whisper.sh, for the macOS
# CI job (one run per arch).
#
#   scripts/mac/get-whisper.sh                      arm64 -> resources/whisper
#   scripts/mac/get-whisper.sh --arch x64           Intel (or: MAC_ARCH=x64 ...); cross-compiled on Apple Silicon
#   scripts/mac/get-whisper.sh --dest <folder>
#   JOBS=3 NICE=10 WHISPER_WORK_DIR=<folder> scripts/mac/get-whisper.sh
#
# Source: scripts/whisper-source.mjs fetches the pinned release tag and checks its source-tree SHA-256 first. Both
# archs are built from the same source.
#
# arm64 build: one static executable (no dylibs to sign or find): ggml with Metal for the GPU and the Metal shader
# library embedded in the binary (GGML_METAL_EMBED_LIBRARY), so nothing looks for a .metal / .metallib file at run
# time; no BLAS backend (GGML_BLAS=OFF: ggml's Accelerate BLAS backend uses Accelerate's new BLAS interface, which
# exists only from macOS 13.3, so whisper-cli would not load on macOS 12.0-13.2; Metal does the heavy work and the CPU
# fallback uses ggml's own kernels, as on the other platforms); GGML_NATIVE=OFF with the generic Apple Silicon CPU
# target, so it runs on every M-series Mac (macOS 12 or later). Must be built on an Apple Silicon Mac.
#
# x64 build (Intel Macs): CPU only, no Metal and no BLAS backend, built like the Linux and Windows engines: shared ggml
# with the CPU kernels as loadable modules (GGML_BACKEND_DL + GGML_CPU_ALL_VARIANTS, GGML_NATIVE=OFF), so at start
# ggml loads the best of five variants the CPU supports: x64 (any x86-64), sse42, sandybridge (AVX), haswell (AVX2 +
# FMA + F16C) and skylakex (AVX-512). CMAKE_OSX_ARCHITECTURES=x86_64 and a macOS 12.0 deployment target: on an Apple
# Silicon Mac this cross-compiles, and the result is then run (--version, --help) under Rosetta 2. Files:
# whisper-cli, libwhisper / libggml / libggml-base (.dylib, found through the rpath @loader_path) and
# libggml-cpu-<variant>.so (found by ggml next to whisper-cli). Every Mach-O file is checked to be x86_64 only, to
# need at most macOS 12.0 and to load nothing outside the folder but macOS's own libraries.
#
# Either way the files are signed with the app by electron-builder (they are Mach-O files in Resources). Writes into
# --dest, besides the engine files: WHISPER-LICENSE.txt (MIT) and WHISPER-BUILD.txt. Needs Xcode command line tools,
# cmake, node, tar and git (fallback).
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
dest="$root/resources/whisper"
jobs="${JOBS:-2}"
niceness="${NICE:-10}"
arch="${MAC_ARCH:-arm64}"

usage() { sed -n '2,10p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }
while (($#)); do
  case "$1" in
    -d|--dest) dest="${2:?$1 needs a folder}"; shift 2 ;;
    --dest=*) dest="${1#--dest=}"; shift ;;
    -a|--arch) arch="${2:?$1 needs arm64 or x64}"; shift 2 ;;
    --arch=*) arch="${1#--arch=}"; shift ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "[ReCut] Unknown option: $1" >&2; usage >&2; exit 2 ;;
    *) dest="$1"; shift ;;
  esac
done

case "$arch" in
  arm64|aarch64) arch='arm64'; lipo_arch='arm64' ;;
  x64|x86_64|intel) arch='x64'; lipo_arch='x86_64' ;;
  *) echo "[ReCut] Unknown arch: $arch (use arm64 or x64)" >&2; exit 2 ;;
esac
# Keep in step with package.json -> build.mac.minimumSystemVersion.
min_macos='12.0'
# x64: CPU kernel variants to ship (see "x64 build" above); ggml picks the best one this CPU supports at start.
CPU_VARIANTS=(x64 sse42 sandybridge haswell skylakex)

if [[ "$(uname -s)" != Darwin ]]; then
  echo "[ReCut] scripts/mac/get-whisper.sh builds the macOS engine and must run on a Mac (this is $(uname -s) $(uname -m))." >&2
  exit 1
fi
if [[ "$arch" == arm64 && "$(uname -m)" != arm64 ]]; then
  echo "[ReCut] the arm64 (Metal) engine must be built on an Apple Silicon Mac (this is $(uname -m))." >&2
  exit 1
fi
# The x64 engine is run after the build: natively on an Intel Mac, under Rosetta 2 on Apple Silicon.
if [[ "$arch" == x64 ]] && ! /usr/bin/arch -x86_64 /usr/bin/true 2>/dev/null; then
  echo '[ReCut] the x64 engine cannot run here to be checked: on Apple Silicon install Rosetta 2 first (softwareupdate --install-rosetta --agree-to-license).' >&2
  exit 1
fi
for tool in cmake node tar otool lipo nm strip file codesign; do
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
  rm -rf "$work/src" "$work"/build-*
  node "$root/scripts/whisper-source.mjs" --dest "$work/src"
fi
# A build folder configured for the other arch is not reused.
build="$work/build-$arch"

common_flags=(
  -DCMAKE_BUILD_TYPE=Release
  -DCMAKE_OSX_DEPLOYMENT_TARGET="$min_macos"
  -DGGML_NATIVE=OFF
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
if [[ "$arch" == arm64 ]]; then
  flags=(
    -DCMAKE_OSX_ARCHITECTURES=arm64
    -DBUILD_SHARED_LIBS=OFF
    -DGGML_METAL=ON
    -DGGML_METAL_EMBED_LIBRARY=ON
    -DGGML_BLAS=OFF
    "${common_flags[@]}"
  )
  what='arm64, Metal'
else
  flags=(
    -DCMAKE_OSX_ARCHITECTURES=x86_64
    -DBUILD_SHARED_LIBS=ON
    -DGGML_BACKEND_DL=ON
    -DGGML_CPU_ALL_VARIANTS=ON
    -DGGML_METAL=OFF
    -DGGML_BLAS=OFF
    -DCMAKE_BUILD_WITH_INSTALL_RPATH=ON
    -DCMAKE_INSTALL_RPATH=@loader_path
    "${common_flags[@]}"
  )
  what='x86_64, CPU variants'
fi
echo "[ReCut] Configuring whisper.cpp $tag ($what)"
cmake -S "$work/src" -B "$build" "${flags[@]}" >"$work/configure-$arch.log" 2>&1 || { tail -40 "$work/configure-$arch.log" >&2; exit 1; }
# For x64, building whisper-cli builds every CPU variant too (ggml depends on its backend modules).
echo "[ReCut] Building whisper-cli with $jobs jobs"
nice -n "$niceness" cmake --build "$build" --config Release -j "$jobs" --target whisper-cli >"$work/compile-$arch.log" 2>&1 || { tail -60 "$work/compile-$arch.log" >&2; exit 1; }
bin="$build/bin"
[[ -x "$bin/whisper-cli" ]] || { echo "[ReCut] build produced no $bin/whisper-cli" >&2; exit 1; }

rm -rf "$dest"; mkdir -p "$dest"
cp "$bin/whisper-cli" "$dest/whisper-cli"
if [[ "$arch" == x64 ]]; then
  # The libraries whisper-cli loads through @rpath, under their install names, as plain files (no symlinks).
  queue=("$dest/whisper-cli")
  while ((${#queue[@]})); do
    f="${queue[0]}"; queue=("${queue[@]:1}")
    while read -r lib; do
      [[ "$lib" == @rpath/* ]] || continue
      n="${lib#@rpath/}"
      [[ -e "$dest/$n" ]] && continue
      src="$(find "$build" -name "$n" \( -type f -o -type l \) -print -quit)"
      [[ -n "$src" ]] || { echo "[ReCut] $(basename "$f") needs $n, which the build did not produce" >&2; exit 1; }
      cp -L "$src" "$dest/$n"
      queue+=("$dest/$n")
    done < <(otool -L "$f" | tail -n +2 | awk '{print $1}')
  done
  # The CPU variants: modules ggml dlopen()s from the executable's folder (not link dependencies of whisper-cli).
  for v in "${CPU_VARIANTS[@]}"; do
    m="$(find "$build" -name "libggml-cpu-$v.so" \( -type f -o -type l \) -print -quit)"
    [[ -n "$m" ]] || { echo "[ReCut] whisper.cpp $tag built no libggml-cpu-$v.so (built: $(cd "$bin" && ls libggml-cpu-*.so 2>/dev/null | tr '\n' ' '))" >&2; exit 1; }
    cp -L "$m" "$dest/libggml-cpu-$v.so"
  done
fi
machos=()
for f in "$dest"/*; do
  case "$(file -b "$f")" in Mach-O*) machos+=("$f") ;; esac
done
strip -x "${machos[@]}"

# Prints "1" when version $1 (like 12.0 or 11.3.1) is newer than $2, else "0".
version_gt() {
  local IFS=.
  local -a a b
  read -r -a a <<<"$1"
  read -r -a b <<<"$2"
  local i x y
  for i in 0 1 2; do
    x="${a[$i]:-0}"; y="${b[$i]:-0}"
    if ((10#$x > 10#$y)); then echo 1; return; fi
    if ((10#$x < 10#$y)); then echo 0; return; fi
  done
  echo 0
}
# Every Mach-O file: only this arch, at most macOS $min_macos, only system libraries or our own (@rpath, in the folder),
# rpaths relative to the file (never the build folder).
for f in "${machos[@]}"; do
  name="$(basename "$f")"
  got="$(lipo -archs "$f")"
  [[ "$got" == "$lipo_arch" ]] || { echo "[ReCut] $name is $got, not $lipo_arch" >&2; exit 1; }
  hdr="$(otool -l "$f")"
  minos="$(awk '/cmd LC_BUILD_VERSION/ { b = 1 } b && $1 == "minos" { print $2; exit }' <<<"$hdr")"
  [[ -n "$minos" ]] || minos="$(awk '/cmd LC_VERSION_MIN_MACOSX/ { b = 1 } b && $1 == "version" { print $2; exit }' <<<"$hdr")"
  [[ -n "$minos" ]] || { echo "[ReCut] $name does not say which macOS version it needs" >&2; exit 1; }
  [[ "$(version_gt "$minos" "$min_macos")" == 0 ]] || { echo "[ReCut] $name needs macOS $minos; ReCut supports macOS $min_macos" >&2; exit 1; }
  while read -r rp; do
    [[ -z "$rp" || "$rp" == @* ]] || { echo "[ReCut] $name has the rpath $rp (only @loader_path / @executable_path are allowed)" >&2; exit 1; }
  done < <(awk '/cmd LC_RPATH/ { r = 1; next } r && $1 == "path" { print $2; r = 0 }' <<<"$hdr")
  while read -r lib; do
    [[ -n "$lib" ]] || continue
    case "$lib" in
      /usr/lib/*|/System/Library/*) ;;
      @rpath/*) [[ -f "$dest/${lib#@rpath/}" ]] || { echo "[ReCut] $name needs $lib, which is not in $dest" >&2; exit 1; } ;;
      *) echo "[ReCut] $name links to $lib, outside the system and the engine folder" >&2; otool -L "$f" >&2; exit 1 ;;
    esac
  done < <(otool -L "$f" | tail -n +2 | awk '{print $1}')
  # Accelerate's new (ILP64) BLAS / LAPACK interface exists only from macOS 13.3, newer than the macOS $min_macos
  # target: its symbols are weak imports that are missing on macOS 12.0-13.2, so the engine would not load there.
  # Both archs: any such import fails the build.
  if nm -u "$f" 2>/dev/null | grep -q 'NEWLAPACK'; then
    echo "[ReCut] $name imports Accelerate's new BLAS interface, which needs macOS 13.3 (the target is macOS $min_macos):" >&2
    nm -u "$f" | grep 'NEWLAPACK' >&2
    exit 1
  fi
done
if [[ "$arch" == x64 ]]; then
  otool -l "$dest/whisper-cli" | grep -q 'path @loader_path ' || { echo '[ReCut] whisper-cli has no @loader_path rpath' >&2; exit 1; }
fi

version_out="$("$dest/whisper-cli" --version 2>&1)"
help_out="$("$dest/whisper-cli" --help 2>&1 || true)"
for opt in --output-json --print-progress --language --translate --threads --output-file; do
  grep -q -- "$opt" <<<"$help_out" || { echo "[ReCut] whisper-cli --help does not list $opt" >&2; exit 1; }
done
if [[ "$arch" == arm64 ]]; then
  grep -q 'GGML_METAL_EMBED_LIBRARY:BOOL=ON' "$build/CMakeCache.txt" || { echo '[ReCut] the Metal library is not embedded' >&2; exit 1; }
else
  grep -q 'GGML_METAL:BOOL=OFF' "$build/CMakeCache.txt" || { echo '[ReCut] the x64 engine was configured with Metal' >&2; exit 1; }
fi
host="$(uname -m)"
if [[ "$arch" == x64 && "$host" == arm64 ]]; then host='arm64 (cross-compiled for x86_64; checked under Rosetta 2)'; fi

cp "$work/src/LICENSE" "$dest/WHISPER-LICENSE.txt"
{
  echo "whisper.cpp speech-to-text engine bundled with ReCut"
  echo
  echo "Project:     https://github.com/ggml-org/whisper.cpp (MIT licence, see WHISPER-LICENSE.txt; includes ggml, MIT)"
  echo "Version:     $tag (commit $commit)"
  echo "Source:      https://github.com/ggml-org/whisper.cpp/archive/refs/tags/$tag.tar.gz"
  echo "             (the same files as the tag in git; source-tree SHA-256 $tree, see scripts/whisper-source.mjs)"
  sed 's/^/Fetched:     /' "$work/src/.recut-source.txt" | head -1
  echo "Platform:    $lipo_arch macOS, minimum macOS $min_macos"
  echo "Built:       $(date -u +%Y-%m-%dT%H:%M:%SZ) on macOS $(sw_vers -productVersion) $host, $(cc --version | head -1), $(cmake --version | head -1)"
  echo "Script:      scripts/mac/get-whisper.sh --arch $arch"
  echo "CMake flags: ${flags[*]}"
  if [[ "$arch" == x64 ]]; then echo "CPU variants: ${CPU_VARIANTS[*]}"; fi
  echo "Engine:      $version_out"
  echo
  echo "Linkage of whisper-cli:"
  otool -L "$dest/whisper-cli" | tail -n +2
  echo
  echo "Files:"
  (cd "$dest" && for f in whisper-cli *.dylib *.so; do if [[ -f "$f" ]]; then echo "  $(stat -f %z "$f")  $f"; fi; done)
} >"$dest/WHISPER-BUILD.txt"
bytes="$(for f in "${machos[@]}"; do stat -f %z "$f"; done | awk '{ s += $1 } END { print s + 0 }')"
echo "[ReCut] whisper.cpp $tag ($lipo_arch) -> $dest (${#machos[@]} files, $bytes bytes): $version_out"

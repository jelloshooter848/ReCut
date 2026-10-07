#!/usr/bin/env bash
# Builds the speech-to-text engine (whisper.cpp's whisper-cli, CPU only) from the pinned, verified source and puts
# it into --dest (default: resources/whisper), which the AppImage bundles (package.json -> build.extraResources).
# Used by the Linux CI job (.github/workflows/windows.yml, job "linux") and for local builds.
#
#   scripts/linux/get-whisper.sh                    -> resources/whisper
#   scripts/linux/get-whisper.sh --dest <folder>    (or: scripts/linux/get-whisper.sh <folder>)
#   JOBS=2 NICE=10 scripts/linux/get-whisper.sh     parallel compile jobs (default 2) and niceness (default 10)
#   WHISPER_WORK_DIR=<folder> ...                   keep the source and build there (incremental rebuilds)
#
# Source: scripts/whisper-source.mjs fetches the pinned release tag (tarball, or a git clone of the tag) and checks
# its source-tree SHA-256 before anything is compiled.
#
# Build: shared ggml with the CPU kernels as loadable backends (GGML_BACKEND_DL + GGML_CPU_ALL_VARIANTS,
# GGML_NATIVE=OFF): at start ggml loads the best variant this CPU supports, so one build runs on any x86-64 PC and
# still uses AVX2 / AVX-512 where present. Five variants ship (CPU_VARIANTS, about 1-1.4 MB each): x64 (any x86-64),
# sse42, sandybridge (AVX), haswell (AVX2 + FMA + F16C) and skylakex (AVX-512). The others ggml offers (ivybridge,
# piledriver, alderlake, icelake, zen4, sapphirerapids...) add VNNI / BF16 / AMX kernels that speed up quantized
# models; ReCut's models are f16, so the nearest variant below them runs at practically the same speed. No OpenMP
# (ggml's own thread pool), libstdc++ and libgcc linked statically, RPATH $ORIGIN: the folder needs nothing beyond
# glibc.
#
# Writes into --dest: whisper-cli, libwhisper.so.1, libggml.so.0, libggml-base.so.0, libggml-cpu-*.so, WHISPER-LICENSE.txt (MIT) and
# WHISPER-BUILD.txt (tag, commit, source hash, flags, linkage, `whisper-cli --version`). Needs cmake, a C/C++
# compiler, node, tar, git (fallback) and ldd.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
dest="$root/resources/whisper"
jobs="${JOBS:-2}"
niceness="${NICE:-10}"

usage() { sed -n '2,9p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }
while (($#)); do
  case "$1" in
    -d|--dest) dest="${2:?$1 needs a folder}"; shift 2 ;;
    --dest=*) dest="${1#--dest=}"; shift ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "[ReCut] Unknown option: $1" >&2; usage >&2; exit 2 ;;
    *) dest="$1"; shift ;;
  esac
done

if [[ "$(uname -s)" != Linux || "$(uname -m)" != x86_64 ]]; then
  echo "[ReCut] scripts/linux/get-whisper.sh builds the x86-64 Linux engine and must run on x86-64 Linux (this is $(uname -s) $(uname -m))." >&2
  exit 1
fi
for tool in cmake node tar ldd objdump strip c++ cc; do
  command -v "$tool" >/dev/null 2>&1 || { echo "[ReCut] $tool is required (install it and run again)." >&2; exit 1; }
done

# glibc's own libraries and the loader: anything else would make the AppImage depend on the user's distribution.
# (libggml*/libwhisper are ours, found through RPATH $ORIGIN.)
allowed_libs='^(linux-vdso\.so\.1|ld-linux-x86-64\.so\.2|libc\.so\.6|libm\.so\.6|libdl\.so\.2|librt\.so\.1|libpthread\.so\.0|libmvec\.so\.1|libwhisper\.so\.[0-9]+|libggml\.so\.[0-9]+|libggml-base\.so\.[0-9]+)$'

# WHISPER_WORK_DIR keeps the source and the build between runs (an incremental rebuild); default: a temp folder.
if [[ -n "${WHISPER_WORK_DIR:-}" ]]; then
  work="$WHISPER_WORK_DIR"
  mkdir -p "$work"
else
  work="$(mktemp -d "${TMPDIR:-/tmp}/recut-whisper.XXXXXX")"
  trap 'rm -rf "$work"' EXIT
fi

if [[ -f "$work/src/.recut-source.txt" ]] && [[ "$(node "$root/scripts/whisper-source.mjs" --hash "$work/src")" == "$(node -e 'console.log(JSON.parse(process.argv[1]).treeSha256)' "$(node "$root/scripts/whisper-source.mjs" --pin)")" ]]; then
  echo "[ReCut] Reusing the verified source in $work/src"
else
  rm -rf "$work/src" "$work/build"
  node "$root/scripts/whisper-source.mjs" --dest "$work/src"
fi
pin_json="$(node "$root/scripts/whisper-source.mjs" --pin)"
tag="$(node -e 'console.log(JSON.parse(process.argv[1]).tag)' "$pin_json")"
commit="$(node -e 'console.log(JSON.parse(process.argv[1]).commit)' "$pin_json")"
tree="$(node -e 'console.log(JSON.parse(process.argv[1]).treeSha256)' "$pin_json")"

# CPU kernel variants to ship (see "Build:" above); ggml picks the best one this CPU supports at start.
CPU_VARIANTS=(x64 sse42 sandybridge haswell skylakex)

static_rt='-static-libstdc++ -static-libgcc'
flags=(
  -DCMAKE_BUILD_TYPE=Release
  -DBUILD_SHARED_LIBS=ON
  -DGGML_BACKEND_DL=ON
  -DGGML_CPU_ALL_VARIANTS=ON
  -DGGML_NATIVE=OFF
  -DGGML_OPENMP=OFF
  -DGGML_CCACHE=OFF
  -DWHISPER_BUILD_IS_DEV=OFF
  -DWHISPER_BUILD_TESTS=OFF
  -DWHISPER_BUILD_SERVER=OFF
  -DWHISPER_BUILD_EXAMPLES=ON
  -DWHISPER_SDL2=OFF
  -DWHISPER_CURL=OFF
  -DWHISPER_ALL_WARNINGS=OFF
  "-DCMAKE_EXE_LINKER_FLAGS=$static_rt"
  "-DCMAKE_SHARED_LINKER_FLAGS=$static_rt"
  "-DCMAKE_MODULE_LINKER_FLAGS=$static_rt"
  '-DCMAKE_BUILD_RPATH=$ORIGIN'
  -DCMAKE_BUILD_WITH_INSTALL_RPATH=ON
  '-DCMAKE_INSTALL_RPATH=$ORIGIN'
)
generator=()
command -v ninja >/dev/null 2>&1 && generator=(-G Ninja)

echo "[ReCut] Configuring whisper.cpp $tag"
cmake -S "$work/src" -B "$work/build" "${generator[@]}" "${flags[@]}" >"$work/configure.log" 2>&1 || { tail -40 "$work/configure.log" >&2; exit 1; }
# whisper-cli and the CPU backend variants (loadable modules, not link dependencies of whisper-cli).
mapfile -t all_cpu_targets < <(cmake --build "$work/build" --target help | sed -n 's/^\(\.\.\. \)\{0,1\}\(ggml-cpu-[A-Za-z0-9_.]*\)\(:.*\)\{0,1\}$/\2/p' | sort -u)
cpu_targets=()
for v in "${CPU_VARIANTS[@]}"; do
  [[ " ${all_cpu_targets[*]} " == *" ggml-cpu-$v "* ]] || { echo "[ReCut] whisper.cpp $tag has no CPU variant '$v' (it has: ${all_cpu_targets[*]})" >&2; exit 1; }
  cpu_targets+=("ggml-cpu-$v")
done
echo "[ReCut] Building whisper-cli and ${#cpu_targets[@]} CPU variants (${cpu_targets[*]}) with $jobs jobs"
nice -n "$niceness" cmake --build "$work/build" --config Release -j "$jobs" --target whisper-cli "${cpu_targets[@]}" >"$work/build.log" 2>&1 || { tail -60 "$work/build.log" >&2; exit 1; }

bin="$work/build/bin"
[[ -x "$bin/whisper-cli" ]] || { echo "[ReCut] build produced no $bin/whisper-cli" >&2; exit 1; }

rm -rf "$dest"
mkdir -p "$dest"
cp "$bin/whisper-cli" "$dest/"
# Shared libraries under the name the loader looks for (their SONAME, e.g. libggml.so.0), as plain files; the CPU
# variants are dlopen()ed modules without a SONAME and keep their file name. Only what whisper-cli needs is kept.
soname() { objdump -p "$1" 2>/dev/null | sed -n 's/^ *SONAME *//p'; }
needed() { objdump -p "$1" 2>/dev/null | sed -n 's/^ *NEEDED *//p'; }
declare -A by_soname=()
while IFS= read -r -d '' lib; do
  n="$(soname "$lib")"
  [[ -n "$n" && -z "${by_soname[$n]:-}" ]] && by_soname[$n]="$lib"
done < <(find "$work/build" -name 'lib*.so*' \( -type f -o -type l \) -print0)
queue=("$dest/whisper-cli")
while ((${#queue[@]})); do
  f="${queue[0]}"; queue=("${queue[@]:1}")
  while read -r n; do
    [[ -z "$n" || -e "$dest/$n" || -z "${by_soname[$n]:-}" ]] && continue
    cp -L "${by_soname[$n]}" "$dest/$n"
    queue+=("$dest/$n")
  done < <(needed "$f")
done
for t in "${cpu_targets[@]}"; do
  m="$(find "$work/build" -name "lib$t.so" \( -type f -o -type l \) -print -quit)"
  [[ -n "$m" ]] || { echo "[ReCut] built no lib$t.so" >&2; exit 1; }
  cp -L "$m" "$dest/lib$t.so"
done
strip --strip-unneeded "$dest/whisper-cli" "$dest"/*.so*

# Linkage: every file needs only glibc and our own libraries.
linkage=''
for f in "$dest/whisper-cli" "$dest"/*.so*; do
  while read -r lib _; do
    [[ -z "$lib" || "$lib" == statically ]] && continue
    lib="$(basename "$lib")"
    [[ "$lib" =~ $allowed_libs ]] || { echo "[ReCut] $(basename "$f") links to $lib, which is not allowed in the bundle" >&2; ldd "$f" >&2; exit 1; }
  done < <(ldd "$f" | sed -e 's/=>.*//' -e 's/(0x[0-9a-f]*)//')
done
linkage="$(ldd "$dest/whisper-cli" | sed 's/ (0x[0-9a-f]*)//' | sed 's/^\s*/  /')"
glibc_max="$(objdump -T "$dest/whisper-cli" "$dest"/*.so* 2>/dev/null | grep -o 'GLIBC_[0-9.]*' | sort -uV | tail -1 || true)"

# Run it: --version, and --help must list the options ReCut passes.
version_out="$("$dest/whisper-cli" --version 2>&1)"
help_out="$("$dest/whisper-cli" --help 2>&1 || true)"
for opt in --output-json --print-progress --language --translate --threads --output-file --no-prints; do
  grep -q -- "$opt" <<<"$help_out" || { echo "[ReCut] whisper-cli --help does not list $opt" >&2; exit 1; }
done

cp "$work/src/LICENSE" "$dest/WHISPER-LICENSE.txt"
{
  echo "whisper.cpp speech-to-text engine bundled with ReCut"
  echo
  echo "Project:     https://github.com/ggml-org/whisper.cpp (MIT licence, see WHISPER-LICENSE.txt; includes ggml, MIT)"
  echo "Version:     $tag (commit $commit)"
  echo "Source:      https://github.com/ggml-org/whisper.cpp/archive/refs/tags/$tag.tar.gz"
  echo "             (the same files as the tag in git; source-tree SHA-256 $tree, see scripts/whisper-source.mjs)"
  sed 's/^/Fetched:     /' "$work/src/.recut-source.txt" | head -1
  echo "Built:       $(date -u +%Y-%m-%dT%H:%M:%SZ) on $(uname -s) $(uname -m), $(c++ --version | head -1), $(cmake --version | head -1)"
  echo "Script:      scripts/linux/get-whisper.sh"
  echo "CMake flags: ${flags[*]}"
  echo "CPU variants: ${cpu_targets[*]#ggml-cpu-}"
  echo "Newest glibc symbol: ${glibc_max:-unknown}"
  echo "Engine:      $version_out"
  echo
  echo "Linkage of whisper-cli:"
  echo "$linkage"
  echo
  echo "Files:"
  (cd "$dest" && ls -l whisper-cli lib*.so* | awk '{print "  " $5 "  " $NF}')
} >"$dest/WHISPER-BUILD.txt"

bytes="$(du -cb "$dest"/whisper-cli "$dest"/*.so* | tail -1 | cut -f1)"
echo "[ReCut] whisper.cpp $tag -> $dest ($bytes bytes): $version_out"

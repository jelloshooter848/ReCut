#!/usr/bin/env bash
# Downloads an x86-64 Linux FFmpeg build and copies ffmpeg + ffprobe into --dest (default: resources/ffmpeg).
# The Linux counterpart of scripts/windows/get-ffmpeg.ps1. Used by the Linux CI build (.github/workflows/windows.yml,
# job "linux"), which packages the folder into the AppImage (package.json -> build.extraResources).
#
#   scripts/linux/get-ffmpeg.sh                     -> resources/ffmpeg
#   scripts/linux/get-ffmpeg.sh --dest <folder>     (or: scripts/linux/get-ffmpeg.sh <folder>)
#
# Next to the executables it also writes what a redistributed GPL FFmpeg build must come with:
#   FFMPEG-LICENSE.txt  the licence file shipped in the downloaded archive (GPL for these builds)
#   FFMPEG-README.txt   the archive's readme, when it has one (the BtbN Linux builds have none)
#   FFMPEG-BUILD.txt    source URL, build name, platform, `ffmpeg -version` output, date, and where to get the
#                       corresponding source
# A download whose archive has no licence file is rejected and the next source is tried.
#
# The binaries must run on a typical desktop distribution without a system FFmpeg, so a download is also rejected
# unless both programs are x86-64 ELF files that are statically linked or link only to glibc's own libraries
# (libc, libm, libdl, librt, libpthread, libmvec, the loader) and libgcc_s. They are then run once (-version and a
# tiny libx264 encode) before the script succeeds. Must run on x86-64 Linux; needs bash, curl, tar with xz and ldd.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
dest="$root/resources/ffmpeg"

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

# Release-branch builds only: FFmpeg development ("master") builds have shipped encoder bugs that hang exports.
# BtbN's rolling "latest" release keeps one build per release branch; these URLs stay stable across rebuilds.
# (johnvansickle.com static builds are not used: not reachable from every build environment.)
sources=(
  'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n9.0-latest-linux64-gpl-9.0.tar.xz'  # 9.0 release branch
  'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n8.1-latest-linux64-gpl-8.1.tar.xz'  # fallback: 8.1 release branch
)
# Files this script writes next to the executables (removed first, so a previous build's files never linger).
extra_files=('FFMPEG-LICENSE.txt' 'FFMPEG-README.txt' 'FFMPEG-BUILD.txt')
# Shared libraries a bundled binary may load: glibc's own libraries, the kernel vDSO and libgcc_s (present on every
# glibc system). Anything else (libx264.so, libva.so, a system libavcodec...) would make the AppImage depend on
# what the user's distribution happens to have installed.
allowed_libs='^(linux-vdso\.so\.1|ld-linux-x86-64\.so\.2|libc\.so\.6|libm\.so\.6|libdl\.so\.2|librt\.so\.1|libpthread\.so\.0|libmvec\.so\.1|libresolv\.so\.2|libutil\.so\.1|libgcc_s\.so\.1)$'

if [[ "$(uname -s)" != Linux || "$(uname -m)" != x86_64 ]]; then
  echo "[ReCut] scripts/linux/get-ffmpeg.sh downloads x86-64 Linux binaries and must run on x86-64 Linux (this is $(uname -s) $(uname -m))." >&2
  exit 1
fi
for tool in curl tar xz ldd od; do
  command -v "$tool" >/dev/null 2>&1 || { echo "[ReCut] $tool is required (install it and run again)." >&2; exit 1; }
done

work="$(mktemp -d "${TMPDIR:-/tmp}/recut-ffmpeg.XXXXXX")"
trap 'rm -rf "$work"' EXIT

attempt_error=''
fail() { attempt_error="$*"; return 1; }

# The licence or readme file at the top of the extracted build (the folder above bin/), else the first file anywhere in
# the archive with one of these exact names (case-insensitive). Names are tried in order. Prints the path, or nothing.
find_build_file() {
  local root_dir="$1" build_dir="$2" n f
  shift 2
  for n in "$@"; do
    if [[ -f "$build_dir/$n" ]]; then printf '%s\n' "$build_dir/$n"; return 0; fi
  done
  for n in "$@"; do
    f="$(find "$root_dir" -type f -iname "$n" -print -quit)"
    if [[ -n "$f" ]]; then printf '%s\n' "$f"; return 0; fi
  done
  return 0
}

# Checks that $1 is an x86-64 ELF executable that is static or needs only $allowed_libs. Sets $linkage to a
# description for FFMPEG-BUILD.txt.
linkage=''
check_binary() {
  local f="$1" name magic machine out lib bad=() libs=()
  name="$(basename "$f")"
  magic="$(od -An -c -N4 "$f" | tr -d ' ')"
  [[ "$magic" == '177ELF' ]] || { fail "$name is not an ELF executable"; return 1; }
  machine="$(od -An -tx1 -j18 -N2 "$f" | tr -d ' \n')"
  [[ "$machine" == '3e00' ]] || { fail "$name is not an x86-64 executable (ELF machine $machine)"; return 1; }
  if ! out="$(LC_ALL=C ldd "$f" 2>&1)"; then
    if grep -qE 'not a dynamic executable|statically linked' <<<"$out"; then
      linkage='statically linked (no shared libraries)'
      return 0
    fi
    fail "ldd $name failed: $out"; return 1
  fi
  if grep -qE 'statically linked' <<<"$out"; then
    linkage='statically linked (no shared libraries)'
    return 0
  fi
  if grep -q 'not found' <<<"$out"; then fail "$name needs shared libraries this system does not have: $(grep 'not found' <<<"$out" | tr -s ' \t' ' ')"; return 1; fi
  while read -r lib _; do
    [[ -n "$lib" ]] || continue
    lib="$(basename "$lib")"
    libs+=("$lib")
    [[ "$lib" =~ $allowed_libs ]] || bad+=("$lib")
  done <<<"$out"
  if ((${#bad[@]})); then fail "$name links to shared libraries outside glibc: ${bad[*]}"; return 1; fi
  local glibc
  glibc="$(grep -aoE 'GLIBC_2\.[0-9]+' "$f" | sort -uV | tail -n 1 || true)"
  linkage="dynamically linked against glibc only ($(printf '%s\n' "${libs[@]}" | grep -vE '^(linux-vdso|ld-linux)' | sort -u | paste -sd ' ' -))"
  [[ -n "$glibc" ]] && linkage="$linkage; needs glibc ${glibc#GLIBC_} or newer"
  return 0
}

# Where to get the source corresponding to this build, from the download URL and the version string.
source_info() {
  local url="$1" v="$2"
  if [[ "$url" == *BtbN/FFmpeg-Builds* ]]; then
    echo 'Build provider: BtbN/FFmpeg-Builds (GitHub), linux64 GPL build.'
    echo 'Downloaded from the rolling "latest" release: https://github.com/BtbN/FFmpeg-Builds/releases/tag/latest'
    echo 'Dated releases (the date at the end of the version string is the build date): https://github.com/BtbN/FFmpeg-Builds/releases'
    echo "Build scripts (they pin every library's source revision): https://github.com/BtbN/FFmpeg-Builds"
    if [[ "$v" =~ -g([0-9a-f]{7,40})(-|$) ]]; then
      echo "FFmpeg source commit: https://github.com/FFmpeg/FFmpeg/commit/${BASH_REMATCH[1]}"
      echo "FFmpeg source archive: https://github.com/FFmpeg/FFmpeg/archive/${BASH_REMATCH[1]}.tar.gz"
    elif [[ "$v" =~ ^(n[0-9]+(\.[0-9]+)*)(-[0-9]{8})?$ ]]; then
      echo "FFmpeg source tag: https://github.com/FFmpeg/FFmpeg/releases/tag/${BASH_REMATCH[1]}"
      echo "FFmpeg source archive: https://github.com/FFmpeg/FFmpeg/archive/refs/tags/${BASH_REMATCH[1]}.tar.gz"
    else
      echo 'FFmpeg source: https://github.com/FFmpeg/FFmpeg (match the version string below)'
    fi
    echo 'The external libraries compiled into this build (libx264 and others) are listed in the "configuration:" line below.'
  else
    echo 'FFmpeg source: https://ffmpeg.org/download.html#get-sources (match the version string below)'
  fi
}

try_source() {
  local url="$1" archive="$work/download" tmp="$work/x"
  rm -rf "$archive" "$tmp"
  mkdir -p "$tmp"
  echo "[ReCut] Downloading FFmpeg from $url"
  curl -fL --retry 3 --retry-delay 2 --connect-timeout 30 -sS -o "$archive" "$url" || { fail 'download failed'; return 1; }
  # ffplay is not needed (and is as large as ffmpeg).
  tar -xJf "$archive" -C "$tmp" --exclude='*/ffplay' || { fail 'could not extract the archive (tar.xz expected)'; return 1; }
  rm -f "$archive"

  # Check the whole download before touching $dest.
  local exe src ffmpeg_src='' ffprobe_src='' ffmpeg_linkage=''
  for exe in ffmpeg ffprobe; do
    src="$(find "$tmp" -type f -name "$exe" -print -quit)"
    [[ -n "$src" ]] || { fail "$exe not found in the download"; return 1; }
    check_binary "$src" || return 1
    if [[ "$exe" == ffmpeg ]]; then ffmpeg_src="$src"; ffmpeg_linkage="$linkage"; else ffprobe_src="$src"; fi
  done
  # Archive layout: <build name>/bin/ffmpeg, with LICENSE.txt next to bin/.
  local bin_dir build_dir build_name licence readme
  bin_dir="$(dirname "$ffmpeg_src")"
  build_dir="$bin_dir"
  [[ "$(basename "$bin_dir")" == bin && "$bin_dir" != "$tmp" ]] && build_dir="$(dirname "$bin_dir")"
  if [[ "$build_dir" == "$tmp" ]]; then
    build_name="$(basename "${url%%\?*}")"; build_name="${build_name%.tar.xz}"
  else
    build_name="$(basename "$build_dir")"
  fi
  licence="$(find_build_file "$tmp" "$build_dir" LICENSE LICENSE.txt LICENSE.md COPYING.GPLv3 COPYING.txt COPYING)"
  [[ -n "$licence" ]] || { fail 'no LICENSE file found in the download (a GPL build must ship with its licence)'; return 1; }
  readme="$(find_build_file "$tmp" "$build_dir" README.txt README README.md)"

  mkdir -p "$dest" || { fail "cannot create $dest"; return 1; }
  dest="$(cd "$dest" && pwd)"
  local f
  for f in "${extra_files[@]}"; do rm -f "$dest/$f"; done
  # Copy to a temporary name and rename, so a running copy of the old binary does not block the update.
  for exe in ffmpeg ffprobe; do
    if [[ "$exe" == ffmpeg ]]; then src="$ffmpeg_src"; else src="$ffprobe_src"; fi
    cp -f "$src" "$dest/.$exe.new" && chmod 755 "$dest/.$exe.new" && mv -f "$dest/.$exe.new" "$dest/$exe" \
      || { fail "could not copy $exe into $dest"; return 1; }
  done
  cp -f "$licence" "$dest/FFMPEG-LICENSE.txt" || { fail 'could not copy the licence file'; return 1; }
  if [[ -n "$readme" ]]; then cp -f "$readme" "$dest/FFMPEG-README.txt" || { fail 'could not copy the readme'; return 1; }; fi

  # The copied binaries must run here: -version for both, and a tiny libx264 encode (ReCut needs libx264).
  local version_out ver version_string
  version_out="$("$dest/ffmpeg" -hide_banner -version 2>&1)" || { fail "ffmpeg -version failed: $version_out"; return 1; }
  "$dest/ffprobe" -hide_banner -version >/dev/null 2>&1 || { fail 'ffprobe -version failed'; return 1; }
  "$dest/ffmpeg" -hide_banner -v error -f lavfi -i testsrc=duration=0.2:size=64x64:rate=10 -c:v libx264 -f null - \
    || { fail 'ffmpeg could not encode a test clip with libx264'; return 1; }
  ver="$(head -n 1 <<<"$version_out")"
  version_string=''
  [[ "$ver" =~ ^ffmpeg\ version\ ([^[:space:]]+) ]] && version_string="${BASH_REMATCH[1]}"

  local readme_note licence_name written
  if [[ -n "$readme" ]]; then readme_note="FFMPEG-README.txt (copied from $(basename "$readme") in the archive)"; else readme_note='(none in the archive)'; fi
  if grep -q -- '--enable-gpl' <<<"$version_out"; then
    if grep -q -- '--enable-version3' <<<"$version_out"; then licence_name='GNU General Public License version 3 or later (GPL-3.0-or-later)'
    else licence_name='GNU General Public License version 2 or later (GPL-2.0-or-later)'; fi
  else
    if grep -q -- '--enable-version3' <<<"$version_out"; then licence_name='GNU Lesser General Public License version 3 or later (LGPL-3.0-or-later)'
    else licence_name='GNU Lesser General Public License version 2.1 or later (LGPL-2.1-or-later)'; fi
  fi
  if [[ -n "$readme" ]]; then written='FFMPEG-LICENSE.txt, FFMPEG-README.txt and FFMPEG-BUILD.txt'; else written='FFMPEG-LICENSE.txt and FFMPEG-BUILD.txt'; fi

  {
    echo 'FFmpeg build bundled with ReCut'
    echo '================================'
    echo ''
    echo 'ReCut runs these ffmpeg and ffprobe binaries as separate programs. They are not part of ReCut and are'
    echo "not covered by ReCut's MIT licence. Going by the configuration line below, they are distributed under the"
    echo "$licence_name."
    echo 'The licence text that came with the build is in FFMPEG-LICENSE.txt.'
    echo ''
    echo "Downloaded from: $url"
    echo "Build name:      $build_name"
    echo 'Platform:        x86-64 Linux'
    echo "Linking:         $ffmpeg_linkage"
    echo "FFmpeg version:  $version_string"
    echo "Licence file:    FFMPEG-LICENSE.txt (copied from $(basename "$licence") in the archive)"
    echo "Readme file:     $readme_note"
    echo "Downloaded on:   $(date -u '+%Y-%m-%d %H:%M:%S') UTC"
    echo ''
    echo 'Corresponding source'
    echo '--------------------'
    source_info "$url" "$version_string"
    echo ''
    echo 'ffmpeg -version'
    echo '---------------'
    printf '%s\n' "$version_out"
  } >"$dest/FFMPEG-BUILD.txt" || { fail 'could not write FFMPEG-BUILD.txt'; return 1; }

  echo "[ReCut] Installed $ver into $dest"
  echo "[ReCut] ffmpeg is $ffmpeg_linkage"
  echo "[ReCut] Wrote $written ($build_name)"
  return 0
}

errors=()
for url in "${sources[@]}"; do
  attempt_error=''
  if try_source "$url"; then exit 0; fi
  errors+=("$url : ${attempt_error:-failed}")
  rm -rf "$work/download" "$work/x"
done
echo '[ReCut] Could not download FFmpeg:' >&2
for e in "${errors[@]}"; do echo "  $e" >&2; done
exit 1

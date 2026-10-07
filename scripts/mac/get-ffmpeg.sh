#!/usr/bin/env bash
# Downloads an arm64 (Apple Silicon) macOS FFmpeg build and copies ffmpeg + ffprobe into --dest (default:
# resources/ffmpeg). The macOS counterpart of scripts/linux/get-ffmpeg.sh and scripts/windows/get-ffmpeg.ps1. Used by
# the macOS CI build (.github/workflows/windows.yml, job "macos"), which packages the folder into ReCut.app
# (package.json -> build.extraResources -> ReCut.app/Contents/Resources/ffmpeg).
#
#   scripts/mac/get-ffmpeg.sh                     -> resources/ffmpeg
#   scripts/mac/get-ffmpeg.sh --dest <folder>     (or: scripts/mac/get-ffmpeg.sh <folder>)
#   scripts/mac/get-ffmpeg.sh --skip-run          download and check the files only, without running them (any OS)
#
# Next to the executables it also writes what a redistributed GPL FFmpeg build must come with:
#   FFMPEG-LICENSE.txt  the GPL text from the build's own source tree (the archive holds only the two programs)
#   FFMPEG-README.txt   the archive's readme, when it has one (the Jellyfin macOS builds have none)
#   FFMPEG-BUILD.txt    source URL, SHA-256, build name, platform, linking, minimum macOS, `ffmpeg -version` output,
#                       date, and where to get the corresponding source
#
# The build: jellyfin-ffmpeg's "portable macarm64-gpl" release (FFmpeg 8.1 release branch plus Jellyfin's patches,
# built from source by Jellyfin's GitHub Actions on a macOS runner, with libx264, libx265, libass and the other
# libraries in its configuration line linked in statically). Why this one (docs/ROADMAP.md §19):
#   - it is a relocatable arm64 build: the two programs load nothing but macOS's own libraries and frameworks
#     (/usr/lib, /System/Library), which this script checks;
#   - it targets macOS 12.0 (shaka-project/static-ffmpeg-binaries targets macOS 15.0 and has no libass; evermeet.cx is
#     Intel-only; ffmpeg.martin-riedl.de and osxexperts.net are not reachable from every build environment);
#   - it has what ReCut's export uses: libx264, libx265 (H.265 export) and libass (burned-in subtitles);
#   - licence and corresponding source can be documented exactly: GPL v3 or later (--enable-gpl --enable-version3,
#     no nonfree parts), the source is the jellyfin-ffmpeg git tag, and its build scripts pin every library's commit.
# Each source is pinned by version AND by the SHA-256 of its archive and licence file (Jellyfin publishes no checksum
# for its macOS builds, so the hashes were recorded when the version was chosen). A release asset that changes under
# the same tag fails the check instead of being bundled. To update: pick a newer jellyfin-ffmpeg release (vX.Y.Z-N),
# download its *_portable_macarm64-gpl.tar.xz and COPYING.GPLv3, put their SHA-256 below, run this script on an
# Apple Silicon Mac (or with --skip-run anywhere), and check the macos CI job.
#
# A download is rejected (and the next source tried) unless both programs are arm64 Mach-O executables that load only
# /usr/lib and /System/Library libraries, need at most macOS $min_macos, and were configured with --enable-gpl,
# libx264, libx265 and libass. Without --skip-run the script must run on an Apple Silicon Mac: it then runs both
# programs (-version, an H.264 + AAC encode, an H.265 encode and a burned-in subtitle) before it succeeds.
# Needs bash (3.2 is enough), curl, tar with xz, od, strings, and otool (Xcode command line tools) or llvm-objdump.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
dest="$root/resources/ffmpeg"
skip_run=0

usage() { sed -n '2,10p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }
while (($#)); do
  case "$1" in
    -d|--dest) dest="${2:?$1 needs a folder}"; shift 2 ;;
    --dest=*) dest="${1#--dest=}"; shift ;;
    --skip-run) skip_run=1; shift ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "[ReCut] Unknown option: $1" >&2; usage >&2; exit 2 ;;
    *) dest="$1"; shift ;;
  esac
done

# The oldest macOS the bundled programs may need. Keep in step with package.json -> build.mac.minimumSystemVersion.
min_macos='12.0'

# Release-branch builds only: FFmpeg development ("master") builds have shipped encoder bugs that hang exports.
# One entry per source: "<archive URL>|<archive SHA-256>|<licence URL>|<licence SHA-256>|<source tag>".
jf='https://github.com/jellyfin/jellyfin-ffmpeg'
jf_raw='https://raw.githubusercontent.com/jellyfin/jellyfin-ffmpeg'
sources=(
  "$jf/releases/download/v8.1.3-1/jellyfin-ffmpeg_8.1.3-1_portable_macarm64-gpl.tar.xz|22445d7299742749ad2eeb9ce87963d50def0357e45b3e6c7b69987c8365dbf6|$jf_raw/v8.1.3-1/COPYING.GPLv3|8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903|v8.1.3-1"
  # fallback: the previous 8.1 release
  "$jf/releases/download/v8.1.2-5/jellyfin-ffmpeg_8.1.2-5_portable_macarm64-gpl.tar.xz|b2ac80bb184e9a2f3f7c236876b2f56a5639596a95b42f41ced34fab66ad720d|$jf_raw/v8.1.2-5/COPYING.GPLv3|8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903|v8.1.2-5"
)
# Files this script writes next to the executables (removed first, so a previous build's files never linger).
extra_files=('FFMPEG-LICENSE.txt' 'FFMPEG-README.txt' 'FFMPEG-BUILD.txt')
# What ReCut needs compiled in: GPL (libx264/libx265), H.264 and H.265 export, burned-in subtitles.
required_config='--enable-gpl --enable-libx264 --enable-libx265 --enable-libass'
# Libraries a bundled program may load: macOS's own. Anything else (/opt/homebrew, /usr/local, @rpath, ...) would make
# ReCut depend on what happens to be installed on the user's Mac.
allowed_lib_re='^(/usr/lib/|/System/Library/)'

if ((!skip_run)) && [[ "$(uname -s)" != Darwin || "$(uname -m)" != arm64 ]]; then
  echo "[ReCut] scripts/mac/get-ffmpeg.sh downloads arm64 macOS binaries and runs them, so it must run on an Apple Silicon Mac (this is $(uname -s) $(uname -m)). Use --skip-run to download and check them without running." >&2
  exit 1
fi
for tool in curl tar xz od strings; do
  if [[ "$tool" == xz && "$(uname -s)" == Darwin ]]; then continue; fi   # macOS tar (libarchive) reads .xz itself
  command -v "$tool" >/dev/null 2>&1 || { echo "[ReCut] $tool is required (install it and run again)." >&2; exit 1; }
done
if command -v otool >/dev/null 2>&1; then
  headers() { otool -l "$1"; }
  dylibs() { otool -L "$1" | tail -n +2 | sed -e 's/^[[:space:]]*//' -e 's/ (compatibility version.*//'; }
  inspector='otool'
elif command -v llvm-objdump >/dev/null 2>&1; then
  headers() { llvm-objdump --macho --private-headers "$1"; }
  dylibs() { llvm-objdump --macho --dylibs-used "$1" | tail -n +2 | sed -e 's/^[[:space:]]*//' -e 's/ (compatibility version.*//'; }
  inspector='llvm-objdump'
else
  echo '[ReCut] otool (Xcode command line tools: xcode-select --install) or llvm-objdump is required.' >&2
  exit 1
fi
if command -v shasum >/dev/null 2>&1; then sha256() { shasum -a 256 "$1" | cut -d ' ' -f 1; }
elif command -v sha256sum >/dev/null 2>&1; then sha256() { sha256sum "$1" | cut -d ' ' -f 1; }
else echo '[ReCut] shasum or sha256sum is required.' >&2; exit 1; fi

work="$(mktemp -d "${TMPDIR:-/tmp}/recut-ffmpeg.XXXXXX")"
trap 'rm -rf "$work"' EXIT

attempt_error=''
fail() { attempt_error="$*"; return 1; }

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

# Checks that $1 is a relocatable arm64 macOS executable. Sets $linkage and $minos for FFMPEG-BUILD.txt.
linkage=''
minos=''
check_binary() {
  local f="$1" name magic cpu hdr lib bad='' libs=''
  name="$(basename "$f")"
  # Thin 64-bit Mach-O, little-endian (cf fa ed fe), CPU type arm64 (0x0100000c: 0c 00 00 01).
  magic="$(od -An -tx1 -N4 "$f" | tr -d ' \n')"
  if [[ "$magic" == cafebabe || "$magic" == bebafeca ]]; then
    # A universal (fat) binary is fine if it contains arm64; lipo says so (macOS only).
    command -v lipo >/dev/null 2>&1 || { fail "$name is a universal binary and lipo is not available to check it"; return 1; }
    lipo -archs "$f" 2>/dev/null | tr ' ' '\n' | grep -qx arm64 || { fail "$name is a universal binary without arm64 ($(lipo -archs "$f" 2>&1))"; return 1; }
  else
    [[ "$magic" == cffaedfe ]] || { fail "$name is not a 64-bit Mach-O executable (magic $magic)"; return 1; }
    cpu="$(od -An -tx1 -j4 -N4 "$f" | tr -d ' \n')"
    [[ "$cpu" == 0c000001 ]] || { fail "$name is not an arm64 executable (Mach-O CPU type bytes $cpu)"; return 1; }
  fi
  if command -v file >/dev/null 2>&1; then echo "[ReCut] $(file -b "$f" | cut -c 1-100) ($name)"; fi
  hdr="$(headers "$f" 2>&1)" || { fail "$inspector could not read $name: $hdr"; return 1; }
  grep -q 'LC_MAIN' <<<"$hdr" || { fail "$name is not an executable (no LC_MAIN)"; return 1; }
  # Minimum macOS: LC_BUILD_VERSION "minos", or the older LC_VERSION_MIN_MACOSX "version".
  minos="$(awk '/cmd LC_BUILD_VERSION/ { b = 1 } b && $1 == "minos" { print $2; exit }' <<<"$hdr")"
  [[ -n "$minos" ]] || minos="$(awk '/cmd LC_VERSION_MIN_MACOSX/ { b = 1 } b && $1 == "version" { print $2; exit }' <<<"$hdr")"
  [[ -n "$minos" ]] || { fail "$name does not say which macOS version it needs"; return 1; }
  [[ "$(version_gt "$minos" "$min_macos")" == 0 ]] || { fail "$name needs macOS $minos or newer; ReCut supports macOS $min_macos"; return 1; }
  while IFS= read -r lib; do
    [[ -n "$lib" ]] || continue
    libs="$libs $lib"
    [[ "$lib" =~ $allowed_lib_re ]] || bad="$bad $lib"
  done < <(dylibs "$f")
  [[ -n "$libs" ]] || { fail "$inspector listed no libraries for $name"; return 1; }
  if [[ -n "$bad" ]]; then fail "$name loads libraries from outside macOS:$bad"; return 1; fi
  linkage="external libraries linked statically; loads only macOS system libraries and frameworks ($(tr ' ' '\n' <<<"$libs" | grep -c .) from /usr/lib and /System/Library)"
  return 0
}

# Where to get the source corresponding to this build.
source_info() {
  local url="$1" tag="$2" base="${2#v}"
  base="${base%-*}"
  if [[ "$url" == *jellyfin/jellyfin-ffmpeg* ]]; then
    echo "Build provider: Jellyfin (jellyfin-ffmpeg), \"portable macarm64-gpl\" build, release $tag."
    echo 'Built from source by the jellyfin-ffmpeg GitHub Actions workflow on a macOS runner (builder/buildmac.sh).'
    echo "Release page: $jf/releases/tag/$tag"
    echo "Source of this build (FFmpeg $base plus Jellyfin's patches in debian/patches, applied by the build): $jf/tree/$tag"
    echo "Source archive: $jf/archive/refs/tags/$tag.tar.gz"
    echo "Build scripts (they pin the source commit of every library linked in): $jf/tree/$tag/builder"
    echo "  (builder/buildmac.sh, builder/variants/macarm64-gpl.sh, builder/scripts.d/*.sh)"
    echo "Upstream FFmpeg release it is based on: https://github.com/FFmpeg/FFmpeg/releases/tag/n$base"
    echo "  (https://ffmpeg.org/releases/ffmpeg-$base.tar.xz)"
    echo 'The external libraries compiled into this build (libx264, libx265, libass and others) are listed in the'
    echo '"configuration:" line below.'
  else
    echo 'FFmpeg source: https://ffmpeg.org/download.html#get-sources (match the version string below)'
  fi
}

try_source() {
  local entry="$1" url sum lic_url lic_sum tag
  IFS='|' read -r url sum lic_url lic_sum tag <<<"$entry"
  local archive="$work/download" tmp="$work/x" licence="$work/licence" got
  rm -rf "$archive" "$tmp" "$licence"
  mkdir -p "$tmp"
  echo "[ReCut] Downloading FFmpeg from $url"
  curl -fL --retry 3 --retry-delay 2 --connect-timeout 30 -sS -o "$archive" "$url" || { fail 'download failed'; return 1; }
  got="$(sha256 "$archive")"
  [[ "$got" == "$sum" ]] || { fail "SHA-256 mismatch: expected $sum, got $got (the release asset changed: check it and update the pin)"; return 1; }
  echo "[ReCut] SHA-256 ok: $got"
  echo "[ReCut] Downloading the licence from $lic_url"
  curl -fL --retry 3 --retry-delay 2 --connect-timeout 30 -sS -o "$licence" "$lic_url" || { fail 'licence download failed'; return 1; }
  got="$(sha256 "$licence")"
  [[ "$got" == "$lic_sum" ]] || { fail "licence SHA-256 mismatch: expected $lic_sum, got $got"; return 1; }
  grep -q 'GNU GENERAL PUBLIC LICENSE' "$licence" || { fail 'the licence file is not the GPL text'; return 1; }
  # ffplay is not needed (and is as large as ffmpeg).
  tar -xJf "$archive" -C "$tmp" --exclude='ffplay' --exclude='*/ffplay' || { fail 'could not extract the archive (tar.xz expected)'; return 1; }

  # Check the whole download before touching $dest.
  local exe src ffmpeg_src='' ffprobe_src='' ffmpeg_linkage='' ffmpeg_minos='' config
  for exe in ffmpeg ffprobe; do
    src="$(find "$tmp" -type f -name "$exe" -print -quit)"
    [[ -n "$src" ]] || { fail "$exe not found in the download"; return 1; }
    check_binary "$src" || return 1
    if [[ "$exe" == ffmpeg ]]; then ffmpeg_src="$src"; ffmpeg_linkage="$linkage"; ffmpeg_minos="$minos"; else ffprobe_src="$src"; fi
  done
  config="$(strings -n 8 "$ffmpeg_src" | grep -m 1 -- '--enable-gpl' || true)"
  config="${config#%sconfiguration: }"
  [[ -n "$config" ]] || { fail 'could not find the configuration line in ffmpeg'; return 1; }
  local want
  for want in $required_config; do
    [[ " $config " == *" $want "* ]] || { fail "ffmpeg was not configured with $want"; return 1; }
  done
  [[ " $config " != *' --enable-nonfree '* ]] || { fail 'ffmpeg was configured with --enable-nonfree (not redistributable)'; return 1; }

  local build_name readme
  build_name="$(basename "${url%%\?*}")"; build_name="${build_name%.tar.xz}"
  readme="$(find "$tmp" -type f \( -iname 'README' -o -iname 'README.txt' -o -iname 'README.md' \) -print -quit)"

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
  # Downloads from a browser carry a quarantine flag; curl sets none, but clear any so Gatekeeper never blocks a run.
  if command -v xattr >/dev/null 2>&1; then xattr -c "$dest/ffmpeg" "$dest/ffprobe" 2>/dev/null || true; fi
  cp -f "$licence" "$dest/FFMPEG-LICENSE.txt" || { fail 'could not copy the licence file'; return 1; }
  if [[ -n "$readme" ]]; then cp -f "$readme" "$dest/FFMPEG-README.txt" || { fail 'could not copy the readme'; return 1; }; fi

  local version_out ver version_string run_note
  if ((skip_run)); then
    # Not run (--skip-run): the version and configuration come from the strings in the binary.
    version_string="$(strings -n 6 "$dest/ffmpeg" | grep -m 1 -oE '[0-9]+\.[0-9]+(\.[0-9]+)?-Jellyfin' | head -n 1 || true)"
    version_out="ffmpeg version ${version_string:-unknown} (not run: read from the binary by get-ffmpeg.sh --skip-run)"$'\n'"configuration: $config"
    ver="ffmpeg version ${version_string:-unknown}"
    run_note='NOT RUN (--skip-run): only the files and headers were checked. Do not ship this folder.'
  else
    # The copied binaries must run here: -version for both, then what ReCut's export needs.
    version_out="$("$dest/ffmpeg" -hide_banner -version 2>&1)" || { fail "ffmpeg -version failed: $version_out"; return 1; }
    "$dest/ffprobe" -hide_banner -version >/dev/null 2>&1 || { fail 'ffprobe -version failed'; return 1; }
    "$dest/ffmpeg" -hide_banner -v error -f lavfi -i testsrc=duration=0.2:size=64x64:rate=10 -f lavfi -i sine=duration=0.2 \
      -c:v libx264 -c:a aac -shortest -f null - || { fail 'ffmpeg could not encode a test clip with libx264 and aac'; return 1; }
    "$dest/ffmpeg" -hide_banner -v error -f lavfi -i testsrc=duration=0.2:size=64x64:rate=10 -c:v libx265 -x265-params log-level=error -f null - \
      || { fail 'ffmpeg could not encode a test clip with libx265'; return 1; }
    printf '1\n00:00:00,000 --> 00:00:01,000\nReCut\n' >"$work/test.srt"
    (cd "$work" && "$dest/ffmpeg" -hide_banner -v error -f lavfi -i testsrc=duration=0.2:size=160x90:rate=10 -vf subtitles=test.srt \
      -c:v libx264 -f null -) || { fail 'ffmpeg could not burn in a subtitle (libass)'; return 1; }
    ver="$(head -n 1 <<<"$version_out")"
    version_string=''
    [[ "$ver" =~ ^ffmpeg\ version\ ([^[:space:]]+) ]] && version_string="${BASH_REMATCH[1]}"
    run_note="ran -version, an H.264 + AAC encode, an H.265 encode and a burned-in subtitle on $(sw_vers -productName 2>/dev/null || echo macOS) $(sw_vers -productVersion 2>/dev/null || true) $(uname -m)"
  fi

  local readme_note licence_name written
  if [[ -n "$readme" ]]; then readme_note="FFMPEG-README.txt (copied from $(basename "$readme") in the archive)"; else readme_note='(none in the archive)'; fi
  if [[ " $config " == *' --enable-version3 '* ]]; then licence_name='GNU General Public License version 3 or later (GPL-3.0-or-later)'
  else licence_name='GNU General Public License version 2 or later (GPL-2.0-or-later)'; fi
  if [[ -n "$readme" ]]; then written='FFMPEG-LICENSE.txt, FFMPEG-README.txt and FFMPEG-BUILD.txt'; else written='FFMPEG-LICENSE.txt and FFMPEG-BUILD.txt'; fi

  {
    echo 'FFmpeg build bundled with ReCut'
    echo '================================'
    echo ''
    echo 'ReCut runs these ffmpeg and ffprobe binaries as separate programs. They are not part of ReCut and are'
    echo "not covered by ReCut's MIT licence. Going by the configuration line below, they are distributed under the"
    echo "$licence_name."
    echo "The licence text is in FFMPEG-LICENSE.txt (COPYING.GPLv3 from the build's source tree, $tag)."
    echo ''
    echo "Downloaded from: $url"
    echo "SHA-256:         $sum"
    echo "Build name:      $build_name"
    echo 'Platform:        arm64 macOS'
    echo "Minimum macOS:   $ffmpeg_minos"
    echo "Linking:         $ffmpeg_linkage"
    echo "FFmpeg version:  $version_string"
    echo "Licence file:    FFMPEG-LICENSE.txt (downloaded from $lic_url)"
    echo "Readme file:     $readme_note"
    echo "Checked:         $run_note"
    echo "Downloaded on:   $(date -u '+%Y-%m-%d %H:%M:%S') UTC"
    echo ''
    echo 'Corresponding source'
    echo '--------------------'
    source_info "$url" "$tag"
    echo ''
    echo 'ffmpeg -version'
    echo '---------------'
    printf '%s\n' "$version_out"
  } >"$dest/FFMPEG-BUILD.txt" || { fail 'could not write FFMPEG-BUILD.txt'; return 1; }

  echo "[ReCut] Installed $ver into $dest"
  echo "[ReCut] ffmpeg needs macOS $ffmpeg_minos or newer; $ffmpeg_linkage"
  echo "[ReCut] Wrote $written ($build_name)"
  if ((skip_run)); then echo "[ReCut] --skip-run: the programs were not run. Do not package this folder."; fi
  return 0
}

errors=()
for entry in "${sources[@]}"; do
  attempt_error=''
  if try_source "$entry"; then exit 0; fi
  errors+=("${entry%%|*} : ${attempt_error:-failed}")
  rm -rf "$work/download" "$work/x" "$work/licence"
done
echo '[ReCut] Could not download FFmpeg:' >&2
for e in "${errors[@]}"; do echo "  $e" >&2; done
exit 1

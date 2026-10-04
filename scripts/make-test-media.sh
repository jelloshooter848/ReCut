#!/usr/bin/env bash
# Generates synthetic "movies" and "episodes" for testing ReCut without any copyrighted material.
# Usage: scripts/make-test-media.sh <outdir> [short]
set -euo pipefail
OUT="${1:-test-media}"
MODE="${2:-full}"
mkdir -p "$OUT/movies" "$OUT/tv/Season 01" "$OUT/subs"
FF="ffmpeg -hide_banner -loglevel error -y"

# A "movie": several distinct colored scenes with burned-in timecode and a tone that changes per scene.
make_movie() { # name seconds_per_scene colors... (audio codec via AC env)
  local name="$1"; local per="$2"; shift 2
  local colors=("$@")
  local n=${#colors[@]}
  local total=$((per * n))
  local vf=""; local af=""; local inputs=""
  local i=0
  for c in "${colors[@]}"; do
    inputs+=" -f lavfi -i color=c=$c:s=640x360:r=24:d=$per"
    inputs+=" -f lavfi -i sine=frequency=$((300 + i * 110)):duration=$per:sample_rate=48000"
    i=$((i+1))
  done
  local concat=""
  for ((k=0;k<n;k++)); do concat+="[$((k*2)):v][$((k*2+1)):a]"; done
  local ac="${AC:-aac}"; local acargs="-c:a $ac -b:a 160k"
  if [ "$ac" = "ac3" ]; then acargs="-c:a ac3 -b:a 192k"; fi
  local apan="anull"
  if [ "${CH:-2}" = "6" ]; then apan="pan=5.1|FL=c0|FR=c0|FC=c0|LFE=c0|BL=c0|BR=c0"; acargs+=" -ac 6"; else acargs+=" -ac 2"; fi
  # shellcheck disable=SC2086
  $FF $inputs -filter_complex "${concat}concat=n=$n:v=1:a=1[v0][a0];[a0]$apan[a];[v0]drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:text='$name %{pts\:hms}':fontsize=28:fontcolor=white:x=20:y=20,drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:text='frame %{n}':fontsize=22:fontcolor=white:x=20:y=60[v]" \
    -map "[v]" -map "[a]" -c:v ${VC:-libx264} -preset veryfast -crf 23 -pix_fmt yuv420p -g 48 $acargs -movflags +faststart "$OUT/$name" 
  echo "made $OUT/$name (${total}s)"
}

make_srt() { # file per_scene lines...
  local f="$1"; local per="$2"; shift 2
  local i=1; local t=0
  : > "$f"
  for line in "$@"; do
    local s=$((t + 1)); local e=$((t + per - 1))
    printf '%d\n%02d:%02d:%02d,000 --> %02d:%02d:%02d,500\n%s\n\n' "$i" $((s/3600)) $(((s%3600)/60)) $((s%60)) $((e/3600)) $(((e%3600)/60)) $((e%60)) "$line" >> "$f"
    i=$((i+1)); t=$((t+per))
  done
  echo "made $f"
}

if [ "$MODE" = "short" ]; then PER=4; else PER=10; fi

# Movies (franchise "Galaxy Saga")
make_movie "movies/Galaxy Saga 1 - A New Dawn.mp4" $PER red orange yellow green cyan blue
make_srt "$OUT/subs/Galaxy Saga 1 - A New Dawn.srt" $PER "Chapter one begins at dawn." "I am your father, Luke." "The ship is ready, captain." "We must find the hidden temple." "Hold the line!" "This is the end of the beginning."
AC=ac3 make_movie "movies/Galaxy Saga 2 - Dark Tide.mp4" $PER purple magenta pink brown gray white
make_srt "$OUT/subs/Galaxy Saga 2 - Dark Tide.srt" $PER "The tide turns dark tonight." "I am your father, and your mother too." "Captain, the engines failed." "The temple was a trap." "Retreat to the mountains." "A new hope rises."
# 5.1 movie
CH=6 make_movie "movies/Galaxy Saga 3 - Surround Finale.mp4" $PER navy teal olive maroon silver gold
# HEVC movie (not browser-playable; needs proxy)
VC=libx265 make_movie "movies/Galaxy Saga 0 - HEVC Prequel.mp4" $PER darkred darkgreen darkblue

# TV episodes
make_movie "tv/Season 01/Station Eleven S01E01.mp4" $PER red green blue
make_srt "$OUT/subs/Station Eleven S01E01.srt" $PER "Welcome to the station." "Where is the doctor?" "The doctor is in the lab."
make_movie "tv/Season 01/Station Eleven S01E02.mp4" $PER yellow cyan magenta
make_srt "$OUT/subs/Station Eleven S01E02.srt" $PER "The doctor has a secret." "Open the airlock." "We are not alone."
make_movie "tv/Season 01/Station Eleven S01E03.mp4" $PER orange purple white
make_srt "$OUT/subs/Station Eleven S01E03.srt" $PER "Nobody trusts the doctor now." "Seal the station." "I am your father? No."

# Music + image
$FF -f lavfi -i "sine=frequency=220:duration=$((PER*3)):sample_rate=48000" -af "tremolo=f=2" -c:a aac -b:a 128k "$OUT/score.m4a"
$FF -f lavfi -i color=c=white:s=640x360:d=1 -frames:v 1 "$OUT/title-card.png"
# Malformed subtitle for failure testing
printf 'this is not a subtitle file\n\n99\nbroken --> timing\ntext\n' > "$OUT/subs/broken.srt"
# Invalid media
printf 'not a video' > "$OUT/invalid.mp4"
echo "done: $OUT"

#!/usr/bin/env bash
# Generates the attack-suite media set into "$1" (idempotent: skips files that exist).
# Frame-counter encoding: top half luma = 16 + 4*(N mod 50), bottom half luma = 16 + 4*(floor(N/50) mod 50).
# Sync encoding: 1-frame white flash at t = 2k seconds, 50 ms 1 kHz beep starting at t = 2k.
set -euo pipefail
OUT="$1"; mkdir -p "$OUT"
FF="ffmpeg -hide_banner -loglevel error -nostdin -y"
counter() { # fps
  echo "geq=lum='if(lt(Y,H/2),16+4*mod(N,50),16+4*mod(floor(N/50),50))':cb=128:cr=128"
}
have() { [ -s "$OUT/$1" ]; }
X264="-c:v libx264 -preset veryfast -crf 16 -pix_fmt yuv420p"

# 1. frame counters at 25 and 24 fps (20 s), continuous 440 Hz tone
have counter25.mp4 || $FF -f lavfi -i "nullsrc=s=320x240:r=25:d=20,$(counter)" -f lavfi -i "sine=f=440:r=48000:d=20" $X264 -g 25 -c:a aac -b:a 128k -shortest "$OUT/counter25.mp4"
have counter24.mp4 || $FF -f lavfi -i "nullsrc=s=320x240:r=24:d=20,$(counter)" -f lavfi -i "sine=f=440:r=48000:d=20" $X264 -g 24 -c:a aac -b:a 128k -shortest "$OUT/counter24.mp4"
have counter23976.mp4 || $FF -f lavfi -i "nullsrc=s=320x240:r=24000/1001:d=20,$(counter)" -f lavfi -i "sine=f=440:r=48000:d=20" $X264 -g 24 -c:a aac -b:a 128k -shortest "$OUT/counter23976.mp4"
# long 23.976 counter (1 hour, tiny, no audio) for seek math checks
have counter23976_1h.mp4 || $FF -f lavfi -i "nullsrc=s=64x48:r=24000/1001:d=3600,$(counter)" -c:v libx264 -preset ultrafast -crf 30 -pix_fmt yuv420p -g 240 "$OUT/counter23976_1h.mp4"

# 2. sync source: 24 fps, 30 s; flash on frames N%48==0, beep [2k, 2k+0.05)
SYNCV="nullsrc=s=320x240:r=24:d=30,geq=lum='if(eq(mod(N,48),0),235,16)':cb=128:cr=128"
# sample-accurate gate (volume=enable is evaluated per 1024-sample frame, so aevalsrc is used instead)
SYNCA="aevalsrc='if(lt(mod(t,2),0.05),0.8*sin(2*PI*1000*t),0)':s=48000:d=30"
have sync24.mp4 || $FF -f lavfi -i "$SYNCV" -f lavfi -i "$SYNCA" $X264 -g 12 -c:a aac -b:a 192k -shortest "$OUT/sync24.mp4"
# flash+counter combined: top half counter low digit, bottom half flash marker -> no, keep separate for clarity
# 2b. same with container start_time 10 s
have sync24_ts10.mp4 || $FF -i "$OUT/sync24.mp4" -c copy -output_ts_offset 10 "$OUT/sync24_ts10.mp4"
# 2c. MPEG-TS (start ~1.4 s)
have sync24.ts || $FF -i "$OUT/sync24.mp4" -c copy -f mpegts "$OUT/sync24.ts"
# 2d. B-frames with negative CTS offsets + odd timescale
have sync24_bf.mp4 || $FF -f lavfi -i "$SYNCV" -f lavfi -i "$SYNCA" -c:v libx264 -preset veryfast -crf 16 -pix_fmt yuv420p -bf 3 -b_strategy 2 -g 48 -video_track_timescale 90000 -movflags +negative_cts_offsets -c:a aac -b:a 192k -shortest "$OUT/sync24_bf.mp4"
# 2e. audio stream starts 0.5 s AFTER video (mp4 edit list + mkv)
have sync24_adelay.mp4 || $FF -i "$OUT/sync24.mp4" -itsoffset 0.5 -i "$OUT/sync24.mp4" -map 0:v -map 1:a -c copy "$OUT/sync24_adelay.mp4"
have sync24_adelay.mkv || $FF -i "$OUT/sync24.mp4" -itsoffset 0.5 -i "$OUT/sync24.mp4" -map 0:v -map 1:a -c copy "$OUT/sync24_adelay.mkv"
# 2f. video starts 0.5 s after audio
have sync24_vdelay.mkv || $FF -itsoffset 0.5 -i "$OUT/sync24.mp4" -i "$OUT/sync24.mp4" -map 0:v -map 1:a -c copy "$OUT/sync24_vdelay.mkv"
# 2g. 25 fps sync source (flash on N%50==0)
have sync25.mp4 || $FF -f lavfi -i "nullsrc=s=320x240:r=25:d=30,geq=lum='if(eq(mod(N,50),0),235,16)':cb=128:cr=128" -f lavfi -i "$SYNCA" $X264 -g 25 -c:a aac -b:a 192k -shortest "$OUT/sync25.mp4"

# 3. VFR: 24 fps for 5 s then 30 fps for 5 s, counters continue across the join
have vfr.mp4 || $FF -f lavfi -i "nullsrc=s=320x240:r=24:d=5,$(counter)" -f lavfi -i "nullsrc=s=320x240:r=30:d=5,$(counter),setpts=PTS+5/TB" \
  -filter_complex "[1:v]geq=lum='if(lt(Y,H/2),16+4*mod(N+120,50),16+4*mod(floor((N+120)/50),50))':cb=128:cr=128[b];[0:v][b]concat=n=2:v=1:a=0[v]" -map "[v]" -fps_mode vfr $X264 -g 12 -video_track_timescale 120 "$OUT/vfr.mp4"

# 4. codec zoo
have hevc10.mp4 || $FF -f lavfi -i "testsrc=s=320x240:r=24:d=4" -f lavfi -i "sine=f=440:r=48000:d=4" -c:v libx265 -preset ultrafast -pix_fmt yuv420p10le -tag:v hvc1 -c:a aac -shortest "$OUT/hevc10.mp4"
have h264_422.mp4 || $FF -f lavfi -i "testsrc=s=320x240:r=24:d=4" -c:v libx264 -preset ultrafast -pix_fmt yuv422p -profile:v high422 "$OUT/h264_422.mp4"
have cover.png || $FF -f lavfi -i "color=c=orange:s=200x200:d=1" -frames:v 1 "$OUT/cover.png"
# MKV: video + eng stereo + jpn 5.1 + attached cover art; subtitle too
have multi.mkv || $FF -f lavfi -i "testsrc=s=320x240:r=24:d=6" -f lavfi -i "sine=f=440:r=48000:d=6" -f lavfi -i "sine=f=880:r=48000:d=6" -i "$OUT/cover.png" \
  -map 0:v -map 1:a -map 2:a -map 3 -c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:a:0 aac -ac:a:0 2 -c:a:1 ac3 -ac:a:1 6 -c:v:1 png -disposition:v:1 attached_pic \
  -metadata:s:a:0 language=eng -metadata:s:a:1 language=jpn -metadata:s:a:1 title=Surround "$OUT/multi.mkv"
# MP4 where audio is NOT stream 1: two video streams then audio (stream index 2)
have twovideo.mp4 || $FF -f lavfi -i "testsrc=s=320x240:r=24:d=4" -f lavfi -i "color=c=blue:s=160x120:r=24:d=4" -f lavfi -i "sine=f=440:r=48000:d=4" -map 0:v -map 1:v -map 2:a -c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:a aac -shortest "$OUT/twovideo.mp4"
# MP4 with a subtitle stream BEFORE the audio stream, and two audio streams (440 Hz stereo first, 880 Hz mono second)
printf '1\n00:00:00,500 --> 00:00:02,000\nHello\n' > "$OUT/tiny.srt"
have subsfirst.mp4 || $FF -f lavfi -i "testsrc=s=320x240:r=24:d=4" -i "$OUT/tiny.srt" -f lavfi -i "sine=f=440:r=48000:d=4" -f lavfi -i "sine=f=880:r=48000:d=4" -map 0:v -map 1:s -map 2:a -map 3:a -c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:s mov_text -c:a aac -ac:a:0 2 -ac:a:1 1 -shortest "$OUT/subsfirst.mp4"
have audio.m4a || $FF -f lavfi -i "sine=f=440:r=48000:d=6" -c:a aac "$OUT/audio.m4a"
have image.png || $FF -f lavfi -i "color=c=green:s=640x360:d=1" -frames:v 1 "$OUT/image.png"
have image.jpg || $FF -f lavfi -i "color=c=green:s=640x360:d=1" -frames:v 1 -q:v 2 "$OUT/image.jpg"
have wav24.wav || $FF -f lavfi -i "sine=f=440:r=48000:d=4" -c:a pcm_s24le "$OUT/wav24.wav"
have ac3_51.mp4 || $FF -f lavfi -i "testsrc=s=320x240:r=24:d=4" -f lavfi -i "sine=f=440:r=48000:d=4" -af "pan=5.1|FL=c0|FR=c0|FC=c0|LFE=c0|BL=c0|BR=c0" -c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:a ac3 -shortest "$OUT/ac3_51.mp4"
have pcm71.mkv || $FF -f lavfi -i "testsrc=s=320x240:r=24:d=4" -f lavfi -i "sine=f=440:r=48000:d=4" -af "pan=7.1|FL=c0|FR=c0|FC=c0|LFE=c0|BL=c0|BR=c0|SL=c0|SR=c0" -c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:a pcm_s16le -ac 8 -shortest "$OUT/pcm71.mkv"
have mono.mp4 || $FF -f lavfi -i "testsrc=s=320x240:r=24:d=4" -f lavfi -i "sine=f=440:r=48000:d=4" -c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:a aac -ac 1 -shortest "$OUT/mono.mp4"
# rotated: 320x240 coded, display rotation 90 (portrait)
have rotated.mp4 || $FF -display_rotation 90 -i "$OUT/counter24.mp4" -c copy -t 4 "$OUT/rotated.mp4"
have rotated_tag.mp4 || $FF -i "$OUT/counter24.mp4" -c copy -t 4 -metadata:s:v:0 rotate=90 "$OUT/rotated_tag.mp4"
# odd dimensions 853x480
have odd853.mp4 || $FF -f lavfi -i "testsrc=s=853x480:r=24:d=4" -c:v libx264 -preset ultrafast -pix_fmt yuv444p "$OUT/odd853.mp4"
# small 640x360 source with sharp pattern for upscale test
have small360.mp4 || $FF -f lavfi -i "testsrc=s=640x360:r=24:d=4" -f lavfi -i "sine=f=440:r=48000:d=4" -c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:a aac -shortest "$OUT/small360.mp4"

# cover art variants (appended): mkv attachment, mp3 with APIC
have attach.mkv || $FF -f lavfi -i "testsrc=s=320x240:r=24:d=3" -f lavfi -i "sine=f=440:r=48000:d=3" -attach "$OUT/cover.png" -metadata:s:t:0 mimetype=image/png -metadata:s:t:0 filename=cover.png -c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:a aac -shortest "$OUT/attach.mkv"
have cover.mp3 || $FF -f lavfi -i "sine=f=440:r=48000:d=3" -i "$OUT/cover.png" -map 0 -map 1 -c:a libmp3lame -c:v png -disposition:v:0 attached_pic -id3v2_version 3 "$OUT/cover.mp3"
echo ok

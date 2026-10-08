#!/usr/bin/env python3
"""Check ReCut's timeline interchange exports with an independent reader: OpenTimelineIO and its adapters.

The unit tests (tests/unit/interchange-export.test.ts) write the exports of each fixture project as goldens in
tests/fixtures/interchange/, next to a `<fixture>.expected.json` sidecar listing what ReCut intended: every track
and clip with its record range (sequence frames), source in point (frames at the media's rate), speed, file and
enabled state; for a file with an embedded start timecode also `tcStart` (frames at the media's rate), from which the
exports count source times (source in = tcStart + srcIn). This script reads the goldens back and compares:

- `.otio` with the otio_json adapter: track order and kinds, every clip's record range (from the track layout),
  source in, rate, time warp, enabled state and file URL, and the media reference's available range starting at the
  file's start timecode;
- `_Vn.edl` with the cmx_3600 adapter: every enabled clip of video track n in order, its record range within the
  clip (dissolves borrow handles), its source frames at its record frames, the SOURCE FILE comment, and one distinct
  reel name per file;
- `.fcpxml` with the fcpx_xml adapter (lanes and clips per lane: the adapter truncates frame rates to integers, so
  it cannot check NTSC times) and with an exact reader written here on ElementTree + Fraction (record and source
  frames of every clip and its asset's start, FCPXML 1.9 time semantics as documented in shared/interchange/fcpxml.ts).
  An asset-clip of a file with picture and sound and no srcEnable is a linked video + audio pair: it reads as both,
  the audio on the lane of the intended audio clip it matches (FCPXML does not say which audio track it was on).

A format whose adapter is not installed is reported and skipped. Exit status 1 on any mismatch.

Usage: pip install opentimelineio otio-cmx3600-adapter otio-fcpx-xml-adapter
       python scripts/interchange-check.py [fixture-dir]
"""
import glob
import json
import os
import re
import sys
import xml.etree.ElementTree as ET
from fractions import Fraction
from urllib.parse import unquote

try:
    import opentimelineio as otio
except ImportError:
    print('interchange-check: opentimelineio is not installed (pip install opentimelineio)')
    sys.exit(1)

FAILS = []


def check(cond, msg):
    if not cond:
        FAILS.append(msg)
        print(f'  FAIL {msg}')
    return cond


def have(adapter):
    return adapter in [a.name for a in otio.plugins.ActiveManifest().adapters]


def src_in(c):
    """The source in point as the exports write it: frames from the file's embedded start timecode, if any."""
    return c['srcIn'] + c.get('tcStart', 0)


def frames(t, rate):
    """A RationalTime as a frame count at `rate` (exact to 1e-6)."""
    v = t.value_rescaled_to(rate)
    r = round(v)
    return r if abs(v - r) < 1e-6 else v


# --------------------------------------------------------------------------------------------- OTIO

def check_otio(exp, path):
    tl = otio.adapters.read_from_file(path, 'otio_json')
    rate = exp['fps'][0] / exp['fps'][1]
    tracks = list(tl.tracks)
    check([t.kind for t in tracks] == [('Video' if t['kind'] == 'video' else 'Audio') for t in exp['tracks']], 'otio: track kinds and order')
    for t, et in zip(tracks, exp['tracks']):
        got = []
        for item in t:
            if not isinstance(item, otio.schema.Clip):
                continue
            rip = t.range_of_child(item)
            sr = item.source_range
            warp = [e for e in item.effects if isinstance(e, otio.schema.LinearTimeWarp)]
            ar = item.media_reference.available_range
            got.append({
                'fileStart': ar.start_time.value if ar is not None else None,
                'start': frames(rip.start_time, rate), 'duration': frames(rip.duration, rate),
                'srcIn': sr.start_time.value, 'srcRate': sr.start_time.rate,
                'speed': warp[0].time_scalar if warp else 1, 'enabled': item.enabled,
                'url': item.media_reference.target_url,
            })
        want = [{
            'fileStart': None if c['still'] else c.get('tcStart', 0),
            'start': c['start'], 'duration': c['duration'], 'srcIn': src_in(c), 'srcRate': c['srcRate'][0] / c['srcRate'][1],
            'speed': c['speed'], 'enabled': c['enabled'], 'url': c['url'],
        } for c in et['clips']]
        check(got == want, f"otio {et['name']}: clips\n    got  {got}\n    want {want}")
    check(len(tl.tracks.markers) == exp['markers'], 'otio: marker count')
    check(frames(tl.duration(), rate) == exp['durationFrames'], f'otio: duration {tl.duration()}')


# --------------------------------------------------------------------------------------------- EDL

def tc_frames(tc, rate):
    return otio.opentime.from_timecode(tc, rate).to_frames()


def check_edl(exp, path):
    m = re.search(r'_V(\d+)\.edl$', path)
    ti = int(m.group(1)) - 1
    et = [t for t in exp['tracks'] if t['kind'] == 'video'][ti]
    rate = exp['fps'][0] / exp['fps'][1]
    text = open(path, encoding='utf-8').read()
    # The cmx_3600 reader cannot start a track with a transition ("Transitions can't be at the very beginning of a
    # track"): a fade from black at record 00:00:00:00 is read here as a cut (the timing is unchanged).
    text = re.sub(r'^(\d+)  BL +\S+ +C +(\S+) \2 (00:00:00[:;]00) \3\n\1(  \S+ +\S+ +)D +\d+ ', lambda g: f'{g.group(1)}{g.group(4)}C        ', text, flags=re.M)
    tl = otio.adapters.read_from_string(text, 'cmx_3600', rate=rate)
    v = [t for t in tl.tracks if t.name == 'V']
    clips = [c for c in et['clips'] if c['enabled']]
    if not check(len(v) == 1 or not clips, f'edl V{ti + 1}: one video track'):
        return
    got = [c for c in (v[0] if v else []) if isinstance(c, otio.schema.Clip) and not isinstance(c.media_reference, otio.schema.GeneratorReference)]
    if not check(len(got) == len(clips), f'edl V{ti + 1}: {len(got)} clips, want {len(clips)}'):
        return
    reels = {}
    for g, c in zip(got, clips):
        rip = v[0].range_of_child(g)
        # The reader starts the track at its first record in point (track source_range.start_time = -record in).
        origin = frames(v[0].source_range.start_time, rate) if v[0].source_range else 0
        ri = frames(rip.start_time, rate) - origin
        ro = ri + frames(rip.duration, rate)
        src_rate = c['srcRate'][0] / c['srcRate'][1]
        si = round(g.source_range.start_time.value_rescaled_to(src_rate)) if abs(src_rate - rate) > 1e-9 else round(g.source_range.start_time.value)
        ratio = c['speed'] * src_rate / rate
        name = c['name']
        # Record range: within the clip, or earlier by the half of a dissolve that borrows its handle.
        check(c['start'] - 60 <= ri <= ro <= c['end'], f'edl {name}: record {ri}-{ro} outside the clip')
        want_si = src_in(c) + round((ri - c['start']) * ratio)
        check(si == want_si, f'edl {name}: source in {si}, want {want_si}')
        comments = g.metadata.get('cmx_3600', {}).get('comments', [])
        check(f"SOURCE FILE: {c['path']}" in comments, f'edl {name}: SOURCE FILE comment ({comments})')
        reels.setdefault(c['path'], set()).add(g.metadata.get('cmx_3600', {}).get('reel'))
    # Reel names: one per file, a distinct one for each file, a single word of letters, digits, _ and - (32 at most).
    names = {}
    for f, rs in reels.items():
        if check(len(rs) == 1, f'edl V{ti + 1}: one reel name for {f}, got {rs}'):
            r = next(iter(rs))
            if r is None:
                continue
            check(re.fullmatch(r'[A-Za-z0-9_-]{1,32}', r) and r.upper() not in ('AX', 'BL', 'BLK', 'BLACK', 'AUX'), f'edl V{ti + 1}: reel name {r!r} of {f}')
            check(names.setdefault(r.upper(), f) == f, f'edl V{ti + 1}: reel name {r!r} is shared by {names[r.upper()]} and {f}')


# --------------------------------------------------------------------------------------------- FCPXML

def q(t):
    m = re.fullmatch(r'(-?\d+)(?:/(\d+))?s', t)
    return Fraction(int(m.group(1)), int(m.group(2) or 1))


def read_fcpxml_exact(path):
    root = ET.parse(path).getroot()
    assets = {a.get('id'): a for a in root.iter('asset')}
    formats = {f.get('id'): f for f in root.iter('format')}
    seq = root.find('./library/event/project/sequence')
    fd = q(formats[seq.get('format')].get('frameDuration'))
    out = []

    def visit(el, to_abs, lane):
        for k in el:
            if k.tag == 'spine':
                visit(k, to_abs, int(k.get('lane', 0)))
                continue
            if k.tag not in ('asset-clip', 'gap'):
                continue
            abs_start = to_abs(q(k.get('offset')))
            start = q(k.get('start', '0s'))
            k_lane = int(k.get('lane')) if k.get('lane') is not None else lane
            if k.tag == 'asset-clip':
                a = assets[k.get('ref')]
                f = formats.get(a.get('format'))
                mfd = q(f.get('frameDuration')) if f is not None and f.get('frameDuration') else fd
                speed, media = 1, start
                tm = k.find('timeMap')
                if tm is not None:
                    # Local time -> media time, anchored at the asset's start (T0 -> T0; 0s without a start timecode).
                    t0, t1 = list(tm)
                    a0 = a.get('start', '0s')
                    check((t0.get('time'), t0.get('value')) == (a0, a0), f"fcpxml: timeMap of {k.get('name')} starts at {a0} -> {a0}")
                    sp = (q(t1.get('value')) - q(t0.get('value'))) / (q(t1.get('time')) - q(t0.get('time')))
                    speed = float(sp)
                    media = q(t0.get('value')) + (start - q(t0.get('time'))) * sp
                r = {
                    'lane': k_lane, 'start': abs_start / fd, 'duration': q(k.get('duration')) / fd, 'srcIn': media / mfd,
                    'fileStart': q(a.get('start', '0s')) / mfd,
                    'speed': speed, 'enabled': k.get('enabled') != '0', 'url': a.find('media-rep').get('src'),
                }
                out.append(r)
                if k.get('srcEnable') is None and a.get('hasVideo') == '1' and a.get('hasAudio') == '1' and a.get('duration') != '0s':
                    out.append(dict(r, lane=None))
            visit(k, (lambda s, st: lambda local: s + (local - st))(abs_start, start), k_lane)

    visit(seq.find('spine'), lambda local: local, 0)
    return out


def check_fcpxml(exp, path):
    want = []
    for t in exp['tracks']:
        for c in t['clips']:
            want.append({'lane': t['lane'], 'start': c['start'], 'duration': c['duration'], 'srcIn': src_in(c), 'fileStart': c.get('tcStart', 0),
                         'speed': c['speed'], 'enabled': c['enabled'], 'url': c['url']})
    got = read_fcpxml_exact(path)
    for g in got:
        for k in ('start', 'duration', 'srcIn', 'fileStart'):
            check(g[k].denominator == 1, f'fcpxml: {k} {g[k]} is not on a frame')
            g[k] = int(g[k])
    # Linked asset-clips: their audio half takes the lane of the intended audio clip it matches.
    free = [w for w in want if w['lane'] < 0]
    merged = 0
    for g in got:
        if g['lane'] is not None:
            continue
        match = [w for w in free if dict(w, lane=0) == dict(g, lane=0)]
        if check(match, f'fcpxml: linked audio {g} matches an intended audio clip'):
            free.remove(match[0])
            g['lane'] = match[0]['lane']
            g['merged'] = True
            merged += 1
    key = lambda c: (-c['lane'], c['start'])
    got.sort(key=key)
    want.sort(key=key)
    check([dict(g, merged=None) for g in got] == [dict(w, merged=None) for w in want], f'fcpxml (exact reader): clips\n    got  {got}\n    want {want}')
    for c in got:
        u = unquote(c['url'][len('file://'):])
        check(c['url'].startswith('file://') and ' ' not in c['url'], f'fcpxml: URL {c["url"]}')
        check(any(u in (c2['path'], '/' + c2['path'].replace('\\', '/')) for t in exp['tracks'] for c2 in t['clips']), f'fcpxml: URL {c["url"]} decodes to a known path')

    if not have('fcpx_xml'):
        print('  SKIP fcpx_xml adapter: not installed')
        return
    # The adapter needs a frameDuration on every format; FCPXML writes none for stills ("RateUndefined").
    text = open(path, encoding='utf-8').read()
    text = re.sub(r'(<format id="[^"]+" name="FFVideoFormatRateUndefined")', r'\1 frameDuration="%s"' % _seq_fd(text), text)
    tl = otio.adapters.read_from_string(text, 'fcpx_xml')
    if isinstance(tl, otio.schema.SerializableCollection):
        tl = tl[0]
    lanes = {}
    for tr in tl.tracks:
        lanes[int(tr.name)] = len([c for c in tr if isinstance(c, otio.schema.Clip)])
    # The adapter reads a linked asset-clip once, on its video lane.
    want_lanes = {}
    for g in got:
        if not g.get('merged'):
            want_lanes[g['lane']] = want_lanes.get(g['lane'], 0) + 1
    check(lanes == want_lanes, f'fcpxml (fcpx_xml adapter): clips per lane {lanes}, want {want_lanes}')


def _seq_fd(text):
    fid = re.search(r'<sequence format="([^"]+)"', text).group(1)
    return re.search(r'<format id="%s"[^>]*frameDuration="([^"]+)"' % re.escape(fid), text).group(1)


# --------------------------------------------------------------------------------------------- main

def main():
    d = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'tests', 'fixtures', 'interchange')
    sidecars = sorted(glob.glob(os.path.join(d, '*.expected.json')))
    if not sidecars:
        print(f'interchange-check: no *.expected.json in {d} (run the unit tests first)')
        return 1
    print(f'OpenTimelineIO {otio.__version__}; adapters: {", ".join(a.name for a in otio.plugins.ActiveManifest().adapters)}')
    for s in sidecars:
        exp = json.load(open(s, encoding='utf-8'))
        for t in exp['tracks']:
            for c in t['clips']:
                c['end'] = c['start'] + c['duration']
        print(f"{exp['fixture']}: {exp['name']} ({exp['fps'][0]}/{exp['fps'][1]} fps, {exp['durationFrames']} frames)")
        for fmt, adapter, fn in (('otio', 'otio_json', check_otio), ('edl', 'cmx_3600', check_edl), ('fcpxml', None, check_fcpxml)):
            names = exp['files'][fmt]
            if adapter and not have(adapter):
                print(f'  SKIP {fmt}: the {adapter} adapter is not installed')
                continue
            for n in names:
                before = len(FAILS)
                try:
                    fn(exp, os.path.join(d, n))
                except Exception as e:  # a reader error is a failure too
                    check(False, f'{n}: {type(e).__name__}: {e}')
                if len(FAILS) == before:
                    print(f'  ok   {n}')
    if FAILS:
        print(f'interchange-check: {len(FAILS)} problem(s)')
        return 1
    print('interchange-check: all exports read back as intended')
    return 0


if __name__ == '__main__':
    sys.exit(main())

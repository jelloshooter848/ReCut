/**
 * A stand-in for whisper-cli in unit tests, run as `node fakeWhisper.cjs <whisper-cli arguments>`. Behaviour comes from
 * FAKE_WHISPER_MODE:
 *  - "ok" (default): prints progress (stderr) and two segment lines per input (stdout), writes `<-of>.json` with two
 *    segments (one with a raw tab and non-ASCII text, as whisper-cli really writes them) and `result.language` from
 *    FAKE_WHISPER_LANG (default "fr"), unless `-l` names one.
 *    With FAKE_WHISPER_TOKENS=1 the first segment also has `-ojf` tokens with `t_dtw` times (word timing, #118).
 *  - "hang": writes its pid to FAKE_WHISPER_PIDFILE and waits forever (cancel tests).
 *  - "fail": prints an error and exits with code 3.
 * Every run appends its arguments (one JSON line) to FAKE_WHISPER_LOG when set.
 */
'use strict';
const fs = require('node:fs');

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
if (process.env.FAKE_WHISPER_LOG) fs.appendFileSync(process.env.FAKE_WHISPER_LOG, `${JSON.stringify({ args, cwd: process.cwd() })}\n`);
const mode = process.env.FAKE_WHISPER_MODE || 'ok';

if (mode === 'hang') {
  if (process.env.FAKE_WHISPER_PIDFILE) fs.writeFileSync(process.env.FAKE_WHISPER_PIDFILE, String(process.pid));
  process.stderr.write('whisper_print_progress_callback: progress =   5%\n');
  setInterval(() => {}, 1000);
} else if (mode === 'fail') {
  process.stderr.write('whisper_init_from_file_with_params_no_state: loading model\nerror: failed to initialize whisper context\n');
  process.exit(3);
} else {
  const input = opt('-f');
  const outBase = opt('-of');
  const lang = opt('-l') && opt('-l') !== 'auto' ? opt('-l') : (process.env.FAKE_WHISPER_LANG || 'fr');
  if (!input || !fs.existsSync(input)) { process.stderr.write(`error: input file not found '${input}'\n`); process.exit(2); }
  const bytes = fs.statSync(input).size;
  const seconds = Math.max(0, (bytes - 44) / 32000);
  for (const p of [10, 50, 100]) process.stderr.write(`whisper_print_progress_callback: progress = ${String(p).padStart(3)}%\n`);
  const half = Math.round(seconds * 500);
  const end = Math.round(seconds * 1000);
  process.stdout.write(`\n[00:00:00.000 --> 00:00:01.000]   Bonjour, ça va ?\n[00:00:01.000 --> 00:00:02.000]   Très bien.\n`);
  const json = `{
\t"result": {
\t\t"language": "${lang}"
\t},
\t"transcription": [
\t\t{
\t\t\t"timestamps": { "from": "00:00:00,000", "to": "00:00:01,000" },
\t\t\t"offsets": { "from": 0, "to": ${half} },
\t\t\t"text": " Bonjour,\tça va ?"${process.env.FAKE_WHISPER_TOKENS ? `,
\t\t\t"tokens": [
\t\t\t\t{ "text": "[_BEG_]", "offsets": { "from": 0, "to": 0 }, "t_dtw": -1 },
\t\t\t\t{ "text": " Bonjour", "offsets": { "from": 0, "to": 400 }, "t_dtw": 10 },
\t\t\t\t{ "text": ",", "offsets": { "from": 400, "to": 450 }, "t_dtw": 45 },
\t\t\t\t{ "text": " ça", "offsets": { "from": 450, "to": 600 }, "t_dtw": 70 },
\t\t\t\t{ "text": " va", "offsets": { "from": 600, "to": 800 }, "t_dtw": 90 },
\t\t\t\t{ "text": " ?", "offsets": { "from": 800, "to": 900 }, "t_dtw": 110 },
\t\t\t\t{ "text": "[_TT_50]", "offsets": { "from": 900, "to": 900 }, "t_dtw": -1 }
\t\t\t]` : ''}
\t\t},
\t\t{
\t\t\t"offsets": { "from": ${half}, "to": ${end} },
\t\t\t"text": " [BLANK_AUDIO]"
\t\t},
\t\t{
\t\t\t"offsets": { "from": ${half}, "to": ${end} },
\t\t\t"text": " Très \\"bien\\"."
\t\t}
\t]
}
`;
  fs.writeFileSync(`${outBase}.json`, json);
  process.exit(0);
}

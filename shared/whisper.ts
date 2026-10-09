/**
 * Local speech-to-text with whisper.cpp (Roadmap §5): the shared contract.
 *
 * - The engine (`whisper-cli`, built from the pinned whisper.cpp release in scripts/whisper-source.mjs) ships inside
 *   the app; `WHISPER_ENGINE_VERSION` names it (part of the transcription cache key).
 * - The model manifest (`WHISPER_MODELS`): ggml models from the whisper.cpp model repository on Hugging Face, pinned to
 *   one repository commit, with their exact size and SHA-256. Models are downloaded only when the user asks.
 * - Languages Whisper knows (`WHISPER_LANGUAGES`), with display names and ISO 639-2/B tags for the subtitle track.
 * - Request / result / model-state types used over IPC (shared/ipc.ts).
 *
 * Pure: no DOM, no Node.
 */
import type { ID, SubtitleCue } from './model';

/** whisper.cpp release the bundled engine is built from (scripts/whisper-source.mjs WHISPER_TAG without the "v"). */
export const WHISPER_ENGINE_VERSION = '1.9.5';

/** Hugging Face repository commit every model file is pinned to (sizes and hashes below are for this commit). */
export const WHISPER_MODELS_REVISION = '5359861c739e955e79d9a303bcbc70fb988958b1';
/** Base URL of the pinned model files; a model's URL is `WHISPER_MODELS_BASE + file`. */
export const WHISPER_MODELS_BASE = `https://huggingface.co/ggerganov/whisper.cpp/resolve/${WHISPER_MODELS_REVISION}/`;
/** Origin model downloads start from. */
export const WHISPER_MODELS_ORIGIN = 'https://huggingface.co';
/**
 * Domains a model download may be redirected to: each name itself or any subdomain of it (https, default port only).
 * Hugging Face answers a `resolve/` URL of a large file with a redirect to one of its storage or CDN hosts, and which
 * one varies by region and over time (cas-bridge.xethub.hf.co, us.aws.cdn.hf.co, cdn-lfs*.hf.co, ...), so the policy
 * allows Hugging Face's own domains rather than a list of hosts (issue #102: an exact-host list refused
 * us.aws.cdn.hf.co). The SHA-256 check is what guarantees the file: a different file is never installed, whichever
 * host sent it. scripts/check-model-redirects.mjs checks the real chain against this policy in CI.
 */
export const WHISPER_REDIRECT_DOMAINS: readonly string[] = ['huggingface.co', 'hf.co'];

/** One installable Whisper model. */
export interface WhisperModelInfo {
  /** Model id (`small`, `base.en`, `large-v3-turbo`), also in the file name. */
  id: string;
  /** Display name. */
  name: string;
  /** File name under WHISPER_MODELS_BASE and in the local models folder (`ggml-<id>.bin`). */
  file: string;
  /** Exact size in bytes. */
  bytes: number;
  /** Lower-case hex SHA-256 of the file (the Git LFS object id at WHISPER_MODELS_REVISION). */
  sha256: string;
  /** English-only model (`.en`): transcribes English, cannot detect the language or translate. */
  englishOnly: boolean;
  /** One line for the model list: speed and accuracy in plain words. */
  note: string;
}

/**
 * Installable models, smallest first. Sizes and SHA-256 are the Git LFS pointers of ggerganov/whisper.cpp at
 * WHISPER_MODELS_REVISION (the Hugging Face API tree endpoint lists them as `lfs.oid` / `lfs.size`).
 */
export const WHISPER_MODELS: readonly WhisperModelInfo[] = [
  { id: 'tiny', name: 'Tiny', file: 'ggml-tiny.bin', bytes: 77691713, sha256: 'be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21', englishOnly: false, note: 'Fastest, least accurate; for a quick rough transcript' },
  { id: 'base', name: 'Base', file: 'ggml-base.bin', bytes: 147951465, sha256: '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe', englishOnly: false, note: 'Fast; good enough to search clear dialogue' },
  { id: 'base.en', name: 'Base (English)', file: 'ggml-base.en.bin', bytes: 147964211, sha256: 'a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002', englishOnly: true, note: 'Base, English only; a little more accurate on English' },
  { id: 'small', name: 'Small', file: 'ggml-small.bin', bytes: 487601967, sha256: '1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b', englishOnly: false, note: 'Balanced speed and accuracy (recommended)' },
  { id: 'small.en', name: 'Small (English)', file: 'ggml-small.en.bin', bytes: 487614201, sha256: 'c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d', englishOnly: true, note: 'Small, English only' },
  { id: 'medium', name: 'Medium', file: 'ggml-medium.bin', bytes: 1533763059, sha256: '6c14d5adee5f86394037b4e4e8b59f1673b6cee10e3cf0b11bbdbee79c156208', englishOnly: false, note: 'Accurate, slow on a CPU' },
  { id: 'large-v3-turbo', name: 'Large v3 Turbo', file: 'ggml-large-v3-turbo.bin', bytes: 1624555275, sha256: '1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69', englishOnly: false, note: 'Most accurate; faster than Medium but needs the most memory' },
];

const MODEL_BY_ID = new Map<string, WhisperModelInfo>(WHISPER_MODELS.map((m) => [m.id, m]));

/** The manifest entry of a model id, or undefined. */
export function whisperModel(id: string | undefined | null): WhisperModelInfo | undefined {
  return typeof id === 'string' ? MODEL_BY_ID.get(id) : undefined;
}

export function isWhisperModelId(id: unknown): id is string {
  return typeof id === 'string' && MODEL_BY_ID.has(id);
}

/** Download URL of a manifest model. */
export function whisperModelUrl(model: WhisperModelInfo): string {
  return WHISPER_MODELS_BASE + model.file;
}

/** One language Whisper can transcribe. */
export interface WhisperLanguage {
  /** Whisper's code (`en`, `fr`, `yue`, `haw`, `jw`...), passed to `whisper-cli -l`. */
  code: string;
  /** English display name. */
  name: string;
  /** ISO 639-2/B tag for the subtitle track (what Matroska and ffprobe use). */
  iso6392: string;
}

/** Every language of whisper.cpp's language table (src/whisper.cpp g_lang), in its order. */
export const WHISPER_LANGUAGES: readonly WhisperLanguage[] = ([
  ['en', 'English', 'eng'], ['zh', 'Chinese', 'chi'], ['de', 'German', 'ger'], ['es', 'Spanish', 'spa'], ['ru', 'Russian', 'rus'],
  ['ko', 'Korean', 'kor'], ['fr', 'French', 'fre'], ['ja', 'Japanese', 'jpn'], ['pt', 'Portuguese', 'por'], ['tr', 'Turkish', 'tur'],
  ['pl', 'Polish', 'pol'], ['ca', 'Catalan', 'cat'], ['nl', 'Dutch', 'dut'], ['ar', 'Arabic', 'ara'], ['sv', 'Swedish', 'swe'],
  ['it', 'Italian', 'ita'], ['id', 'Indonesian', 'ind'], ['hi', 'Hindi', 'hin'], ['fi', 'Finnish', 'fin'], ['vi', 'Vietnamese', 'vie'],
  ['he', 'Hebrew', 'heb'], ['uk', 'Ukrainian', 'ukr'], ['el', 'Greek', 'gre'], ['ms', 'Malay', 'may'], ['cs', 'Czech', 'cze'],
  ['ro', 'Romanian', 'rum'], ['da', 'Danish', 'dan'], ['hu', 'Hungarian', 'hun'], ['ta', 'Tamil', 'tam'], ['no', 'Norwegian', 'nor'],
  ['th', 'Thai', 'tha'], ['ur', 'Urdu', 'urd'], ['hr', 'Croatian', 'hrv'], ['bg', 'Bulgarian', 'bul'], ['lt', 'Lithuanian', 'lit'],
  ['la', 'Latin', 'lat'], ['mi', 'Maori', 'mao'], ['ml', 'Malayalam', 'mal'], ['cy', 'Welsh', 'wel'], ['sk', 'Slovak', 'slo'],
  ['te', 'Telugu', 'tel'], ['fa', 'Persian', 'per'], ['lv', 'Latvian', 'lav'], ['bn', 'Bengali', 'ben'], ['sr', 'Serbian', 'srp'],
  ['az', 'Azerbaijani', 'aze'], ['sl', 'Slovenian', 'slv'], ['kn', 'Kannada', 'kan'], ['et', 'Estonian', 'est'], ['mk', 'Macedonian', 'mac'],
  ['br', 'Breton', 'bre'], ['eu', 'Basque', 'baq'], ['is', 'Icelandic', 'ice'], ['hy', 'Armenian', 'arm'], ['ne', 'Nepali', 'nep'],
  ['mn', 'Mongolian', 'mon'], ['bs', 'Bosnian', 'bos'], ['kk', 'Kazakh', 'kaz'], ['sq', 'Albanian', 'alb'], ['sw', 'Swahili', 'swa'],
  ['gl', 'Galician', 'glg'], ['mr', 'Marathi', 'mar'], ['pa', 'Punjabi', 'pan'], ['si', 'Sinhala', 'sin'], ['km', 'Khmer', 'khm'],
  ['sn', 'Shona', 'sna'], ['yo', 'Yoruba', 'yor'], ['so', 'Somali', 'som'], ['af', 'Afrikaans', 'afr'], ['oc', 'Occitan', 'oci'],
  ['ka', 'Georgian', 'geo'], ['be', 'Belarusian', 'bel'], ['tg', 'Tajik', 'tgk'], ['sd', 'Sindhi', 'snd'], ['gu', 'Gujarati', 'guj'],
  ['am', 'Amharic', 'amh'], ['yi', 'Yiddish', 'yid'], ['lo', 'Lao', 'lao'], ['uz', 'Uzbek', 'uzb'], ['fo', 'Faroese', 'fao'],
  ['ht', 'Haitian Creole', 'hat'], ['ps', 'Pashto', 'pus'], ['tk', 'Turkmen', 'tuk'], ['nn', 'Norwegian Nynorsk', 'nno'], ['mt', 'Maltese', 'mlt'],
  ['sa', 'Sanskrit', 'san'], ['lb', 'Luxembourgish', 'ltz'], ['my', 'Burmese', 'bur'], ['bo', 'Tibetan', 'tib'], ['tl', 'Tagalog', 'tgl'],
  ['mg', 'Malagasy', 'mlg'], ['as', 'Assamese', 'asm'], ['tt', 'Tatar', 'tat'], ['haw', 'Hawaiian', 'haw'], ['ln', 'Lingala', 'lin'],
  ['ha', 'Hausa', 'hau'], ['ba', 'Bashkir', 'bak'], ['jw', 'Javanese', 'jav'], ['su', 'Sundanese', 'sun'], ['yue', 'Cantonese', 'chi'],
] as const).map(([code, name, iso6392]) => ({ code, name, iso6392 }));

const LANG_BY_CODE = new Map<string, WhisperLanguage>(WHISPER_LANGUAGES.map((l) => [l.code, l]));

/** The Whisper language of a code, or undefined. */
export function whisperLanguage(code: string | undefined | null): WhisperLanguage | undefined {
  return typeof code === 'string' ? LANG_BY_CODE.get(code.toLowerCase()) : undefined;
}

/** A language code `whisper-cli -l` accepts: 'auto' or a WHISPER_LANGUAGES code. */
export function isWhisperLanguageCode(v: unknown): v is string {
  return v === 'auto' || (typeof v === 'string' && LANG_BY_CODE.has(v));
}

/** ISO 639-2/T, 639-3 and other variants of a track language tag → Whisper code (639-2/B tags come from the table). */
const TAG_VARIANTS: Record<string, string> = {
  deu: 'de', fra: 'fr', nld: 'nl', ces: 'cs', ell: 'el', ron: 'ro', slk: 'sk', fas: 'fa', isl: 'is', mkd: 'mk',
  msa: 'ms', sqi: 'sq', hye: 'hy', eus: 'eu', kat: 'ka', cym: 'cy', mya: 'my', bod: 'bo', zho: 'zh', mri: 'mi',
  nob: 'no', zsm: 'ms', cmn: 'zh', pes: 'fa', arb: 'ar', ekk: 'et', lvs: 'lv', fil: 'tl', jv: 'jw', iw: 'he', in: 'id',
  nb: 'no', yue: 'yue',
};
const TAG_TO_CODE = new Map<string, string>();
for (const l of WHISPER_LANGUAGES) {
  TAG_TO_CODE.set(l.code, l.code);
  if (!TAG_TO_CODE.has(l.iso6392)) TAG_TO_CODE.set(l.iso6392, l.code);
}
for (const [tag, code] of Object.entries(TAG_VARIANTS)) TAG_TO_CODE.set(tag, code);

/**
 * Whisper code for a track language tag (`eng`, `fre`, `fra`, `fr`, `fr-CA`, `zh-Hant`...), or null when the tag is
 * missing, undetermined (`und`, `mul`, `zxx`...) or names a language Whisper does not know.
 */
export function guessWhisperLanguage(tag?: string | null): string | null {
  if (typeof tag !== 'string') return null;
  const primary = tag.trim().toLowerCase().split(/[-_]/)[0];
  if (!primary) return null;
  return TAG_TO_CODE.get(primary) ?? null;
}

/** Display name of a Whisper code ('auto' → "Auto-detect"); the code itself when unknown. */
export function whisperLanguageName(code: string): string {
  if (code === 'auto') return 'Auto-detect';
  return LANG_BY_CODE.get(code)?.name ?? code;
}

/**
 * Track name: "English (Whisper Small)", "English (Whisper Small, translated)", with ", #2" when `streamIndex` is given.
 * `model` is a manifest model id (its display name is used) or a display name.
 */
export function whisperTrackName(languageCode: string, model: string, translated: boolean, streamIndex?: number): string {
  const lang = translated ? 'English' : whisperLanguageName(languageCode);
  const modelName = whisperModel(model)?.name ?? model;
  const extras = [translated ? 'translated' : null, streamIndex !== undefined ? `#${streamIndex}` : null].filter(Boolean);
  return `${lang} (Whisper ${modelName}${extras.length ? `, ${extras.join(', ')}` : ''})`;
}

/** Start the transcription of one audio stream (runs as a job of kind 'transcribe'). */
export interface TranscribeRequest {
  mediaId: ID;
  /** Source media file. */
  path: string;
  /** Absolute ffprobe stream index of the audio stream. */
  streamIndex: number;
  /** Model id from WHISPER_MODELS; must be installed. */
  model: string;
  /** Spoken language: 'auto' (detect) or a WHISPER_LANGUAGES code. */
  language: string;
  /** Translate the speech to English (multilingual models only). Default false. */
  translate?: boolean;
  /** Keep filler words, stutters and repeats (see verbatimApplies). Default false. */
  verbatim?: boolean;
}

/**
 * Prompt given to whisper-cli for a verbatim transcript. Whisper drops "um", "uh", stutters and restarts because it
 * was trained on cleaned-up transcripts; a prompt written that way makes it keep them (#117).
 */
export const WHISPER_VERBATIM_PROMPT = 'Um, so, uh, I- I mean, like, you know, um... Okay, uh, let me, um, let me think. Hmm, yeah, uh-huh.';

/** The verbatim prompt is English: it is used only for English speech that is not being translated. */
export function verbatimApplies(req: Pick<TranscribeRequest, 'verbatim' | 'language' | 'translate'>): boolean {
  return Boolean(req.verbatim) && !req.translate && req.language === 'en';
}

/** `JobInfo.result` of a finished 'transcribe' job. */
export interface TranscribeResult {
  mediaId: ID;
  streamIndex: number;
  model: string;
  /** Language of the cues' text as Whisper detected or was told (a WHISPER_LANGUAGES code; 'en' when translated). */
  language: string;
  /** Spoken language Whisper detected (or was told), before any translation. */
  spokenLanguage: string;
  translate: boolean;
  /** Recognized cues, source seconds. */
  cues: SubtitleCue[];
  /** Seconds of audio transcribed. */
  duration: number;
  /** True when the result came from the transcription cache instead of a new run. */
  cached: boolean;
}

/** One row of `whisperModels()`: a manifest model and whether it is installed. */
export interface WhisperModelState {
  id: string;
  name: string;
  bytes: number;
  englishOnly: boolean;
  note: string;
  /** The file is in the models folder with the manifest size. */
  installed: boolean;
  /** Bytes of a partial download waiting to be resumed (0 when none). */
  partialBytes: number;
  /** Id of the running or queued 'download' job installing it, if any. */
  jobId?: string;
}

/** What `whisperEngine()` reports: the bundled engine and where models live. */
export interface WhisperEngineInfo {
  /** Path of whisper-cli, or null when this build has no engine. */
  path: string | null;
  /** `whisper-cli --version` ("1.9.5"), or null when it could not be run. */
  version: string | null;
  /** Why the engine cannot be used, when `path` or `version` is null. */
  error?: string;
  /** Folder holding the installed models (`<userData>/whisper/models`). */
  modelsDir: string;
}

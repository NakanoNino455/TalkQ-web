/**
 * Far-field audio analysis primitives — pure, dependency-free, unit-tested.
 *
 * Everything here works on raw Float32 PCM frames and has no browser imports,
 * so the maths can be verified in Node (see verification/verify-vad.mjs).
 *
 * Why this exists: the Web Speech API does its own endpointing and gives the
 * page no audio stream, so the page cannot improve what the recognizer hears.
 * What it *can* do is (a) tell the user truthfully whether a distant voice is
 * even arriving, (b) decide the right instant to restart a session, and
 * (c) never throw away a half-finished sentence. That is what these do.
 */

/* ── Level maths ─────────────────────────────────────────────────────── */

export function computeRms(frame: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < frame.length; i += 1) sum += frame[i] * frame[i];
  return Math.sqrt(sum / Math.max(1, frame.length));
}

export function computePeak(frame: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < frame.length; i += 1) {
    const value = Math.abs(frame[i]);
    if (value > peak) peak = value;
  }
  return peak;
}

/** Zero-crossing rate: speech is roughly 0.02–0.15, hiss/rumble often higher. */
export function computeZeroCrossingRate(frame: Float32Array): number {
  if (frame.length < 2) return 0;
  let crossings = 0;
  for (let i = 1; i < frame.length; i += 1) {
    if ((frame[i - 1] >= 0) !== (frame[i] >= 0)) crossings += 1;
  }
  return crossings / (frame.length - 1);
}

/** 0 dBFS = full scale; returns -Infinity for digital silence. */
export function toDbfs(amplitude: number): number {
  if (amplitude <= 1e-7) return -140;
  return Math.max(-140, 20 * Math.log10(amplitude));
}

export function dbToUnit(db: number, minDb = -80, maxDb = 0): number {
  if (!Number.isFinite(db)) return 0;
  return Math.min(1, Math.max(0, (db - minDb) / (maxDb - minDb)));
}

/* ── Noise floor tracking ────────────────────────────────────────────── */

/**
 * Robust noise-floor estimate: the 10th percentile of the *smoothed* level over
 * the last few seconds.
 *
 * A naive min-tracker is what most hobby VADs get wrong: with random noise, the
 * quietest frames keep dragging the floor down (measured: -69 dB for a room that
 * actually sits at -53 dB), which inflates the SNR and makes the gate fire on
 * noise. A percentile is stable against that, and speech frames are simply not
 * fed into the window.
 */
export class NoiseFloorTracker {
  /**
   * A real room is never louder than this. If the estimate climbs above it we
   * accidentally learned from speech (e.g. the user started talking the instant
   * the session opened) — clamping keeps the gate able to open at all.
   */
  static readonly MAX_PLAUSIBLE_FLOOR_DB = -50;

  private readonly window: Float64Array;
  private readonly percentile: number;
  private readonly bootstrapFrames: number;
  private pending: number[] = [];
  private index = 0;
  private count = 0;
  private floorDb: number;
  private bootstrapped = false;

  constructor(windowSize = 150, percentile = 0.1, initDb = -70, bootstrapFrames = 12) {
    this.window = new Float64Array(windowSize);
    this.percentile = percentile;
    this.bootstrapFrames = bootstrapFrames;
    this.floorDb = initDb;
  }

  get value(): number {
    return this.floorDb;
  }

  get sampleCount(): number {
    return this.count;
  }

  get isBootstrapped(): boolean {
    return this.bootstrapped;
  }

  reset(): void {
    this.index = 0;
    this.count = 0;
    this.pending = [];
    this.bootstrapped = false;
  }

  /** Feed a smoothed level; returns the current floor estimate. */
  update(smoothedDb: number, inSpeech: boolean): number {
    // Warm-up: learn from the quietest of the first frames instead of the very
    // first one. Seeding from a single frame is how a VAD both false-positives
    // (hardcoded -70 dB vs a -50 dB room) and gets stuck shut (seeded from the
    // user's own voice).
    if (!this.bootstrapped) {
      if (!inSpeech) this.pending.push(smoothedDb);
      const consider = this.pending.length > 0 ? this.pending : [smoothedDb];
      this.floorDb = this.clamp(Math.min(...consider));
      if (this.pending.length >= this.bootstrapFrames) {
        this.window.fill(this.floorDb);
        this.index = 0;
        this.count = this.window.length;
        this.bootstrapped = true;
        this.pending = [];
      }
      return this.floorDb;
    }

    // Afterwards only non-speech frames define the room: a long sentence must
    // not raise its own threshold.
    if (!inSpeech) {
      this.window[this.index] = smoothedDb;
      this.index = (this.index + 1) % this.window.length;
      this.count = Math.min(this.count + 1, this.window.length);
    }

    if (this.count >= 10) {
      const sorted = Array.from(this.window.subarray(0, this.count)).sort((a, b) => a - b);
      const at = Math.min(sorted.length - 1, Math.floor(sorted.length * this.percentile));
      this.floorDb = this.clamp(sorted[at]);
    }
    return this.floorDb;
  }

  private clamp(db: number): number {
    return Math.min(db, NoiseFloorTracker.MAX_PLAUSIBLE_FLOOR_DB);
  }
}

/* ── Voice Activity Detection ────────────────────────────────────────── */

export interface VadConfig {
  /** dB above the floor needed to ENTER speech. */
  enterSnrDb: number;
  /** dB above the floor at which speech is KEPT (hysteresis, lower = stickier). */
  exitSnrDb: number;
  /** Absolute dBFS gate — below this it is silence no matter what. */
  absoluteGateDb: number;
  /** Consecutive speech frames needed before declaring speech (debounce). */
  attackFrames: number;
  /** How long speech keeps counting after the level drops (short pauses). */
  hangoverMs: number;
  /** Frame duration in ms (used for hangover/attack accounting). */
  frameMs: number;
  /** Zero-crossing rate window considered speech-like (rejects hiss). */
  maxZcr: number;
  /** Level smoothing coefficient (0..1, higher = faster). */
  smoothing: number;
}

export const VAD_PRESETS: Record<"near" | "far", VadConfig> = {
  /** Close talk: stricter entry, reacts fast, quick release. */
  near: {
    enterSnrDb: 10,
    exitSnrDb: 5,
    absoluteGateDb: -55,
    attackFrames: 2,
    hangoverMs: 450,
    frameMs: 21,
    maxZcr: 0.35,
    smoothing: 0.5,
  },
  /**
   * Far field (~5 m): the voice arrives only a few dB above the room, so the
   * entry bar is lower, the exit bar lower still (hysteresis), the absolute
   * gate far lower, and pauses of up to ~1.4 s must NOT end the utterance
   * (people pause mid-sentence, and a restart there is what loses words).
   */
  far: {
    enterSnrDb: 4,
    exitSnrDb: 1.5,
    absoluteGateDb: -75,
    attackFrames: 2,
    hangoverMs: 1400,
    frameMs: 21,
    maxZcr: 0.5,
    smoothing: 0.35,
  },
};

export interface VadFrame {
  rms: number;
  peak: number;
  levelDb: number;
  /** Smoothed level the gate actually decides on. */
  smoothDb: number;
  noiseFloorDb: number;
  snrDb: number;
  zcr: number;
  /** True while the gate considers a human voice present. */
  speech: boolean;
  /** True only on the frame where speech started (for restart decisions). */
  speechStart: boolean;
  /** True only on the frame where the hangover expired. */
  speechEnd: boolean;
  /** Milliseconds of continuous speech in the current run. */
  speechMs: number;
  /** Milliseconds since the last speech frame. */
  silenceMs: number;
  /** Signal is too weak to be worth recognizing even if it is speech. */
  tooWeak: boolean;
  /** Still measuring the room; the gate stays closed on purpose. */
  warmup: boolean;
  reason: "speech" | "hangover" | "noise" | "silence" | "clipping" | "warmup";
}

export class VadGate {
  private config: VadConfig;
  private noiseFloor: NoiseFloorTracker;
  private attackCount = 0;
  private lastSpeechAt = 0;
  private speechStartedAt = 0;
  private active = false;
  private smoothDb: number | null = null;
  private now = 0;
  /** When the last frame was processed (for stall detection). */
  private lastFrameAt = 0;


  constructor(preset: "near" | "far" = "near") {
    this.config = { ...VAD_PRESETS[preset] };
    this.noiseFloor = new NoiseFloorTracker();
  }

  get noiseFloorDb(): number {
    return this.noiseFloor.value;
  }

  get isSpeech(): boolean {
    return this.active;
  }

  get configSnapshot(): VadConfig {
    return { ...this.config };
  }

  setPreset(preset: "near" | "far"): void {
    this.config = { ...VAD_PRESETS[preset] };
  }

  reset(): void {
    this.attackCount = 0;
    this.active = false;
    this.lastSpeechAt = 0;
    this.speechStartedAt = 0;
    this.smoothDb = null;
    this.noiseFloor.reset();
  }

  /** Analyse one time-domain frame. `nowMs` is a monotonic clock (perf.now). */
  process(frame: Float32Array, nowMs: number): VadFrame {
    const rms = computeRms(frame);
    const peak = computePeak(frame);
    const zcr = computeZeroCrossingRate(frame);
    const levelDb = toDbfs(rms);
    this.now = nowMs;
    this.lastFrameAt = nowMs;

    // Smoothing stabilises the decision against per-frame noise (far-field
    // signals are only a few dB above the room, so raw frames flicker).
    this.smoothDb =
      this.smoothDb === null
        ? levelDb
        : this.smoothDb + (levelDb - this.smoothDb) * this.config.smoothing;
    const smoothDb = this.smoothDb;

    // The floor only learns from non-speech frames, using the smoothed level.
    const noiseFloorDb = this.noiseFloor.update(smoothDb, this.active);
    const snrDb = smoothDb - noiseFloorDb;

    const warmup = !this.noiseFloor.isBootstrapped;
    const loudEnough = smoothDb >= this.config.absoluteGateDb;
    const speechLike = zcr <= this.config.maxZcr;
    const threshold = this.active ? this.config.exitSnrDb : this.config.enterSnrDb;
    const candidate =
      !warmup && loudEnough && snrDb >= threshold && (speechLike || this.active);

    const wasActive = this.active;
    let speechStart = false;
    let speechEnd = false;

    if (candidate) {
      this.attackCount += 1;
      if (this.attackCount >= this.config.attackFrames) {
        if (!this.active) {
          speechStart = true;
          this.speechStartedAt = nowMs;
        }
        this.active = true;
        this.lastSpeechAt = nowMs;
      }
    } else {
      this.attackCount = 0;
      if (this.active && nowMs - this.lastSpeechAt > this.config.hangoverMs) {
        this.active = false;
        speechEnd = true;
      }
    }

    const speechMs = this.active ? Math.max(0, nowMs - this.speechStartedAt) : 0;
    const silenceMs = this.lastSpeechAt ? Math.max(0, nowMs - this.lastSpeechAt) : 0;

    let reason: VadFrame["reason"] = "silence";
    // Clipping is a fact about the input, not a gate decision — always report it.
    if (peak >= 0.99) reason = "clipping";
    else if (warmup) reason = "warmup";
    else if (this.active && candidate) reason = "speech";
    else if (this.active) reason = "hangover";
    else if (!loudEnough) reason = "silence";
    else reason = "noise";

    return {
      rms,
      peak,
      levelDb,
      smoothDb,
      noiseFloorDb,
      snrDb,
      zcr,
      speech: this.active,
      speechStart,
      speechEnd: speechEnd && wasActive,
      speechMs,
      silenceMs,
      tooWeak: this.active && levelDb < this.config.absoluteGateDb + 6,
      warmup,
      reason,
    };
  }

  /** Milliseconds since the last frame that looked like speech. */
  silenceSinceLastSpeech(): number {
    return this.lastSpeechAt ? Math.max(0, this.now - this.lastSpeechAt) : Number.POSITIVE_INFINITY;
  }

  /**
   * True when no audio frame has arrived for a while.
   *
   * Measured on the live site: when the analyser stops producing frames (device
   * grabbed by another app, suspended AudioContext, throttled page) the gate kept
   * its last state, so `speech: true` stayed on screen forever and the
   * "we hear you but nothing is recognised" hint never cleared. A stalled
   * analyser must read as "no speech", not as an endless utterance.
   */
  isStalled(nowMs: number, thresholdMs = 1200): boolean {
    return this.lastFrameAt > 0 && nowMs - this.lastFrameAt > thresholdMs;
  }

  /** Close the gate without a frame (used when frames stop arriving). */
  forceIdle(): void {
    if (!this.active && this.attackCount === 0) return;
    this.active = false;
    this.attackCount = 0;
  }

  /** Last time a frame was processed (ms, performance clock). */
  get lastFrameTime(): number {
    return this.lastFrameAt;
  }
}

/* ── Overlap-safe transcript merging ─────────────────────────────────── */

/**
 * Chrome re-recognizes the audio around a restart, so naively gluing the
 * carried-over text and the new text duplicates words. This finds the largest
 * suffix/prefix overlap (word based, case-insensitive) and merges once.
 */
export function mergeTranscripts(base: string, addition: string): string {
  const left = base.trim();
  const right = addition.trim();
  if (!left) return right;
  if (!right) return left;
  if (left === right) return left;

  const leftWords = left.split(/\s+/);
  const rightWords = right.split(/\s+/);
  const max = Math.min(leftWords.length, rightWords.length);

  for (let size = max; size > 0; size -= 1) {
    const tail = leftWords.slice(leftWords.length - size).join(" ").toLowerCase();
    const head = rightWords.slice(0, size).join(" ").toLowerCase();
    if (tail === head) {
      return `${left} ${rightWords.slice(size).join(" ")}`.trim();
    }
  }

  // CJK text has no spaces: fall back to a character-level overlap.
  if (!/\s/.test(left) && !/\s/.test(right)) {
    const maxChars = Math.min(left.length, right.length, 12);
    for (let size = maxChars; size >= 2; size -= 1) {
      if (left.slice(-size) === right.slice(0, size)) {
        return `${left}${right.slice(size)}`.trim();
      }
    }
  }

  return `${left} ${right}`.trim();
}

/* ── Calibration accumulator ─────────────────────────────────────────── */

export interface CalibrationSample {
  distanceM: number;
  noiseFloorDb: number;
  speechRmsDb: number;
  peakDb: number;
  snrDb: number;
  /** Below ~8 dB a cloud recognizer will mostly fail. */
  verdict: "good" | "marginal" | "too-weak";
}

export class CalibrationAccumulator {
  private noiseSum = 0;
  private noiseCount = 0;
  private speechSum = 0;
  private speechCount = 0;
  private peak = 0;

  addNoise(levelDb: number): void {
    if (levelDb <= -140) return;
    this.noiseSum += levelDb;
    this.noiseCount += 1;
  }

  addSpeech(frame: { levelDb: number; peak: number }): void {
    this.speechSum += frame.levelDb;
    this.speechCount += 1;
    if (frame.peak > this.peak) this.peak = frame.peak;
  }

  get hasData(): boolean {
    return this.noiseCount > 0 || this.speechCount > 0;
  }

  snapshot(distanceM: number): CalibrationSample {
    const noiseFloorDb = this.noiseCount ? this.noiseSum / this.noiseCount : -140;
    const speechRmsDb = this.speechCount ? this.speechSum / this.speechCount : -140;
    const snrDb = Math.max(0, speechRmsDb - noiseFloorDb);
    const verdict: CalibrationSample["verdict"] =
      snrDb >= 15 && speechRmsDb > -45 ? "good" : snrDb >= 8 ? "marginal" : "too-weak";
    return {
      distanceM,
      noiseFloorDb: round1(noiseFloorDb),
      speechRmsDb: round1(speechRmsDb),
      peakDb: round1(toDbfs(this.peak)),
      snrDb: round1(snrDb),
      verdict,
    };
  }

  reset(): void {
    this.noiseSum = 0;
    this.noiseCount = 0;
    this.speechSum = 0;
    this.speechCount = 0;
    this.peak = 0;
  }
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Turn the measured numbers into a concrete, honest recommendation.
 * This is the function that tells the user whether the problem is physics.
 */
export function adviseFromSample(sample: CalibrationSample): string {
  if (sample.verdict === "good") {
    return "SNR 充足：这个距离下识别率应该正常。";
  }
  if (sample.verdict === "marginal") {
    return "勉强可用：把说话音量再提高一点、或把设备挪近 0.5–1 米，识别会明显稳定。";
  }
  if (sample.speechRmsDb < -60) {
    return "信号太弱（说话时电平仍低于 -60 dBFS）：这是麦克风/距离的物理限制，软件无法补救——需要外接麦克风（USB 会议麦 / 领夹麦 / 麦克风阵列）或拉近距离。";
  }
  return "噪声底太高：先降低环境噪声（空调、风扇、音乐），或使用指向性/阵列麦克风。";
}

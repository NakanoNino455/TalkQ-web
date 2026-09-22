import type { CalibrationSample } from "./dsp";
import { CalibrationAccumulator, VadGate, type VadFrame } from "./dsp";
import { DeepSeekError } from "./errors";

/**
 * Microphone capture + real-time analysis for far-field use.
 *
 * Two things matter here, and they are different:
 *
 * 1. WHAT THE RECOGNIZER HEARS. `webkitSpeechRecognition` opens its own audio
 *    input and gives the page no stream, so we cannot post-process its audio.
 *    What we *can* control is the device configuration: browser noise
 *    suppression / auto gain are tuned for close-talk VoIP and behave badly at
 *    5 m (AGC pumps the room up between words, NS gates quiet speech away), so
 *    Far-field mode asks for a raw capture instead. Chrome shares one input
 *    device per process, which is why these constraints can matter at all — but
 *    they are a request, not a guarantee, and the diagnostics panel is how you
 *    find out what actually happened.
 *
 * 2. WHAT THE PAGE CAN MEASURE. Our own analyser sees the same microphone, so
 *    it can report RMS/peak/noise floor/SNR and run a VAD. That is what tells
 *    you whether a distant voice is arriving at all — the question that decides
 *    whether the problem is fixable in software or is physics.
 */

export type MicProcessing = "auto" | "browser" | "raw";

export interface MicCaptureReport {
  /** Constraints actually sent to getUserMedia (only supported ones). */
  applied: MediaStreamTrackConstraintsLike;
  /** Requested settings the browser does not support (never sent). */
  skipped: string[];
  /** What the device settled on, from track.getSettings(). */
  actual: {
    deviceLabel: string;
    sampleRate?: number;
    channelCount?: number;
    echoCancellation?: boolean;
    noiseSuppression?: boolean;
    autoGainControl?: boolean;
  };
}

/** Only the audio keys we use; avoids `any` in the report. */
export interface MediaStreamTrackConstraintsLike {
  deviceId?: { exact: string };
  echoCancellation?: boolean;
  noiseSuppression?: boolean;
  autoGainControl?: boolean;
  channelCount?: number;
  sampleRate?: number;
  latency?: number;
}

export interface MicRequestOptions {
  /** Far-field mode → raw capture unless the user forced something else. */
  farField: boolean;
  processing: MicProcessing;
  deviceId?: string;
}

function supportedConstraintNames(): Set<string> {
  const supported = navigator.mediaDevices?.getSupportedConstraints?.() ?? {};
  return new Set(
    Object.entries(supported)
      .filter(([, value]) => value)
      .map(([key]) => key)
  );
}

/**
 * Build the constraint set from what the browser actually supports — passing an
 * unsupported key makes Chrome throw OverconstrainedError, so we never guess.
 */
export function buildAudioConstraints(options: MicRequestOptions): {
  constraints: MediaTrackConstraints;
  applied: MediaStreamTrackConstraintsLike;
  skipped: string[];
} {
  const supported = supportedConstraintNames();
  const applied: MediaStreamTrackConstraintsLike = {};
  const skipped: string[] = [];

  const wantRaw = options.processing === "raw" || (options.processing === "auto" && options.farField);
  const processingValues = wantRaw
    ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
    : { echoCancellation: true, noiseSuppression: true, autoGainControl: true };

  for (const [key, value] of Object.entries(processingValues)) {
    if (supported.has(key)) {
      (applied as Record<string, unknown>)[key] = value;
    } else {
      skipped.push(key);
    }
  }

  // Mono is what the recognizer consumes; asking for more only wastes bandwidth.
  if (supported.has("channelCount")) applied.channelCount = 1;
  else skipped.push("channelCount");

  if (options.deviceId) {
    if (supported.has("deviceId")) applied.deviceId = { exact: options.deviceId };
    else skipped.push("deviceId");
  }

  return { constraints: applied as MediaTrackConstraints, applied, skipped };
}

export async function requestMicrophone(options: MicRequestOptions): Promise<{
  stream: MediaStream;
  report: MicCaptureReport;
}> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new DOMException("getUserMedia is unavailable in this context", "NotSupportedError");
  }

  const { constraints, applied, skipped } = buildAudioConstraints(options);
  const stream = await navigator.mediaDevices.getUserMedia({ audio: constraints, video: false });
  return { stream, report: describeStream(stream, applied, skipped) };
}

export function describeStream(
  stream: MediaStream,
  applied: MediaStreamTrackConstraintsLike,
  skipped: string[]
): MicCaptureReport {
  const track = stream.getAudioTracks()[0];
  const settings = (track?.getSettings?.() ?? {}) as MediaTrackSettings & {
    deviceId?: string;
    sampleRate?: number;
    channelCount?: number;
  };
  return {
    applied,
    skipped,
    actual: {
      deviceLabel: track?.label || "未知设备",
      sampleRate: settings.sampleRate,
      channelCount: settings.channelCount,
      echoCancellation: settings.echoCancellation,
      noiseSuppression: settings.noiseSuppression,
      autoGainControl: settings.autoGainControl,
    },
  };
}

/** Re-negotiate processing without reopening the device (keeps the session). */
export async function applyProcessing(
  stream: MediaStream,
  options: MicRequestOptions
): Promise<MicCaptureReport> {
  const track = stream.getAudioTracks()[0];
  const { constraints, applied, skipped } = buildAudioConstraints(options);
  if (track?.applyConstraints) {
    try {
      await track.applyConstraints(constraints);
    } catch {
      // Device may refuse; the diagnostics panel shows what stuck.
    }
  }
  return describeStream(stream, applied, skipped);
}

export async function listAudioInputs(): Promise<{ deviceId: string; label: string }[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((device) => device.kind === "audioinput")
    .map((device) => ({ deviceId: device.deviceId, label: device.label || "麦克风" }));
}

export function stopMicrophone(stream: MediaStream | null): void {
  stream?.getTracks().forEach((track) => track.stop());
}

/* ── Real-time analyser ──────────────────────────────────────────────── */

export interface AnalyzerDisplay {
  /** 0..1 for the meter, mapped from dBFS. */
  level: number;
  peak: number;
  noiseFloor: number;
  speech: boolean;
  snrDb: number;
  clipping: boolean;
}

export interface AudioAnalyzerOptions {
  preset: "near" | "far";
  /** Full-precision frame, every animation frame (drives the VAD logic). */
  onFrame?: (frame: VadFrame) => void;
  /** Throttled summary for React state. */
  onDisplay?: (display: AnalyzerDisplay) => void;
  displayHz?: number;
}

export class AudioAnalyzer {
  private readonly stream: MediaStream;
  private readonly options: AudioAnalyzerOptions;
  private context: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private buffer = new Float32Array(0);
  private frame = 0;
  private stopped = false;
  private lastDisplayAt = 0;
  private lastFrame: VadFrame | null = null;
  private calibration: CalibrationAccumulator | null = null;
  private calibrationDistance = 0;
  readonly gate: VadGate;

  constructor(stream: MediaStream, options: AudioAnalyzerOptions) {
    this.stream = stream;
    this.options = options;
    this.gate = new VadGate(options.preset);
  }

  get latestFrame(): VadFrame | null {
    return this.lastFrame;
  }

  get state(): "running" | "stopped" | "unsupported" {
    if (this.stopped) return "stopped";
    if (!this.context) return "unsupported";
    return this.context.state === "running" ? "running" : "stopped";
  }

  get sampleRate(): number | null {
    return this.context?.sampleRate ?? null;
  }

  start(): void {
    const AudioContextCtor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) return; // analyser is optional; recognition still works

    const context = new AudioContextCtor();
    const source = context.createMediaStreamSource(this.stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0;
    source.connect(analyser);

    this.context = context;
    this.source = source;
    this.analyser = analyser;
    this.buffer = new Float32Array(analyser.fftSize);
    this.stopped = false;

    // A suspended context (autoplay policy) still yields no frames — resume it.
    void context.resume().catch(() => {});

    const tick = () => {
      if (this.stopped || !this.analyser) return;
      this.analyser.getFloatTimeDomainData(this.buffer as Float32Array<ArrayBuffer>);
      const frame = this.gate.process(this.buffer, performance.now());
      this.lastFrame = frame;
      this.options.onFrame?.(frame);

      const calibration = this.calibration;
      if (calibration) {
        if (frame.speech) calibration.addSpeech(frame);
        else calibration.addNoise(frame.levelDb);
      }

      const displayHz = this.options.displayHz ?? 10;
      const now = performance.now();
      if (this.options.onDisplay && now - this.lastDisplayAt >= 1000 / displayHz) {
        this.lastDisplayAt = now;
        this.options.onDisplay({
          level: Math.max(0, Math.min(1, (frame.smoothDb + 80) / 80)),
          peak: frame.peak,
          noiseFloor: frame.noiseFloorDb,
          speech: frame.speech,
          snrDb: frame.snrDb,
          clipping: frame.peak >= 0.99,
        });
      }

      this.frame = requestAnimationFrame(tick);
    };
    this.frame = requestAnimationFrame(tick);
  }

  setPreset(preset: "near" | "far"): void {
    this.gate.setPreset(preset);
  }

  /** Forget the learned room (used when the session restarts from scratch). */
  resetGate(): void {
    this.gate.reset();
  }

  startCalibration(distanceM: number): void {
    this.calibration = new CalibrationAccumulator();
    this.calibrationDistance = distanceM;
  }

  finishCalibration(): CalibrationSample | null {
    if (!this.calibration) return null;
    const sample = this.calibration.snapshot(this.calibrationDistance);
    this.calibration = null;
    return sample;
  }

  get calibrating(): boolean {
    return this.calibration !== null;
  }

  stop(): void {
    this.stopped = true;
    cancelAnimationFrame(this.frame);
    try {
      this.source?.disconnect();
      this.analyser?.disconnect();
    } catch {
      /* already disconnected */
    }
    const context = this.context;
    this.context = null;
    this.source = null;
    this.analyser = null;
    if (context) void context.close().catch(() => {});
  }
}

/**
 * Turn a failed getUserMedia into something the user can act on. Kept here so
 * the far-field flow and the normal flow share one vocabulary.
 */
export function toMicError(err: unknown): DeepSeekError {
  const name = err instanceof DOMException ? err.name : "";
  const message = err instanceof Error ? err.message : String(err);
  if (name === "NotAllowedError" || name === "SecurityError") {
    return new DeepSeekError({
      kind: "auth",
      title: "麦克风权限被拒绝",
      detail: message,
      hint: "点地址栏的锁/麦克风图标 → 允许，然后重新开始。",
    });
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return new DeepSeekError({
      kind: "invalid_request",
      title: "找不到可用的麦克风",
      detail: message,
      hint: "检查系统声音设置里的输入设备；如果是外接麦克风，重新插拔或换一个 USB 口。",
    });
  }
  if (name === "NotReadableError") {
    return new DeepSeekError({
      kind: "invalid_request",
      title: "麦克风被占用",
      detail: message,
      hint: "关掉其他正在录音的程序（会议软件、录音工具）后重试。",
    });
  }
  return new DeepSeekError({ kind: "unknown", title: "麦克风不可用", detail: message });
}

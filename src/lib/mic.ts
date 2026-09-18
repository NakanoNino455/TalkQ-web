/**
 * Microphone access + input level metering.
 *
 * Requesting `getUserMedia({ audio: true })` is what makes the browser show the
 * real permission prompt the first time the user starts live translation.
 */

export interface MicErrorInfo {
  title: string;
  detail: string;
  hint?: string;
  /** Permission problems cannot be retried without user action. */
  fatal: boolean;
}

export function describeMicError(err: unknown): MicErrorInfo {
  const name = err instanceof DOMException ? err.name : "";
  const message = err instanceof Error ? err.message : String(err);

  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return {
        title: "Microphone permission denied",
        detail: message || "The browser refused microphone access.",
        hint: "Click the padlock/microphone icon in the address bar → Allow → then press 开始 again.",
        fatal: true,
      };
    case "NotFoundError":
    case "OverconstrainedError":
      return {
        title: "No microphone found",
        detail: message || "No audio input device is connected.",
        hint: "Connect a microphone or headset, then try again.",
        fatal: true,
      };
    case "NotReadableError":
      return {
        title: "Microphone is busy",
        detail: message || "Another application is holding the audio device.",
        hint: "Close other apps that record audio (meeting/recording tools) and retry.",
        fatal: true,
      };
    default:
      return {
        title: "Microphone unavailable",
        detail: message || name || "Unknown microphone error.",
        fatal: false,
      };
  }
}

export async function requestMicrophone(): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new DOMException("getUserMedia is unavailable in this context", "NotSupportedError");
  }
  return navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
    video: false,
  });
}

export function stopMicrophone(stream: MediaStream | null): void {
  stream?.getTracks().forEach((track) => track.stop());
}

export interface LevelMeterHandle {
  stop: () => void;
}

/**
 * Sample the input level with an AnalyserNode so the UI can show a live meter.
 * Keeps the audio graph local: nothing is recorded or uploaded here.
 */
export function startLevelMeter(
  stream: MediaStream,
  onLevel: (level: number) => void
): LevelMeterHandle {
  const AudioContextCtor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;

  if (!AudioContextCtor) {
    return { stop: () => {} };
  }

  const context = new AudioContextCtor();
  const source = context.createMediaStreamSource(stream);
  const analyser = context.createAnalyser();
  analyser.fftSize = 1024;
  analyser.smoothingTimeConstant = 0.75;
  source.connect(analyser);

  const buffer = new Float32Array(analyser.fftSize);
  let frame = 0;
  let stopped = false;

  const tick = () => {
    if (stopped) return;
    analyser.getFloatTimeDomainData(buffer);
    let sum = 0;
    for (let i = 0; i < buffer.length; i += 1) sum += buffer[i] * buffer[i];
    const rms = Math.sqrt(sum / buffer.length);
    // Map RMS (~0..0.4 for speech) onto a 0..1 display range.
    onLevel(Math.min(1, rms * 4.5));
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);

  return {
    stop: () => {
      stopped = true;
      cancelAnimationFrame(frame);
      try {
        source.disconnect();
        analyser.disconnect();
      } catch {
        /* already disconnected */
      }
      void context.close().catch(() => {});
    },
  };
}

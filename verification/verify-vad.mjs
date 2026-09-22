/**
 * Unit tests for the far-field DSP / VAD / transcript-merge logic.
 *
 * These run in Node directly against src/lib/dsp.ts (Node strips the types), so
 * the maths is verified for real — no browser, no microphone needed:
 *
 *   node verification/verify-vad.mjs
 *
 * It synthesises PCM: room noise, a distant voice (a few dB above the noise),
 * a close voice, pauses, and a clipping signal, then asserts how the gate
 * classifies each one.
 */
import {
  CalibrationAccumulator,
  NoiseFloorTracker,
  VadGate,
  adviseFromSample,
  computePeak,
  computeRms,
  computeZeroCrossingRate,
  dbToUnit,
  mergeTranscripts,
  toDbfs,
} from "../src/lib/dsp.ts";

const SAMPLE_RATE = 48_000;
const FRAME = 1024; // ~21 ms, same as the analyser setup

const results = [];
let group = "";
const section = (name) => {
  group = name;
  console.log(`\n=== ${name} ===`);
};
const check = (name, ok, extra = "") => {
  results.push({ group, name, ok: Boolean(ok), extra });
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
};

/* ── Signal synthesis ────────────────────────────────────────────────── */

function noiseFrame(amplitude, seed = 1) {
  const frame = new Float32Array(FRAME);
  let state = seed;
  for (let i = 0; i < FRAME; i += 1) {
    // Deterministic LCG so runs are reproducible.
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    frame[i] = ((state / 0x7fffffff) * 2 - 1) * amplitude;
  }
  return frame;
}

function voiceFrame(amplitude, freq = 180, offset = 0) {
  const frame = new Float32Array(FRAME);
  for (let i = 0; i < FRAME; i += 1) {
    const t = (offset + i) / SAMPLE_RATE;
    // Voiced-ish signal: fundamental + harmonics, slow amplitude wobble.
    const envelope = 0.6 + 0.4 * Math.sin(2 * Math.PI * 3 * t);
    frame[i] =
      amplitude *
      envelope *
      (Math.sin(2 * Math.PI * freq * t) +
        0.5 * Math.sin(2 * Math.PI * freq * 2 * t) +
        0.25 * Math.sin(2 * Math.PI * freq * 3 * t));
  }
  return frame;
}

function mixedFrame(noiseAmplitude, voiceAmplitude, seed = 7, offset = 0) {
  const noise = noiseFrame(noiseAmplitude, seed);
  const voice = voiceFrame(voiceAmplitude, 180, offset);
  const frame = new Float32Array(FRAME);
  for (let i = 0; i < FRAME; i += 1) frame[i] = noise[i] + voice[i];
  return frame;
}

/** Feed n frames at 21 ms apart, return the frames the gate produced. */
function feed(gate, frames, startMs = 0) {
  const out = [];
  frames.forEach((frame, index) => {
    out.push(gate.process(frame, startMs + index * 21));
  });
  return out;
}

const repeat = (n, make) => Array.from({ length: n }, (_, i) => make(i));

/* ── Level maths ─────────────────────────────────────────────────────── */

section("Level maths");
{
  const silence = new Float32Array(FRAME);
  check("RMS of silence is 0", computeRms(silence) === 0);
  check("dBFS of silence clamps to the floor", toDbfs(0) === -140);

  const full = new Float32Array(FRAME).fill(1);
  check("RMS of full scale is 1", Math.abs(computeRms(full) - 1) < 1e-6);
  check("peak of full scale is 1", computePeak(full) === 1);
  check("0 dBFS for full scale", toDbfs(1) === 0);

  const half = new Float32Array(FRAME).fill(0.5);
  check("half amplitude ≈ -6 dBFS", Math.abs(toDbfs(computeRms(half)) + 6.02) < 0.05);

  // A 180 Hz voice at 48 kHz crosses zero ~2*180/48000 times per sample.
  const voice = voiceFrame(0.05);
  const zcr = computeZeroCrossingRate(voice);
  check(
    "voiced signal ZCR stays in the speech band",
    zcr > 0.002 && zcr < 0.15,
    `${zcr.toFixed(4)} (180 Hz fundamental ≈ 2f/fs)`
  );

  const hiss = noiseFrame(0.05);
  const hissZcr = computeZeroCrossingRate(hiss);
  check("broadband noise has a much higher ZCR", hissZcr > zcr * 1.5, `${hissZcr.toFixed(3)} vs ${zcr.toFixed(3)}`);

  check("dbToUnit maps the window", dbToUnit(-80) === 0 && dbToUnit(0) === 1 && Math.abs(dbToUnit(-40) - 0.5) < 0.01);
}

/* ── Noise floor tracker ─────────────────────────────────────────────── */

section("Noise floor tracking");
{
  const tracker = new NoiseFloorTracker(150, 0.1, -70);
  for (let i = 0; i < 60; i += 1) tracker.update(-60, false);
  check(
    "floor converges on a steady room level, not the quietest frame",
    Math.abs(tracker.value - -60) < 1.5,
    tracker.value.toFixed(1)
  );

  const before = tracker.value;
  for (let i = 0; i < 20; i += 1) tracker.update(-30, true); // loud speech must not feed the window
  check("speech frames never raise the floor", Math.abs(tracker.value - before) < 0.5, tracker.value.toFixed(1));

  for (let i = 0; i < 60; i += 1) tracker.update(-85, false);
  check("floor follows the room down when it goes quiet", tracker.value < -80, tracker.value.toFixed(1));
}

/* ── VAD: the cases that matter at 5 m ───────────────────────────────── */

section("VAD · silence and steady noise are not speech");
{
  const gate = new VadGate("far");
  const silent = feed(gate, repeat(60, () => new Float32Array(FRAME)));
  check("digital silence never triggers speech", silent.every((f) => !f.speech));

  const gate2 = new VadGate("far");
  const noisy = feed(gate2, repeat(120, (i) => noiseFrame(0.004, i + 1)));
  check("steady room noise never triggers speech", noisy.every((f) => !f.speech), `floor ${noisy.at(-1).noiseFloorDb.toFixed(1)} dB`);
  check("noise floor converges to the room level", Math.abs(noisy.at(-1).noiseFloorDb - toDbfs(0.004 / Math.sqrt(3))) < 6, noisy.at(-1).noiseFloorDb.toFixed(1));
}

section("VAD · a distant voice (5 m) is detected");
{
  // Room noise ≈ -58 dBFS RMS, voice arrives only ~6 dB above it — roughly what
  // a laptop mic sees from 5 m in a quiet room.
  const gate = new VadGate("far");
  const noise = repeat(60, (i) => noiseFrame(0.004, i + 1));
  feed(gate, noise); // let the floor settle first

  const speech = feed(gate, repeat(40, (i) => mixedFrame(0.004, 0.008, 7, i * FRAME)), 60 * 21);
  const detected = speech.filter((f) => f.speech).length;
  check("distant speech is detected", detected > 30, `${detected}/40 frames`);
  check("SNR is reported as positive", speech.at(-1).snrDb > 0, `${speech.at(-1).snrDb.toFixed(1)} dB`);
  check("speech start is flagged once", speech.filter((f) => f.speechStart).length === 1);
}

section("VAD · close voice and clipping");
{
  // Realistic start: the session opens, the room is quiet for ~300 ms, then the
  // person speaks. Detection must be immediate once speech starts.
  const gate = new VadGate("near");
  feed(gate, repeat(15, (i) => noiseFrame(0.002, i + 1)));
  const speech = feed(gate, repeat(30, (i) => mixedFrame(0.002, 0.15, 3, i * FRAME)), 15 * 21);
  check(
    "close talk is detected within 3 frames of onset",
    speech[2].speech,
    `frame2 speech=${speech[2].speech} reason=${speech[2].reason}`
  );
  check("speech continues through the utterance", speech.slice(2).every((f) => f.speech));

  // Cold start with no quiet frames at all (user speaks the instant they press
  // start): the floor used to seed from that speech and stick the gate shut.
  const instant = new VadGate("near");
  const instantFrames = feed(instant, repeat(30, (i) => mixedFrame(0.002, 0.15, 3, i * FRAME)));
  check(
    "talking from a cold start is still detected (floor sanity clamp)",
    instantFrames.at(-1).speech,
    `floor=${instantFrames.at(-1).noiseFloorDb.toFixed(1)} dB speechMs=${instantFrames.at(-1).speechMs}`
  );
  check(
    "the clamped floor stays physically plausible",
    instantFrames.at(-1).noiseFloorDb <= NoiseFloorTracker.MAX_PLAUSIBLE_FLOOR_DB + 0.01,
    `${instantFrames.at(-1).noiseFloorDb.toFixed(1)} dB`
  );

  const gate2 = new VadGate("far");
  const clipped = feed(gate2, repeat(10, (i) => mixedFrame(0.004, 1.2, 5, i * FRAME)));
  check("clipping is reported even during warm-up", clipped.some((f) => f.reason === "clipping"));
}

section("VAD · a short pause must not end the utterance (the 5 m killer)");
{
  const gate = new VadGate("far");
  feed(gate, repeat(60, (i) => noiseFrame(0.004, i + 1)));

  const first = feed(gate, repeat(40, (i) => mixedFrame(0.004, 0.01, 7, i * FRAME)), 60 * 21);
  check("speech active before the pause", first.at(-1).speech);

  // 900 ms of pure room noise: a natural mid-sentence pause.
  const pause = feed(gate, repeat(43, (i) => noiseFrame(0.004, i + 40)), 100 * 21);
  check("900 ms pause keeps the gate open (hangover)", pause.every((f) => f.speech), `last speech=${pause.at(-1).speech} reason=${pause.at(-1).reason}`);

  const second = feed(gate, repeat(30, (i) => mixedFrame(0.004, 0.01, 9, i * FRAME)), 143 * 21);
  check("speech after the pause joins the same utterance (no new start)", second.every((f) => !f.speechStart));

  // Now a genuinely long silence must close it.
  // 80 frames × 21 ms ≈ 1.7 s of silence — comfortably past the 1.4 s hangover.
  const longPause = feed(gate, repeat(80, (i) => noiseFrame(0.004, i + 90)), 173 * 21);
  check(
    "a ~1.7 s silence closes the utterance",
    longPause.at(-1).silenceMs > 1400 && !longPause.at(-1).speech,
    `silence=${longPause.at(-1).silenceMs}ms speech=${longPause.at(-1).speech}`
  );
  check("exactly one speechEnd is emitted", longPause.filter((f) => f.speechEnd).length === 1);
}

section("VAD · near preset is stricter than far preset");
{
  const level = () => {
    const nearGate = new VadGate("near");
    const farGate = new VadGate("far");
    feed(nearGate, repeat(60, (i) => noiseFrame(0.004, i + 1)));
    feed(farGate, repeat(60, (i) => noiseFrame(0.004, i + 1)));
    const nearFrames = feed(nearGate, repeat(20, (i) => mixedFrame(0.004, 0.006, 7, i * FRAME)), 60 * 21);
    const farFrames = feed(farGate, repeat(20, (i) => mixedFrame(0.004, 0.006, 7, i * FRAME)), 60 * 21);
    return {
      near: nearFrames.filter((f) => f.speech).length,
      far: farFrames.filter((f) => f.speech).length,
    };
  };
  const { near, far } = level();
  check("far-field mode detects a quiet voice that near mode misses", far > near, `near=${near}/20 far=${far}/20`);
}

/* ── Transcript merging across restarts ──────────────────────────────── */

section("Transcript merge (no duplicated or lost words after a restart)");
{
  check("plain concatenation", mergeTranscripts("hello", "world") === "hello world");
  check("identical halves collapse", mergeTranscripts("hello world", "hello world") === "hello world");
  check(
    "word overlap is de-duplicated",
    mergeTranscripts("this is a live translation", "live translation test") === "this is a live translation test",
    mergeTranscripts("this is a live translation", "live translation test")
  );
  check(
    "multi-word overlap wins over the shorter one",
    mergeTranscripts("one two three four", "three four five") === "one two three four five"
  );
  check("empty left", mergeTranscripts("", "abc") === "abc");
  check("empty right", mergeTranscripts("abc", "") === "abc");
  check(
    "CJK overlap without spaces",
    mergeTranscripts("这是一次实时翻译", "实时翻译测试") === "这是一次实时翻译测试",
    mergeTranscripts("这是一次实时翻译", "实时翻译测试")
  );
  check(
    "no overlap still joins with a space",
    mergeTranscripts("完全不同的内容", "另一句话") === "完全不同的内容 另一句话"
  );
}

/* ── Calibration verdicts ────────────────────────────────────────────── */

section("Calibration verdicts drive honest advice");
{
  const good = new CalibrationAccumulator();
  for (let i = 0; i < 50; i += 1) good.addNoise(-62);
  for (let i = 0; i < 50; i += 1) good.addSpeech({ levelDb: -28, peak: 0.2 });
  const goodSample = good.snapshot(0.5);
  check("0.5 m close talk verdicts good", goodSample.verdict === "good", JSON.stringify(goodSample));
  check("advice is positive", adviseFromSample(goodSample).includes("充足"));

  const far = new CalibrationAccumulator();
  for (let i = 0; i < 50; i += 1) far.addNoise(-58);
  for (let i = 0; i < 50; i += 1) far.addSpeech({ levelDb: -48, peak: 0.01 });
  const farSample = far.snapshot(5);
  check("5 m quiet voice is marginal or worse", farSample.verdict !== "good", JSON.stringify(farSample));
  check("advice mentions the physical limit", /物理限制|噪声底|挪近/.test(adviseFromSample(farSample)), adviseFromSample(farSample));

  const hopeless = new CalibrationAccumulator();
  for (let i = 0; i < 50; i += 1) hopeless.addNoise(-52);
  for (let i = 0; i < 50; i += 1) hopeless.addSpeech({ levelDb: -68, peak: 0.004 });
  const hopelessSample = hopeless.snapshot(5);
  check("a voice below -60 dBFS is called too weak", hopelessSample.verdict === "too-weak", JSON.stringify(hopelessSample));
  check("advice recommends external hardware", adviseFromSample(hopelessSample).includes("外接麦克风"));
}

/* ── Report ──────────────────────────────────────────────────────────── */

const failed = results.filter((r) => !r.ok);
console.log(`\n${"=".repeat(64)}`);
console.log(`VAD/DSP checks: ${results.length}  passed: ${results.length - failed.length}  failed: ${failed.length}`);
if (failed.length) {
  console.log("\nFAILED:");
  for (const f of failed) console.log(`  · [${f.group}] ${f.name}${f.extra ? ` — ${f.extra}` : ""}`);
}
process.exit(failed.length ? 1 : 0);

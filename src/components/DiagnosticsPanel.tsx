import { useEffect, useState } from "react";
import { Activity, AlertTriangle, CheckCircle2, Copy, Gauge, RotateCcw, Ruler } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { adviseFromSample, type CalibrationSample } from "@/lib/dsp";
import { cn } from "@/lib/utils";
import { useTranslateStore } from "@/stores/translateStore";
import { showToast } from "@/stores/toastStore";

const DISTANCES = [0.5, 1, 2, 3, 5];

/**
 * Developer diagnostics for far-field work.
 *
 * Everything here is measured, not guessed: input level, RMS, peak, the learned
 * noise floor, SNR, the VAD decision, and the recognizer's own lifecycle
 * counters (restarts, gaps, last partial/final). The distance calibration walks
 * 0.5 → 5 m and records what the microphone actually received at each point,
 * which is the only honest way to answer "is 5 m fixable in software?".
 */
export function DiagnosticsPanel({ active }: { active: boolean }) {
  const analysis = useTranslateStore((s) => s.analysis);
  const vad = useTranslateStore((s) => s.vad);
  const capture = useTranslateStore((s) => s.capture);
  const recognition = useTranslateStore((s) => s.recognition);
  const refresh = useTranslateStore((s) => s.refreshDiagnostics);
  const startCalibration = useTranslateStore((s) => s.startCalibration);
  const finishCalibration = useTranslateStore((s) => s.finishCalibration);
  const calibrating = useTranslateStore((s) => s.calibrating);
  const calibrationDistance = useTranslateStore((s) => s.calibrationDistance);

  const [samples, setSamples] = useState<CalibrationSample[]>([]);
  const [copied, setCopied] = useState(false);

  // Poll at 4 Hz while the panel is open — cheap, and avoids re-rendering the
  // whole app on every animation frame.
  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 250);
    return () => clearInterval(id);
  }, [refresh]);

  const importSample = () => {
    const sample = finishCalibration();
    if (!sample) return;
    setSamples((prev) => [...prev.filter((s) => s.distanceM !== sample.distanceM), sample].sort((a, b) => a.distanceM - b.distanceM));
    showToast("success", `${sample.distanceM} m 已记录`, `SNR ${sample.snrDb} dB · ${sample.verdict}`);
  };

  const copyReport = async () => {
    const lines = [
      "# TalkQ 远场诊断",
      `麦克风: ${capture?.actual.deviceLabel ?? "未开始"}`,
      `采样率: ${capture?.actual.sampleRate ?? "-"} Hz / 声道 ${capture?.actual.channelCount ?? "-"}`,
      `处理: EC=${String(capture?.actual.echoCancellation)} NS=${String(capture?.actual.noiseSuppression)} AGC=${String(capture?.actual.autoGainControl)}`,
      `约束未支持: ${capture?.skipped?.join(", ") || "无"}`,
      "",
      "距离 | 噪声底(dBFS) | 说话电平(dBFS) | 峰值(dBFS) | SNR(dB) | 结论",
      ...samples.map(
        (s) => `${s.distanceM}m | ${s.noiseFloorDb} | ${s.speechRmsDb} | ${s.peakDb} | ${s.snrDb} | ${s.verdict}`
      ),
    ].join("\n");
    try {
      await navigator.clipboard.writeText(lines);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      showToast("error", "复制失败");
    }
  };

  return (
    <div className="space-y-3">
      {/* Live numbers */}
      <div className="rounded-lg border border-border bg-background/50 p-2.5">
        <div className="mb-2 flex items-center gap-1.5 text-meta uppercase tracking-[0.16em] text-muted-foreground">
          <Gauge className="h-3 w-3 text-primary/70" />
          实时音频
          {!active && <span className="ml-auto normal-case tracking-normal">（未开始）</span>}
        </div>
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1 font-mono text-[11px]">
          <Metric label="Mic level" value={analysis ? `${(analysis.level * 100).toFixed(0)}%` : "-"} />
          <Metric
            label="RMS"
            value={vad ? `${vad.levelDb.toFixed(1)} dBFS` : "-"}
          />
          <Metric label="Peak" value={vad ? `${(vad.peak * 100).toFixed(1)}%` : "-"} warn={Boolean(vad && vad.peak >= 0.99)} />
          <Metric
            label="Noise floor"
            value={vad ? `${vad.noiseFloorDb.toFixed(1)} dBFS` : "-"}
          />
          <Metric
            label="SNR"
            value={vad ? `${vad.snrDb.toFixed(1)} dB` : "-"}
            warn={Boolean(vad && vad.snrDb < 6 && vad.speech)}
            good={Boolean(vad && vad.snrDb >= 12)}
          />
          <Metric label="ZCR" value={vad ? vad.zcr.toFixed(3) : "-"} />
          <Metric
            label="Speech"
            value={vad ? (vad.speech ? `是 (${(vad.speechMs / 1000).toFixed(1)}s)` : `否 (静音 ${(Math.min(vad.silenceMs, 9999) / 1000).toFixed(1)}s)`) : "-"}
            good={Boolean(vad?.speech)}
          />
          <Metric label="VAD 状态" value={vad ? vad.reason : "-"} />
        </dl>
      </div>

      {/* Recognizer lifecycle */}
      <div className="rounded-lg border border-border bg-background/50 p-2.5">
        <div className="mb-2 flex items-center gap-1.5 text-meta uppercase tracking-[0.16em] text-muted-foreground">
          <Activity className="h-3 w-3 text-primary/70" />
          识别状态
        </div>
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1 font-mono text-[11px]">
          <Metric label="State" value={recognition?.state ?? "-"} />
          <Metric label="Restart count" value={String(recognition?.restartCount ?? 0)} warn={Boolean(recognition && recognition.restartCount > 20)} />
          <Metric label="Last gap" value={recognition ? `${recognition.lastGapMs} ms` : "-"} warn={Boolean(recognition && recognition.lastGapMs > 400)} />
          <Metric label="Total gap" value={recognition ? `${(recognition.totalGapMs / 1000).toFixed(1)} s` : "-"} />
          <Metric label="Finals" value={String(recognition?.finalsCount ?? 0)} />
          <Metric label="Empty sessions" value={String(recognition?.emptySessions ?? 0)} />
          <Metric label="Last event" value={recognition?.lastEvent || "-"} />
          <Metric
            label="Restarts by reason"
            value={
              recognition
                ? Object.entries(recognition.restartsByReason)
                    .filter(([, n]) => n > 0)
                    .map(([k, n]) => `${k}:${n}`)
                    .join(" ") || "-"
                : "-"
            }
          />
        </dl>
        <div className="mt-2 space-y-1">
          <Row label="Recognition error" value={recognition?.lastError ? `${recognition.lastError.title}${recognition.lastError.detail ? ` · ${recognition.lastError.detail}` : ""}` : "无"} warn={Boolean(recognition?.lastError)} />
          <Row label="Last partial" value={recognition?.lastPartial || "-"} />
          <Row label="Pending (未提交)" value={recognition?.pending || "-"} />
          <Row label="Last final" value={recognition?.lastFinal || "-"} />
        </div>
      </div>

      {/* Capture settings */}
      <div className="rounded-lg border border-border bg-background/50 p-2.5">
        <div className="mb-2 flex items-center gap-1.5 text-meta uppercase tracking-[0.16em] text-muted-foreground">
          <AlertTriangle className="h-3 w-3 text-primary/70" />
          采集实况（浏览器实际给的）
        </div>
        <div className="space-y-1">
          <Row label="设备" value={capture?.actual.deviceLabel ?? "未开始"} />
          <Row
            label="采样率 / 声道"
            value={capture ? `${capture.actual.sampleRate ?? "?"} Hz / ${capture.actual.channelCount ?? "?"}` : "-"}
          />
          <Row
            label="回声消除 / 降噪 / 自动增益"
            value={
              capture
                ? `${String(capture.actual.echoCancellation)} / ${String(capture.actual.noiseSuppression)} / ${String(capture.actual.autoGainControl)}`
                : "-"
            }
          />
          <Row label="不支持的参数（未发送）" value={capture?.skipped?.join(", ") || "无"} />
        </div>
        <p className="mt-2 text-meta leading-relaxed text-muted-foreground">
          注意：Web Speech API 自己打开音频输入，页面拿不到它的流，所以这里的设置是「请求」；
          真正决定识别效果的是浏览器实际给出的这几个值。
        </p>
      </div>

      {/* Distance calibration */}
      <div className="rounded-lg border border-border bg-background/50 p-2.5">
        <div className="mb-2 flex items-center gap-1.5 text-meta uppercase tracking-[0.16em] text-muted-foreground">
          <Ruler className="h-3 w-3 text-primary/70" />
          距离校准（真实测量）
        </div>

        {calibrating ? (
          <div className="space-y-2">
            <p className="text-[11px] leading-relaxed text-foreground">
              正在测量 <strong>{calibrationDistance} 米</strong>：
              先在原位保持安静 2 秒，再正常音量说 5 秒话，然后点「完成」。
            </p>
            <Button variant="secondary" size="sm" className="w-full gap-1.5" onClick={importSample}>
              <CheckCircle2 className="h-3.5 w-3.5" />
              完成并记录这个距离
            </Button>
          </div>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {DISTANCES.map((distance) => (
              <Button
                key={distance}
                variant="secondary"
                size="sm"
                disabled={!active}
                onClick={() => startCalibration(distance)}
              >
                {distance} 米
              </Button>
            ))}
            {!active && (
              <span className="text-meta text-muted-foreground">先开始实时翻译才能校准</span>
            )}
          </div>
        )}

        {samples.length > 0 && (
          <div className="mt-2.5 overflow-x-auto">
            <table className="w-full border-collapse text-[10px]">
              <thead>
                <tr className="text-muted-foreground">
                  <th className="border border-border px-1.5 py-1 text-left">距离</th>
                  <th className="border border-border px-1.5 py-1 text-left">噪声底</th>
                  <th className="border border-border px-1.5 py-1 text-left">说话</th>
                  <th className="border border-border px-1.5 py-1 text-left">SNR</th>
                  <th className="border border-border px-1.5 py-1 text-left">结论</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {samples.map((sample) => (
                  <tr key={sample.distanceM}>
                    <td className="border border-border px-1.5 py-1">{sample.distanceM} m</td>
                    <td className="border border-border px-1.5 py-1">{sample.noiseFloorDb}</td>
                    <td className="border border-border px-1.5 py-1">{sample.speechRmsDb}</td>
                    <td className="border border-border px-1.5 py-1">{sample.snrDb}</td>
                    <td
                      className={cn(
                        "border border-border px-1.5 py-1",
                        sample.verdict === "good"
                          ? "text-success"
                          : sample.verdict === "marginal"
                            ? "text-warning"
                            : "text-destructive"
                      )}
                    >
                      {sample.verdict}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-1.5 text-meta leading-relaxed text-muted-foreground">
              {adviseFromSample(samples[samples.length - 1])}
            </p>
            <Button variant="ghost" size="sm" className="mt-1.5 gap-1.5" onClick={copyReport}>
              {copied ? <CheckCircle2 className="h-3 w-3 text-success" /> : <Copy className="h-3 w-3" />}
              {copied ? "已复制" : "复制诊断报告"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="mt-1.5 gap-1.5 text-muted-foreground"
              onClick={() => setSamples([])}
            >
              <RotateCcw className="h-3 w-3" />
              清空
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
  warn,
  good,
}: {
  label: string;
  value: string;
  warn?: boolean;
  good?: boolean;
}) {
  return (
    <div className="flex items-baseline gap-1.5">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          "min-w-0 truncate",
          warn ? "text-destructive" : good ? "text-success" : "text-foreground/90"
        )}
        title={value}
      >
        {value}
      </dd>
    </div>
  );
}

function Row({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="flex items-start gap-2 text-[11px]">
      <span className="w-32 shrink-0 text-muted-foreground">{label}</span>
      <span className={cn("min-w-0 flex-1 break-words font-mono", warn ? "text-warning" : "text-foreground/85")}>
        {value}
      </span>
    </div>
  );
}

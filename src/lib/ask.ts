import { buildDocumentsContext } from "./documents";
import { buildTranscriptContext } from "./translate";
import { useChatStore } from "@/stores/chatStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useTranslateStore } from "@/stores/translateStore";
import { showToast } from "@/stores/toastStore";

/**
 * Bridge between the live-translation surface and the embedded Q&A panel.
 *
 * Both the panel's composer and the subtitle share button go through here, so a
 * question always rides along with the attached documents and the newest
 * subtitles (when that switch is on) while the visible conversation keeps only
 * what the user actually typed.
 */
export async function askDeepSeek(overrideText?: string): Promise<boolean> {
  const chat = useChatStore.getState();
  if (chat.isStreaming) {
    showToast("info", "正在回答上一条", "等这次输出结束再分享，或先点停止。");
    return false;
  }

  const { settings } = useSettingsStore.getState();
  const context = settings.askUseTranscriptContext
    ? buildTranscriptContext(useTranslateStore.getState().segments)
    : undefined;
  const documents = buildDocumentsContext(chat.draftDocuments);

  await chat.send(overrideText, { contextText: context, documentsText: documents });
  return true;
}

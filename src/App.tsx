import { useEffect, useState } from "react";
import { ApiKeyModal } from "@/components/ApiKeyModal";
import { ChatView } from "@/components/ChatView";
import { Composer } from "@/components/Composer";
import { Lightbox } from "@/components/Lightbox";
import { SettingsPanel } from "@/components/SettingsPanel";
import { Sidebar } from "@/components/Sidebar";
import { Toaster } from "@/components/Toaster";
import { TopBar } from "@/components/TopBar";
import { TranslateView } from "@/components/TranslateView";
import type { AppView } from "@/types";
import { useChatStore } from "@/stores/chatStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useTranslateStore } from "@/stores/translateStore";

/**
 * App shell.
 *
 *   App start ─▶ read localStorage ─▶ key present? ─┬─ no  ─▶ API Key modal
 *                                                   └─ yes ─▶ Chat | Live Translate
 */
export default function App() {
  const hydrateSettings = useSettingsStore((s) => s.hydrate);
  const hydrateChats = useChatStore((s) => s.hydrate);
  const hydrateTranscript = useTranslateStore((s) => s.hydrate);
  const stopTranslate = useTranslateStore((s) => s.stop);
  const settingsHydrated = useSettingsStore((s) => s.hydrated);
  const chatsHydrated = useChatStore((s) => s.hydrated);
  const transcriptHydrated = useTranslateStore((s) => s.hydrated);
  const settings = useSettingsStore((s) => s.settings);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const apiKey = useSettingsStore((s) => s.apiKey);
  const newChat = useChatStore((s) => s.newChat);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [keyPrompt, setKeyPrompt] = useState<"first-run" | "change" | null>(null);

  const hydrated = settingsHydrated && chatsHydrated && transcriptHydrated;
  const view: AppView = settings.lastView;

  useEffect(() => {
    hydrateSettings();
    hydrateChats();
    hydrateTranscript();
  }, [hydrateSettings, hydrateChats, hydrateTranscript]);

  // Gate the chat UI on the presence of a stored key.
  useEffect(() => {
    if (!hydrated) return;
    if (!apiKey) {
      setKeyPrompt("first-run");
      return;
    }
    setKeyPrompt((current) => (current === "change" ? "change" : null));
  }, [hydrated, apiKey]);

  // Small global shortcuts.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey;
      if (mod && event.shiftKey && event.key.toLowerCase() === "o") {
        event.preventDefault();
        updateSettings({ lastView: "chat" });
        newChat();
      }
      if (mod && event.shiftKey && event.key.toLowerCase() === "l") {
        event.preventDefault();
        updateSettings({ lastView: "translate" });
      }
      if (mod && event.key === ",") {
        event.preventDefault();
        setSettingsOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [newChat, updateSettings]);

  const switchView = (next: AppView) => {
    if (next === view) return;
    // Leaving the translate surface must release the microphone.
    if (view === "translate") stopTranslate();
    updateSettings({ lastView: next });
  };

  return (
    <div className="app-ambient relative flex h-full w-full overflow-hidden bg-background">
      <div className="hidden h-full lg:flex">
        <Sidebar
          view={view}
          onSelectView={switchView}
          onOpenSettings={() => setSettingsOpen(true)}
        />
      </div>

      {sidebarOpen && (
        <div className="fixed inset-0 z-30 flex lg:hidden">
          <div
            className="absolute inset-0 bg-background/70 backdrop-blur-sm"
            onClick={() => setSidebarOpen(false)}
            aria-hidden
          />
          <Sidebar
            className="relative"
            view={view}
            onSelectView={(next) => {
              setSidebarOpen(false);
              switchView(next);
            }}
            onOpenSettings={() => {
              setSidebarOpen(false);
              setSettingsOpen(true);
            }}
            onClose={() => setSidebarOpen(false)}
          />
        </div>
      )}

      <main className="dash-main flex min-w-0 flex-1 flex-col">
        <TopBar
          view={view}
          onOpenSettings={() => setSettingsOpen(true)}
          onToggleSidebar={() => setSidebarOpen((v) => !v)}
        />
        {view === "translate" ? (
          <TranslateView />
        ) : (
          <>
            <ChatView />
            <Composer />
          </>
        )}
      </main>

      <SettingsPanel
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onChangeKey={() => {
          setSettingsOpen(false);
          setKeyPrompt("change");
        }}
      />

      {keyPrompt && (
        <ApiKeyModal
          mode={keyPrompt}
          onDone={() => setKeyPrompt(null)}
          onCancel={() => setKeyPrompt(null)}
        />
      )}

      <Lightbox />
      <Toaster />
    </div>
  );
}

import { useEffect, useState } from "react";
import { ApiKeyModal } from "@/components/ApiKeyModal";
import { AskPanel } from "@/components/AskPanel";
import { Lightbox } from "@/components/Lightbox";
import { MobileApp, type MobileTab } from "@/components/MobileApp";
import { SettingsPanel } from "@/components/SettingsPanel";
import { Sidebar } from "@/components/Sidebar";
import { Toaster } from "@/components/Toaster";
import { TopBar } from "@/components/TopBar";
import { TranslateView } from "@/components/TranslateView";
import { useIsMobile } from "@/hooks/useIsMobile";
import { cn } from "@/lib/utils";
import { migrateLegacyStorage } from "@/lib/storage";
import { useChatStore } from "@/stores/chatStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useTranslateStore } from "@/stores/translateStore";

/**
 * App shell — one workspace: live translation with the Q&A panel built in.
 *
 *   App start ─▶ read localStorage ─▶ key present? ─┬─ no  ─▶ API Key modal
 *                                                   └─ yes ─▶ 实时翻译 + 问答栏
 */
export default function App() {
  const hydrateSettings = useSettingsStore((s) => s.hydrate);
  const hydrateChats = useChatStore((s) => s.hydrate);
  const hydrateTranscript = useTranslateStore((s) => s.hydrate);
  const settingsHydrated = useSettingsStore((s) => s.hydrated);
  const chatsHydrated = useChatStore((s) => s.hydrated);
  const transcriptHydrated = useTranslateStore((s) => s.hydrated);
  const settings = useSettingsStore((s) => s.settings);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const apiKey = useSettingsStore((s) => s.apiKey);
  const newChat = useChatStore((s) => s.newChat);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [mobileTab, setMobileTab] = useState<MobileTab>("subtitle");
  const [keyPrompt, setKeyPrompt] = useState<"first-run" | "change" | null>(null);

  const isMobile = useIsMobile();
  const hydrated = settingsHydrated && chatsHydrated && transcriptHydrated;
  const askOpen = settings.askPanelOpen;

  useEffect(() => {
    // Pre-rename installs keep their key/history: nexq_* -> talkq_* (once).
    migrateLegacyStorage();
    hydrateSettings();
    hydrateChats();
    hydrateTranscript();
  }, [hydrateSettings, hydrateChats, hydrateTranscript]);

  // Gate the UI on the presence of a stored key.
  useEffect(() => {
    if (!hydrated) return;
    if (!apiKey) {
      setKeyPrompt("first-run");
      return;
    }
    setKeyPrompt((current) => (current === "change" ? "change" : null));
  }, [hydrated, apiKey]);

  // Mobile: the subtitle share button switches to the Q&A tab.
  useEffect(() => {
    if (!isMobile) return;
    const openAsk = () => setMobileTab("ask");
    window.addEventListener("nexq:open-ask", openAsk);
    return () => window.removeEventListener("nexq:open-ask", openAsk);
  }, [isMobile]);

  // Shortcuts: ask panel, new question, settings.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey;
      if (mod && event.shiftKey && event.key.toLowerCase() === "o") {
        event.preventDefault();
        newChat();
        updateSettings({ askPanelOpen: true });
      }
      if (mod && event.shiftKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (isMobile) setMobileTab((tab) => (tab === "ask" ? "subtitle" : "ask"));
        else updateSettings({ askPanelOpen: !useSettingsStore.getState().settings.askPanelOpen });
      }
      if (mod && event.key === ",") {
        event.preventDefault();
        setSettingsOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [newChat, updateSettings, isMobile]);

  /* ── Phone layout: one pane + bottom tabs ─────────────────────────── */
  if (isMobile) {
    return (
      <div className="app-ambient relative flex h-full w-full flex-col overflow-hidden bg-background">
        <TopBar
          compact
          askOpen={mobileTab === "ask"}
          onOpenSettings={() => setSettingsOpen(true)}
          onToggleSidebar={() => setSidebarOpen((v) => !v)}
          onToggleAsk={() => setMobileTab((tab) => (tab === "ask" ? "subtitle" : "ask"))}
        />

        <MobileApp tab={mobileTab} onTabChange={setMobileTab} />

        {sidebarOpen && (
          <div className="fixed inset-0 z-40 flex">
            <div
              className="absolute inset-0 bg-background/70 backdrop-blur-sm"
              onClick={() => setSidebarOpen(false)}
              aria-hidden
            />
            <Sidebar
              className="pt-safe relative w-[82%] max-w-[19rem]"
              onOpenSettings={() => {
                setSidebarOpen(false);
                setSettingsOpen(true);
              }}
              onClose={() => setSidebarOpen(false)}
            />
          </div>
        )}

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
        <Toaster className="bottom-safe" />
      </div>
    );
  }

  return (
    <div className="app-ambient relative flex h-full w-full overflow-hidden bg-background">
      {/* Sidebar: one instance, inline on lg+, drawer below that. */}
      <div
        className={cn(
          "h-full",
          sidebarOpen ? "fixed inset-y-0 left-0 z-30 flex" : "hidden lg:flex"
        )}
      >
        <Sidebar
          onOpenSettings={() => setSettingsOpen(true)}
          onClose={sidebarOpen ? () => setSidebarOpen(false) : undefined}
        />
      </div>
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-20 bg-background/70 backdrop-blur-sm lg:hidden"
          onClick={() => setSidebarOpen(false)}
          aria-hidden
        />
      )}

      <main className="dash-main flex min-w-0 flex-1 flex-col">
        <TopBar
          onOpenSettings={() => setSettingsOpen(true)}
          onToggleSidebar={() => setSidebarOpen((v) => !v)}
          askOpen={askOpen}
          onToggleAsk={() => updateSettings({ askPanelOpen: !askOpen })}
        />
        <TranslateView />
      </main>

      {/*
        Q&A panel: ONE mounted instance (its composer owns a document-level
        paste listener, so rendering it twice would double-attach images).
        Inline column at xl+, overlay drawer below that.
      */}
      {askOpen && (
        <>
          <div
            className="fixed inset-0 z-20 bg-background/70 backdrop-blur-sm xl:hidden"
            onClick={() => updateSettings({ askPanelOpen: false })}
            aria-hidden
          />
          <div className="fixed inset-y-0 right-0 z-30 w-full max-w-[26rem] xl:static xl:z-auto xl:h-full xl:w-[24rem] xl:max-w-none xl:shrink-0">
            <AskPanel onClose={() => updateSettings({ askPanelOpen: false })} />
          </div>
        </>
      )}

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

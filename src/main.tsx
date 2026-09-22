import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { useChatStore } from "./stores/chatStore";
import { useSettingsStore } from "./stores/settingsStore";
import { useTranslateStore } from "./stores/translateStore";
import "./index.css";

const container = document.getElementById("root");
if (!container) throw new Error("Root container #root is missing from index.html");

/**
 * Debug hook for the developer console — the same data the in-app diagnostics
 * panel shows, e.g.
 *
 *   __TALKQ__.translate.getState().recognition      // restart counters, gaps
 *   __TALKQ__.translate.getState().vad              // RMS / noise floor / SNR
 *   __TALKQ__.translate.getState().capture          // what the device gave us
 *
 * It exposes nothing that is not already reachable from this page's own
 * localStorage, and it is how the far-field verification harness asserts on
 * real runtime state instead of guessing from the DOM.
 */
(window as unknown as Record<string, unknown>).__TALKQ__ = {
  translate: useTranslateStore,
  settings: useSettingsStore,
  chat: useChatStore,
};

ReactDOM.createRoot(container).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);

// Drop the static splash once React has taken over.
document.getElementById("talkq-splash")?.remove();

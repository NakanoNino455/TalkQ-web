import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./index.css";

const container = document.getElementById("root");
if (!container) throw new Error("Root container #root is missing from index.html");

ReactDOM.createRoot(container).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);

// Drop the static splash once React has taken over.
document.getElementById("talkq-splash")?.remove();

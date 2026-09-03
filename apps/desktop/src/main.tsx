import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { AppErrorBoundary } from "./ErrorBoundary";
import { desktopApi } from "./api";
import { initializeTheme } from "./theme";
import "./styles.css";

initializeTheme();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode><AppErrorBoundary report={(error, info) => {
    void desktopApi.reportFrontendError(error.message, info.componentStack ?? "");
  }}><App /></AppErrorBoundary></React.StrictMode>,
);

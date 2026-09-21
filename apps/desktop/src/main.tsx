import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { AppErrorBoundary } from "./ErrorBoundary";
import { desktopApi } from "./api";
import { initializeTheme } from "./theme";
import "./styles.css";

const root = ReactDOM.createRoot(document.getElementById("root")!);

if (import.meta.env.VITE_PORTCOVE_DESIGN_COMPATIBILITY_FIXTURE === "1") {
  void import("./design-compatibility/DesignCompatibilityFixture").then(
    ({ DesignCompatibilityFixture }) => {
      root.render(
        <React.StrictMode>
          <DesignCompatibilityFixture />
        </React.StrictMode>,
      );
    },
  );
} else {
  initializeTheme();
  root.render(
    <React.StrictMode>
      <AppErrorBoundary
        report={(error, info) => {
          void desktopApi.reportFrontendError(error.message, info.componentStack ?? "");
        }}
      >
        <App />
      </AppErrorBoundary>
    </React.StrictMode>,
  );
}

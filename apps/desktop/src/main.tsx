import React from "react";
import ReactDOM from "react-dom/client";
import { DirectionProvider } from "@base-ui/react/direction-provider";
import App from "./App";
import { AppErrorBoundary } from "./ErrorBoundary";
import { desktopApi } from "./api";
import { initializeTheme } from "./theme";
import { initializeLocalization, LocalizationProvider } from "./localization";
import "./styles.css";

const root = ReactDOM.createRoot(document.getElementById("root")!);
document.documentElement.dir = "ltr";

if (import.meta.env.VITE_PORTCOVE_DESIGN_COMPATIBILITY_FIXTURE === "1") {
  void import("./design-compatibility/DesignCompatibilityFixture").then(
    ({ DesignCompatibilityFixture }) => {
      root.render(
        <React.StrictMode>
          <DirectionProvider direction="ltr">
            <DesignCompatibilityFixture />
          </DirectionProvider>
        </React.StrictMode>,
      );
    },
  );
} else {
  initializeTheme();
  initializeLocalization();
  root.render(
    <React.StrictMode>
      <LocalizationProvider api={desktopApi}>
        <AppErrorBoundary
          report={(error, info) => {
            void desktopApi.reportFrontendError(error.message, info.componentStack ?? "");
          }}
        >
          <App />
        </AppErrorBoundary>
      </LocalizationProvider>
    </React.StrictMode>,
  );
}

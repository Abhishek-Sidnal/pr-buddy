import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-500.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "@fontsource/ibm-plex-mono/latin-500.css";
import "./styles/tokens.css";
import "./styles/app.css";
import { App } from "./app.js";
import { applyTheme, readThemePreference } from "./theme.js";

// Before anything is drawn, so the page does not appear in one theme and switch to another.
applyTheme(readThemePreference());

const root = document.getElementById("root");
if (root === null) {
  throw new Error("The page has no #root element.");
}

createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);

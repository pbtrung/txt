import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./theme.scss";
import "bootstrap-icons/font/bootstrap-icons.css";
import "@fontsource/literata/400.css";
import "./index.css";

import { App } from "./App";
import { initMonitoring } from "./monitoring";

function appRoot(): HTMLElement {
  const root = document.getElementById("root");
  if (!root) throw new Error("Missing #root application element");
  return root;
}

createRoot(appRoot(), initMonitoring()).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

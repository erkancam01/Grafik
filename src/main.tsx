import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

try {
  const s = JSON.parse(window.localStorage.getItem("grafik.settings") ?? "{}") as { theme?: string };
  document.documentElement.dataset.theme = s.theme === "light" ? "light" : "dark";
} catch {
  document.documentElement.dataset.theme = "dark";
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

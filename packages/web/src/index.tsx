import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Home } from "@/pages/home";
import "@/index.css";

const el = document.getElementById("root")!;
const app = (
  <StrictMode>
    <Home />
  </StrictMode>
);

if (import.meta.hot) {
  // With hot module reloading, `import.meta.hot.data` is persisted.
  const root = (import.meta.hot.data.root ??= createRoot(el));
  root.render(app);
} else {
  // The hot module reloading API is not available in production.
  createRoot(el).render(app);
}

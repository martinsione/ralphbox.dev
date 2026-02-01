import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { SessionsProvider } from "@/hooks/use-sessions";
import { Home } from "@/pages/home";
import "@/index.css";

const root = document.getElementById("root")!;

const app = (
  <StrictMode>
    <BrowserRouter>
      <SessionsProvider>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/s/:sessionId" element={<Home />} />
        </Routes>
      </SessionsProvider>
    </BrowserRouter>
  </StrictMode>
);

if (import.meta.hot) {
  const reactRoot = (import.meta.hot.data.root ??= createRoot(root));
  reactRoot.render(app);
} else {
  createRoot(root).render(app);
}

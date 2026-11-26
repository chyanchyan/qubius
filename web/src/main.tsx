import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ensureApiTokenCookie } from "./api";
import { DialogProvider } from "./ui";
import "./styles.css";
import "./ui/ui.css";

/* 在第一次 render（及其中的 EventSource/fetch）之前同步种一次 cookie：
   浏览器重启后 session cookie 会丢，而 EventSource 只能靠 cookie。 */
ensureApiTokenCookie();

const root = document.getElementById("root");
if (!root) throw new Error("缺少根节点");
createRoot(root).render(
  <StrictMode>
    <DialogProvider>
      <App />
    </DialogProvider>
  </StrictMode>,
);

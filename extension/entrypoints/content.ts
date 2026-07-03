// Injected page toast: "Saved ✓" first, swaps to the gist when enrichment
// completes (design §6.1). No popup UI in v1.

export default defineContentScript({
  matches: ["<all_urls>"],
  main() {
    let el: HTMLDivElement | null = null;
    let hideTimer: ReturnType<typeof setTimeout> | undefined;

    browser.runtime.onMessage.addListener((message) => {
      if (message?.type !== "amber-toast") return;
      show(message.text, message.state);
    });

    function show(text: string, state: "ok" | "gist" | "error") {
      if (!el) {
        el = document.createElement("div");
        el.id = "amber-toast";
        Object.assign(el.style, {
          position: "fixed",
          right: "16px",
          bottom: "16px",
          zIndex: "2147483647",
          maxWidth: "340px",
          padding: "10px 14px",
          borderRadius: "10px",
          font: "13px/1.4 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
          color: "#fff",
          boxShadow: "0 4px 16px rgba(0,0,0,.25)",
          transition: "opacity .25s",
          opacity: "0",
          pointerEvents: "none",
        });
        document.documentElement.appendChild(el);
      }
      el.style.background =
        state === "error" ? "#b3372b" : state === "gist" ? "#5c4a2f" : "#b5762a";
      el.textContent = text;
      requestAnimationFrame(() => el && (el.style.opacity = "1"));
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => el && (el.style.opacity = "0"), state === "gist" ? 6000 : 3000);
    }
  },
});

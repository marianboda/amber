import { defineConfig } from "wxt";

export default defineConfig({
  manifest: {
    name: "Amber",
    description: "Save the current page or any link to your Amber library.",
    permissions: ["activeTab", "contextMenus", "storage", "scripting", "tabs"],
    host_permissions: ["<all_urls>"],
    action: { default_title: "Save to Amber" },
    commands: {
      _execute_action: {
        suggested_key: { default: "Alt+Shift+S" },
        description: "Save current tab to Amber",
      },
    },
  },
});

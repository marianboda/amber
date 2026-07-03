import { defineConfig } from "wxt";

export default defineConfig({
  manifest: {
    name: "Amber",
    description: "Save the current page or any link to your Amber library.",
    permissions: ["activeTab", "contextMenus", "storage", "scripting", "tabs"],
    host_permissions: ["<all_urls>"],
    icons: { 16: "icon/16.png", 32: "icon/32.png", 48: "icon/48.png", 128: "icon/128.png" },
    action: {
      default_title: "Save to Amber",
      default_icon: { 16: "icon/16.png", 32: "icon/32.png", 48: "icon/48.png" },
    },
    commands: {
      _execute_action: {
        suggested_key: { default: "Alt+Shift+S" },
        description: "Save current tab to Amber",
      },
    },
  },
});

import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";

// The svelte plugin compiles .svelte.ts rune modules (store.svelte.ts) so
// $state works under vitest.
export default defineConfig({
  plugins: [svelte()],
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});

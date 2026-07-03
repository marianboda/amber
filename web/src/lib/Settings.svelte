<script lang="ts">
  import { api, getToken, setToken } from "./api";
  import { store, reload, reloadTopics } from "./store.svelte";

  let token = $state(getToken());
  let status = $state("");
  let saveUrl = $state("");
  let saveMsg = $state("");

  async function applyToken() {
    setToken(token.trim());
    try {
      await api.ping();
      status = "✓ connected";
      reload();
      reloadTopics();
    } catch {
      status = "✗ unauthorized — check token";
    }
  }

  async function quickSave() {
    if (!saveUrl.trim()) return;
    try {
      const res = await api.save(saveUrl.trim());
      saveMsg = res.duplicate ? "already saved" : "saved ✓";
      saveUrl = "";
      reload();
    } catch (e: any) {
      saveMsg = `error: ${e.message}`;
    }
  }

  async function download(format: "json" | "html") {
    const res = await fetch(api.exportUrl(format), {
      headers: { Authorization: `Bearer ${getToken()}` },
    });
    const blob = await res.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = format === "json" ? "amber-export.json" : "amber-export.html";
    a.click();
    URL.revokeObjectURL(a.href);
  }
</script>

<div class="page">
  <button class="back" onclick={() => (store.page = "library")}>← Library</button>
  <h1>Settings</h1>

  <section>
    <h2>API token</h2>
    <div class="row">
      <input type="password" bind:value={token} placeholder="bearer token" />
      <button onclick={applyToken}>Connect</button>
      <span class="status">{status}</span>
    </div>
  </section>

  <section>
    <h2>Quick save</h2>
    <div class="row">
      <input type="url" bind:value={saveUrl} placeholder="https://…" onkeydown={(e) => e.key === "Enter" && quickSave()} />
      <button onclick={quickSave}>Save</button>
      <span class="status">{saveMsg}</span>
    </div>
  </section>

  <section>
    <h2>Import</h2>
    <p class="muted">Netscape bookmark HTML / CSV import — coming in the next build phase.</p>
  </section>

  <section>
    <h2>Export</h2>
    <div class="row">
      <button onclick={() => download("json")}>JSON (full fidelity)</button>
      <button onclick={() => download("html")}>Netscape HTML</button>
    </div>
  </section>

  <section>
    <h2>LLM</h2>
    <p class="muted">
      Configured server-side via environment: <code>AMBER_LLM_PROVIDER</code>,
      <code>AMBER_LLM_MODEL</code>, <code>AMBER_LLM_API_KEY</code>, <code>AMBER_LLM_BASE_URL</code>,
      <code>GEMINI_API_KEY</code> (YouTube).
    </p>
  </section>

  <section>
    <h2>Topics</h2>
    <p class="muted">Vocabulary not bootstrapped yet — topic management lands with the classification phase.</p>
  </section>
</div>

<style>
  .page {
    max-width: 640px;
    margin: 0 auto;
    padding: 1.5rem 1rem 4rem;
    display: flex;
    flex-direction: column;
    gap: 1.2rem;
  }
  .back {
    align-self: flex-start;
    background: none;
    border: none;
    color: var(--accent);
    cursor: pointer;
    font-size: 0.85rem;
    padding: 0;
  }
  h1 {
    margin: 0;
    font-size: 1.4rem;
  }
  h2 {
    font-size: 0.95rem;
    margin: 0 0 0.5rem;
  }
  section {
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 0.9rem 1rem;
    background: var(--surface);
  }
  .row {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    flex-wrap: wrap;
  }
  input {
    flex: 1;
    min-width: 220px;
    padding: 0.4rem 0.6rem;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg);
    color: inherit;
    font-size: 0.85rem;
  }
  button {
    padding: 0.4rem 0.9rem;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: var(--bg);
    color: inherit;
    cursor: pointer;
    font-size: 0.82rem;
  }
  .status {
    font-size: 0.78rem;
    color: var(--muted);
  }
  .muted {
    color: var(--muted);
    font-size: 0.82rem;
    margin: 0;
  }
  code {
    font-size: 0.75rem;
  }
</style>

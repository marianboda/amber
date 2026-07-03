<script lang="ts">
  import { store, reload } from "./store.svelte";
  import { CONTENT_TYPES, TYPE_ICONS } from "./format";

  let debounce: ReturnType<typeof setTimeout>;
  function onSearch(e: Event) {
    store.q = (e.target as HTMLInputElement).value;
    clearTimeout(debounce);
    debounce = setTimeout(reload, 250);
  }
  function setType(t: string) {
    store.type = store.type === t ? "" : t;
    reload();
  }
  function setTopic(name: string) {
    store.topic = store.topic === name ? "" : name;
    reload();
  }
</script>

<header>
  <div class="row">
    <span class="logo">🟠 Amber</span>
    <input type="search" placeholder="Search title, gist, notes…" value={store.q} oninput={onSearch} />
    <button
      class="icon-btn"
      title="Toggle grid/list"
      onclick={() => (store.view = store.view === "grid" ? "list" : "grid")}
    >
      {store.view === "grid" ? "☰" : "▦"}
    </button>
    <button class="icon-btn" title="Settings" onclick={() => (store.page = "settings")}>⚙︎</button>
  </div>
  <div class="row filters">
    {#each store.topics.filter((t) => (t.count ?? 0) > 0) as t (t.id)}
      <button class="chip" class:active={store.topic === t.name} onclick={() => setTopic(t.name)}>
        {t.name} <span class="count">{t.count}</span>
      </button>
    {/each}
    <span class="spacer"></span>
    {#each CONTENT_TYPES as t}
      <button class="chip type" class:active={store.type === t} onclick={() => setType(t)} title={t}>
        {TYPE_ICONS[t]}
      </button>
    {/each}
  </div>
</header>

<style>
  header {
    position: sticky;
    top: 0;
    z-index: 10;
    background: var(--bg);
    border-bottom: 1px solid var(--border);
    padding: 0.6rem 1rem 0.5rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 0.6rem;
  }
  .logo {
    font-weight: 700;
    white-space: nowrap;
  }
  input[type="search"] {
    flex: 1;
    max-width: 480px;
    padding: 0.4rem 0.7rem;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface);
    color: inherit;
    font-size: 0.85rem;
  }
  .icon-btn {
    background: none;
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 0.25rem 0.5rem;
    cursor: pointer;
    color: inherit;
    font-size: 0.9rem;
  }
  .filters {
    flex-wrap: wrap;
    gap: 0.3rem;
  }
  .chip {
    font-size: 0.75rem;
    padding: 0.15rem 0.6rem;
    border-radius: 99px;
    border: 1px solid var(--border);
    background: var(--surface);
    color: inherit;
    cursor: pointer;
  }
  .chip.active {
    border-color: var(--accent);
    color: var(--accent);
    font-weight: 600;
  }
  .count {
    color: var(--muted);
    font-size: 0.68rem;
  }
  .spacer {
    flex: 1;
  }
  .chip.type {
    padding: 0.15rem 0.4rem;
  }
</style>

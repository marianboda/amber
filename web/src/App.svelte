<script lang="ts">
  import { onMount } from "svelte";
  import {
    store,
    reload,
    loadMore,
    reloadTopics,
    applyHash,
    buildHash,
    bulkMarkRead,
    bulkDelete,
    showToast,
  } from "./lib/store.svelte";
  import { api, getToken } from "./lib/api";
  import TopBar from "./lib/TopBar.svelte";
  import Card from "./lib/Card.svelte";
  import Detail from "./lib/Detail.svelte";
  import Settings from "./lib/Settings.svelte";

  let sentinel = $state<HTMLElement | null>(null);
  let applyingHash = false;

  onMount(() => {
    applyingHash = true;
    applyHash(location.hash);
    applyingHash = false;
    if (!getToken()) {
      store.page = "settings";
    } else {
      handleShareTarget();
      reload();
      reloadTopics();
    }
  });

  // Android PWA share sheet lands on /share?url=…&text=…&title=… (manifest
  // share_target). Some apps put the link in `text` — take the first URL found.
  async function handleShareTarget() {
    if (location.pathname !== "/share") return;
    const params = new URLSearchParams(location.search);
    const raw = params.get("url") || params.get("text") || "";
    const url = raw.match(/https?:\/\/\S+/)?.[0];
    history.replaceState(null, "", "/");
    if (!url) {
      showToast("Nothing to save — no link in the shared content");
      return;
    }
    try {
      const res = await api.save(url, { saved_from: "share_sheet" });
      showToast(
        res.duplicate && res.saved_at
          ? `Already in Amber — first saved ${new Date(res.saved_at * 1000).toLocaleDateString()}`
          : "Saved ✓"
      );
      if (!res.duplicate) reload(); // surface the fresh card (initial load raced the save)
    } catch (e: any) {
      showToast(`Save failed: ${e?.message ?? "unknown error"}`);
    }
  }

  // State → URL. Opening a detail pushes a history entry (so Back closes the
  // panel); everything else replaces, to keep history clean while filtering.
  let lastDetail: string | null = null;
  $effect(() => {
    const hash = buildHash();
    const detail = store.detailId;
    if (applyingHash) {
      lastDetail = detail;
      return;
    }
    if (hash !== location.hash) {
      if (detail && !lastDetail) {
        history.pushState(null, "", hash || "#");
      } else {
        history.replaceState(null, "", hash || location.pathname);
      }
    }
    lastDetail = detail;
  });

  // URL → state (back/forward buttons, pasted deep links).
  function onPopState() {
    applyingHash = true;
    const filtersChanged = applyHash(location.hash);
    applyingHash = false;
    if (filtersChanged) reload();
  }

  // Global keys: / focuses search, j/k move card focus, Escape is handled by
  // the layer components. Never hijack keys while the user is typing.
  function onKeydown(e: KeyboardEvent) {
    const t = e.target as HTMLElement;
    if (
      t?.tagName === "INPUT" ||
      t?.tagName === "TEXTAREA" ||
      t?.tagName === "SELECT" ||
      t?.isContentEditable
    )
      return;
    if (store.page !== "library" || store.detailId) return;
    if (e.key === "/") {
      e.preventDefault();
      document.querySelector<HTMLInputElement>("#lib-search")?.focus();
    } else if (e.key === "j" || e.key === "ArrowDown" || e.key === "k" || e.key === "ArrowUp") {
      const forward = e.key === "j" || e.key === "ArrowDown";
      const targets = [...document.querySelectorAll<HTMLElement>(".card .title-btn")];
      if (!targets.length) return;
      e.preventDefault();
      const current = targets.indexOf(document.activeElement as HTMLElement);
      const next = current < 0 ? 0 : Math.min(Math.max(current + (forward ? 1 : -1), 0), targets.length - 1);
      targets[next].focus();
      targets[next].scrollIntoView({ block: "nearest" });
    }
  }

  $effect(() => {
    if (!sentinel) return;
    const io = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) loadMore();
    });
    io.observe(sentinel);
    return () => io.disconnect();
  });
</script>

<svelte:window onpopstate={onPopState} onhashchange={onPopState} onkeydown={onKeydown} />

{#if store.page === "settings"}
  <Settings />
{:else}
  <TopBar />
  <main>
    {#if store.error}
      <p class="msg error" role="alert">{store.error}</p>
    {/if}
    {#if store.stalePoll}
      <p class="msg notice" role="status">
        Some items are still processing.
        <button class="linkish" onclick={() => reload()}>Refresh</button>
      </p>
    {/if}
    <div class="cards" class:list={store.view === "list"}>
      {#each store.bookmarks as b (b.id)}
        <Card bookmark={b} />
      {/each}
    </div>
    {#if !store.loading && !store.bookmarks.length && !store.error}
      <p class="msg">Nothing saved yet. Save your first link from Settings → Quick save.</p>
    {/if}
    <div bind:this={sentinel} class="sentinel"></div>
    {#if store.loading}<p class="msg" role="status">Loading…</p>{/if}
  </main>
  <Detail />
  {#if store.selected.length}
    <div class="bulkbar" role="toolbar" aria-label="Bulk actions">
      <span>{store.selected.length} selected</span>
      <button onclick={() => bulkMarkRead(true)}>Mark read</button>
      <button onclick={() => bulkMarkRead(false)}>Mark unread</button>
      <button class="danger" onclick={bulkDelete}>Delete</button>
      <button onclick={() => (store.selected = [])}>Clear</button>
    </div>
  {/if}
{/if}

{#if store.toast}
  <div class="toast" role="status" aria-live="polite">{store.toast}</div>
{/if}

<style>
  main {
    padding: 1rem;
    max-width: 1400px;
    margin: 0 auto;
  }
  .cards {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
    gap: 0.8rem;
  }
  @media (max-width: 560px) {
    main {
      padding: 0.6rem;
    }
    .cards {
      grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
      gap: 0.5rem;
    }
  }
  .cards.list {
    grid-template-columns: 1fr;
    gap: 0.4rem;
    max-width: 860px;
    margin: 0 auto;
  }
  .msg {
    text-align: center;
    color: var(--muted);
    padding: 2rem 0;
  }
  .msg.error {
    color: #c0392b;
  }
  .msg.notice {
    padding: 0.5rem 0;
    font-size: 0.85rem;
  }
  .linkish {
    background: none;
    border: none;
    color: var(--accent);
    cursor: pointer;
    font-size: inherit;
    padding: 0;
    text-decoration: underline;
  }
  .sentinel {
    height: 1px;
  }
  .bulkbar {
    position: fixed;
    bottom: 1rem;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    gap: 0.6rem;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 0.5rem 0.9rem;
    z-index: 15;
    box-shadow: 0 4px 16px rgb(0 0 0 / 0.18);
    font-size: 0.85rem;
  }
  .bulkbar button {
    background: none;
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 0.25rem 0.6rem;
    color: inherit;
    cursor: pointer;
    font-size: 0.8rem;
  }
  .bulkbar .danger {
    color: #c0392b;
    border-color: #c0392b;
  }
  .toast {
    position: fixed;
    bottom: 1rem;
    right: 1rem;
    background: var(--surface);
    border: 1px solid var(--accent);
    border-radius: 8px;
    padding: 0.6rem 1rem;
    font-size: 0.85rem;
    z-index: 40;
    max-width: 320px;
    box-shadow: 0 4px 16px rgb(0 0 0 / 0.18);
  }
</style>

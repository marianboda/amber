<script lang="ts">
  import { onMount } from "svelte";
  import { store, reload, loadMore, reloadTopics } from "./lib/store.svelte";
  import { getToken } from "./lib/api";
  import TopBar from "./lib/TopBar.svelte";
  import Card from "./lib/Card.svelte";
  import Detail from "./lib/Detail.svelte";
  import Settings from "./lib/Settings.svelte";

  let sentinel = $state<HTMLElement | null>(null);

  onMount(() => {
    if (!getToken()) {
      store.page = "settings";
    } else {
      reload();
      reloadTopics();
    }
  });

  $effect(() => {
    if (!sentinel) return;
    const io = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) loadMore();
    });
    io.observe(sentinel);
    return () => io.disconnect();
  });
</script>

{#if store.page === "settings"}
  <Settings />
{:else}
  <TopBar />
  <main>
    {#if store.error}
      <p class="msg error">{store.error}</p>
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
    {#if store.loading}<p class="msg">Loading…</p>{/if}
  </main>
  <Detail />
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
  .sentinel {
    height: 1px;
  }
</style>

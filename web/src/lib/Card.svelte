<script lang="ts">
  import type { Bookmark } from "./api";
  import { api } from "./api";
  import { TYPE_ICONS, relativeDate, domainColor } from "./format";
  import { store } from "./store.svelte";

  let { bookmark }: { bookmark: Bookmark } = $props();

  function open() {
    store.detailId = bookmark.id;
  }
  function openOriginal(e: MouseEvent) {
    e.stopPropagation();
    window.open(bookmark.url, "_blank", "noopener");
  }
  async function retry(e: MouseEvent) {
    e.stopPropagation();
    await api.retry(bookmark.id);
    bookmark.enrich_status = "pending";
  }
</script>

<article
  class="card"
  class:list={store.view === "list"}
  onclick={open}
  onauxclick={openOriginal}
  role="button"
  tabindex="0"
  onkeydown={(e) => e.key === "Enter" && open()}
>
  {#if store.view === "grid"}
    <div class="thumb" style:background-color={domainColor(bookmark.domain)}>
      {#if bookmark.og_image_url}
        <img src={bookmark.og_image_url} alt="" loading="lazy" />
      {:else if bookmark.favicon_url}
        <img class="favicon-tile" src={bookmark.favicon_url} alt="" loading="lazy" />
      {:else}
        <span class="tile-letter">{(bookmark.domain ?? "?")[0]}</span>
      {/if}
    </div>
  {/if}
  <div class="body">
    <div class="meta">
      {#if bookmark.favicon_url}<img class="favicon" src={bookmark.favicon_url} alt="" />{/if}
      <span class="domain">{bookmark.domain}</span>
      <span class="type" title={bookmark.content_type ?? ""}>
        {bookmark.content_type ? TYPE_ICONS[bookmark.content_type] ?? "🔖" : ""}
      </span>
      <span class="date">{relativeDate(bookmark.saved_at)}</span>
    </div>
    <h3>{bookmark.title ?? bookmark.url}</h3>
    {#if bookmark.enrich_status === "pending"}
      <div class="shimmer"></div>
    {:else if bookmark.enrich_status === "failed"}
      <button class="retry" onclick={retry} title="Enrichment failed — retry">⟳ retry</button>
    {:else if bookmark.gist}
      <p class="gist">{bookmark.gist}</p>
    {/if}
    {#if bookmark.topics.length}
      <div class="chips">
        {#each bookmark.topics as t (t.id)}
          <span class="chip" style:--chip-color={t.color ?? "#b58a3c"}>{t.name}</span>
        {/each}
      </div>
    {/if}
  </div>
</article>

<style>
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    overflow: hidden;
    cursor: pointer;
    display: flex;
    flex-direction: column;
    transition: border-color 0.15s;
  }
  .card:hover {
    border-color: var(--accent);
  }
  .card.list {
    flex-direction: row;
    border-radius: 6px;
  }
  .thumb {
    height: 120px;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
  }
  .thumb > img:not(.favicon-tile) {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .favicon-tile {
    width: 40px;
    height: 40px;
  }
  .tile-letter {
    font-size: 2rem;
    font-weight: 600;
    color: rgb(0 0 0 / 0.45);
    text-transform: uppercase;
  }
  .body {
    padding: 0.6rem 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    min-width: 0;
  }
  .meta {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.72rem;
    color: var(--muted);
  }
  .favicon {
    width: 14px;
    height: 14px;
  }
  .domain {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .date {
    margin-left: auto;
    flex-shrink: 0;
  }
  h3 {
    font-size: 0.88rem;
    font-weight: 600;
    margin: 0;
    line-height: 1.3;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    word-break: break-word;
  }
  .gist {
    font-size: 0.8rem;
    color: var(--muted);
    margin: 0;
    line-height: 1.4;
  }
  .card.list .gist {
    display: -webkit-box;
    -webkit-line-clamp: 1;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .shimmer {
    height: 0.9rem;
    border-radius: 4px;
    background: linear-gradient(90deg, var(--border) 25%, var(--surface2) 50%, var(--border) 75%);
    background-size: 200% 100%;
    animation: shimmer 1.4s infinite;
  }
  @keyframes shimmer {
    to {
      background-position: -200% 0;
    }
  }
  .retry {
    align-self: flex-start;
    font-size: 0.75rem;
    background: none;
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--muted);
    cursor: pointer;
    padding: 0.1rem 0.4rem;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
  }
  .chip {
    font-size: 0.68rem;
    padding: 0.05rem 0.45rem;
    border-radius: 99px;
    border: 1px solid var(--chip-color);
    color: var(--chip-color);
  }
</style>

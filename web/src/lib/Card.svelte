<script lang="ts">
  import type { Bookmark } from "./api";
  import { api } from "./api";
  import { TYPE_ICONS, relativeDate, domainColor } from "./format";
  import { store, guarded, toggleSelected, updateBookmark, reload } from "./store.svelte";

  let { bookmark }: { bookmark: Bookmark } = $props();

  const selected = $derived(store.selected.includes(bookmark.id));

  function open(e?: MouseEvent) {
    // Shift/meta-click selects instead of opening — bulk triage after imports.
    if (e && (e.shiftKey || e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      toggleSelected(bookmark.id);
      return;
    }
    store.detailId = bookmark.id;
  }
  function openOriginal(e?: Event) {
    e?.stopPropagation();
    window.open(bookmark.url, "_blank", "noopener");
  }
  async function retry(e: MouseEvent) {
    e.stopPropagation();
    const ok = await guarded(() => api.retry(bookmark.id));
    if (ok) bookmark.enrich_status = "pending";
  }
  async function toggleRead() {
    const updated = await guarded(() => api.patch(bookmark.id, { is_read: !bookmark.is_read }));
    if (updated) updateBookmark(updated);
  }
  function filterDomain(e: MouseEvent) {
    e.stopPropagation();
    store.domain = store.domain === bookmark.domain ? "" : bookmark.domain ?? "";
    reload();
  }
  // o = open original, r = toggle read, x = select — while a card has focus.
  function onKeydown(e: KeyboardEvent) {
    if (e.key === "o") {
      e.preventDefault();
      openOriginal();
    } else if (e.key === "r") {
      e.preventDefault();
      toggleRead();
    } else if (e.key === "x") {
      e.preventDefault();
      toggleSelected(bookmark.id);
    }
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<!-- Whole-card click is a mouse convenience; keyboard/AT users get the same
     action via the focusable title button inside. -->
<article
  class="card"
  class:list={store.view === "list"}
  class:selected
  class:read={!!bookmark.is_read}
  onclick={open}
  onauxclick={openOriginal}
  onkeydown={onKeydown}
>
  <input
    type="checkbox"
    class="select"
    class:visible={store.selected.length > 0}
    checked={selected}
    aria-label="Select bookmark"
    onclick={(e) => {
      e.stopPropagation();
      toggleSelected(bookmark.id);
    }}
  />
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
      <button
        class="domain"
        title="Filter by {bookmark.domain}"
        aria-pressed={store.domain === bookmark.domain}
        onclick={filterDomain}>{bookmark.domain}</button
      >
      <span class="type" title={bookmark.content_type ?? ""}>
        {bookmark.content_type ? TYPE_ICONS[bookmark.content_type] ?? "🔖" : ""}
      </span>
      <span class="date">{relativeDate(bookmark.saved_at)}</span>
    </div>
    <h3>
      <button class="title-btn" onclick={open}>{bookmark.title ?? bookmark.url}</button>
    </h3>
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
    position: relative;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    overflow: hidden;
    cursor: pointer;
    display: flex;
    flex-direction: column;
    transition: border-color 0.15s;
    /* Native offscreen skipping — keeps a 20k-card grid scrollable. */
    content-visibility: auto;
    contain-intrinsic-size: auto 240px;
  }
  .card:hover,
  .card:focus-within {
    border-color: var(--accent);
  }
  .card.selected {
    border-color: var(--accent);
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }
  .card.list {
    flex-direction: row;
    border-radius: 6px;
    contain-intrinsic-size: auto 88px;
  }
  .select {
    position: absolute;
    top: 0.45rem;
    left: 0.45rem;
    z-index: 2;
    width: 1rem;
    height: 1rem;
    accent-color: var(--accent);
    opacity: 0;
    transition: opacity 0.12s;
  }
  .card:hover .select,
  .card:focus-within .select,
  .select.visible,
  .select:checked {
    opacity: 1;
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
    background: none;
    border: none;
    padding: 0;
    font: inherit;
    color: inherit;
    cursor: pointer;
  }
  .domain:hover {
    color: var(--accent);
    text-decoration: underline;
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
  }
  .title-btn {
    background: none;
    border: none;
    padding: 0;
    font: inherit;
    color: inherit;
    cursor: pointer;
    text-align: left;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    word-break: break-word;
  }
  .title-btn:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
    border-radius: 3px;
  }
  .card.read .title-btn {
    color: var(--muted);
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
    line-clamp: 1;
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

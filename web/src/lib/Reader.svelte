<script lang="ts">
  import type { Bookmark } from "./api";

  let { bookmark, onclose }: { bookmark: Bookmark; onclose: () => void } = $props();

  let fontSize = $state(Number(localStorage.getItem("amber_reader_size") ?? 19));
  function bump(delta: number) {
    fontSize = Math.min(28, Math.max(14, fontSize + delta));
    localStorage.setItem("amber_reader_size", String(fontSize));
  }

  const paragraphs = $derived(
    (bookmark.content_text ?? "")
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0)
  );
</script>

<div class="reader">
  <div class="bar">
    <button class="close" onclick={onclose}>← Back</button>
    <span class="domain">{bookmark.domain}</span>
    <span class="sizer">
      <button onclick={() => bump(-1)}>A−</button>
      <button onclick={() => bump(1)}>A+</button>
    </span>
  </div>
  <article style:font-size="{fontSize}px">
    <h1>{bookmark.title ?? bookmark.url}</h1>
    {#if bookmark.gist}<p class="gist">{bookmark.gist}</p>{/if}
    {#each paragraphs as p}
      <p>{p}</p>
    {/each}
    {#if !paragraphs.length}
      <p class="empty">No extracted text for this page — try the archived copy or the original.</p>
    {/if}
  </article>
</div>

<style>
  .reader {
    position: fixed;
    inset: 0;
    z-index: 30;
    background: var(--bg);
    overflow-y: auto;
  }
  .bar {
    position: sticky;
    top: 0;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.5rem 1rem;
    background: var(--bg);
    border-bottom: 1px solid var(--border);
    font-size: 0.85rem;
    color: var(--muted);
  }
  .bar button {
    background: none;
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 0.2rem 0.6rem;
    color: inherit;
    cursor: pointer;
    font-size: 0.8rem;
  }
  .sizer {
    display: flex;
    gap: 0.3rem;
  }
  article {
    max-width: 42rem;
    margin: 0 auto;
    padding: 2rem 1.2rem 6rem;
    font-family: Georgia, "Times New Roman", serif;
    line-height: 1.65;
  }
  h1 {
    font-size: 1.5em;
    line-height: 1.25;
  }
  .gist {
    color: var(--muted);
    font-style: italic;
  }
  .empty {
    color: var(--muted);
  }
</style>

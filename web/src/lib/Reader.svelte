<script lang="ts">
  import type { Bookmark } from "./api";

  let { bookmark, onclose }: { bookmark: Bookmark; onclose: () => void } = $props();

  let fontSize = $state(Number(localStorage.getItem("amber_reader_size") ?? 19));
  function bump(delta: number) {
    fontSize = Math.min(28, Math.max(14, fontSize + delta));
    localStorage.setItem("amber_reader_size", String(fontSize));
  }

  function esc(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  // Reader HTML renders in a sandboxed iframe (scripts blocked; server scrubbed
  // them too). <base> restores the page's relative images/links; allow-popups
  // lets links open in a real tab.
  const srcdoc = $derived(
    bookmark.content_html
      ? `<!doctype html><html><head><meta charset="utf-8">
<base href="${esc(bookmark.url)}" target="_blank">
<style>
  body { max-width: 42rem; margin: 0 auto; padding: 2rem 1.2rem 6rem;
         font-family: Georgia, "Times New Roman", serif; line-height: 1.65;
         font-size: ${fontSize}px; color: #1d1d1f; background: #fff; }
  @media (prefers-color-scheme: dark) {
    body { color: #e8e6e3; background: #1c1b1a; }
    a { color: #e8b04b; }
  }
  img, video { max-width: 100%; height: auto; }
  pre { overflow-x: auto; padding: 0.8rem; background: rgb(128 128 128 / 0.12); border-radius: 6px; }
  code { font-size: 0.9em; }
  blockquote { border-left: 3px solid rgb(128 128 128 / 0.4); margin-left: 0; padding-left: 1rem; }
  h1.amber-title { font-size: 1.5em; line-height: 1.25; }
  p.amber-gist { opacity: 0.65; font-style: italic; }
</style></head><body>
<h1 class="amber-title">${esc(bookmark.title ?? bookmark.url)}</h1>
${bookmark.gist ? `<p class="amber-gist">${esc(bookmark.gist)}</p>` : ""}
${bookmark.content_html}
</body></html>`
      : null
  );

  // Plain-text fallback for rows enriched before reader HTML existed.
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
      <button onclick={() => bump(-1)} aria-label="Smaller text">A−</button>
      <button onclick={() => bump(1)} aria-label="Larger text">A+</button>
    </span>
  </div>
  {#if srcdoc}
    <iframe {srcdoc} sandbox="allow-popups allow-popups-to-escape-sandbox" title="Reader view"></iframe>
  {:else}
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
  {/if}
</div>

<style>
  .reader {
    position: fixed;
    inset: 0;
    z-index: 30;
    background: var(--bg);
    display: flex;
    flex-direction: column;
  }
  .bar {
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
  iframe {
    flex: 1;
    border: none;
    background: var(--bg);
  }
  article {
    flex: 1;
    overflow-y: auto;
    max-width: 42rem;
    margin: 0 auto;
    padding: 2rem 1.2rem 6rem;
    font-family: Georgia, "Times New Roman", serif;
    line-height: 1.65;
    width: 100%;
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

<script lang="ts">
  import { api, type Bookmark } from "./api";
  import { store, updateBookmark, removeBookmark } from "./store.svelte";
  import { TYPE_ICONS, provenance } from "./format";
  import Reader from "./Reader.svelte";

  let readerOpen = $state(false);

  let bookmark = $state<Bookmark | null>(null);
  let note = $state("");
  let saving = $state(false);

  $effect(() => {
    const requested = store.detailId;
    if (requested) {
      api.get(requested).then((b) => {
        // Ignore a slow response for a bookmark the user already navigated away
        // from — otherwise clicking A then B could leave A's data on screen.
        if (store.detailId !== requested) return;
        bookmark = b;
        note = b.note ?? "";
      });
    } else {
      bookmark = null;
    }
  });

  function close() {
    store.detailId = null;
  }
  async function saveNote() {
    if (!bookmark) return;
    saving = true;
    const updated = await api.patch(bookmark.id, { note });
    bookmark = updated;
    updateBookmark(updated);
    saving = false;
  }
  async function toggleRead() {
    if (!bookmark) return;
    const updated = await api.patch(bookmark.id, { is_read: !bookmark.is_read });
    bookmark = updated;
    updateBookmark(updated);
  }
  async function del() {
    if (!bookmark || !confirm("Delete this bookmark?")) return;
    await api.remove(bookmark.id);
    removeBookmark(bookmark.id);
  }
  let archiveUrl = $state("");

  // Render the snapshot in a sandboxed iframe (no scripts, opaque origin) —
  // a plain window.open(blobUrl) would run on this app's origin.
  async function openArchive() {
    if (!bookmark) return;
    const res = await fetch(`/api/bookmarks/${bookmark.id}/archive`, {
      headers: { Authorization: `Bearer ${localStorage.getItem("amber_token") ?? ""}` },
    });
    if (!res.ok) return;
    archiveUrl = URL.createObjectURL(await res.blob());
  }
  function closeArchive() {
    URL.revokeObjectURL(archiveUrl);
    archiveUrl = "";
  }
</script>

{#if bookmark}
  <div class="backdrop" onclick={close} role="presentation"></div>
  <aside>
    <button class="close" onclick={close}>✕</button>
    <div class="meta">
      {#if bookmark.favicon_url}<img src={bookmark.favicon_url} alt="" />{/if}
      <span>{bookmark.domain}</span>
      <span>{bookmark.content_type ? TYPE_ICONS[bookmark.content_type] : ""} {bookmark.content_type ?? ""}</span>
      {#if bookmark.fetch_status === "dead"}<span class="dead">☠ dead link</span>{/if}
    </div>
    <h2>{bookmark.title ?? bookmark.url}</h2>
    <a class="url" href={bookmark.url} target="_blank" rel="noopener">{bookmark.url}</a>

    {#if bookmark.summary}<p class="summary">{bookmark.summary}</p>{/if}

    {#if bookmark.topics.length}
      <div class="chips">
        {#each bookmark.topics as t (t.id)}
          <span class="chip">{t.name}{t.by_ai ? "" : " ✎"}</span>
        {/each}
      </div>
    {/if}

    <label class="note-label" for="note">Note</label>
    <textarea id="note" bind:value={note} rows="4" placeholder="Your note…"></textarea>
    {#if note !== (bookmark.note ?? "")}
      <button class="save" onclick={saveNote} disabled={saving}>{saving ? "Saving…" : "Save note"}</button>
    {/if}

    <label class="read">
      <input type="checkbox" checked={!!bookmark.is_read} onchange={toggleRead} />
      read
    </label>

    <p class="provenance">{provenance(bookmark)} · {new Date(bookmark.saved_at * 1000).toLocaleString()}</p>

    <div class="actions">
      <a class="btn" href={bookmark.url} target="_blank" rel="noopener">Open original ↗</a>
      {#if bookmark.content_text}
        <button class="btn" onclick={() => (readerOpen = true)}>Read 📖</button>
      {/if}
      {#if bookmark.archive_ref}
        <button class="btn" onclick={openArchive}>Archived copy 🗂</button>
      {/if}
      <button class="btn danger" onclick={del}>Delete</button>
    </div>
  </aside>
{/if}

{#if readerOpen && bookmark}
  <Reader {bookmark} onclose={() => (readerOpen = false)} />
{/if}

{#if archiveUrl}
  <div class="archive-overlay">
    <div class="archive-bar">
      <span>🗂 Archived copy — snapshot from save time</span>
      <button class="close" onclick={closeArchive}>✕ Close</button>
    </div>
    <iframe src={archiveUrl} sandbox="" title="Archived copy"></iframe>
  </div>
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgb(0 0 0 / 0.35);
    z-index: 20;
  }
  aside {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    width: min(440px, 92vw);
    background: var(--bg);
    border-left: 1px solid var(--border);
    z-index: 21;
    padding: 1.2rem;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 0.7rem;
  }
  .close {
    align-self: flex-end;
    background: none;
    border: none;
    font-size: 1rem;
    cursor: pointer;
    color: var(--muted);
  }
  .meta {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.78rem;
    color: var(--muted);
  }
  .meta img {
    width: 16px;
    height: 16px;
  }
  .dead {
    color: #c0392b;
  }
  h2 {
    margin: 0;
    font-size: 1.1rem;
    line-height: 1.3;
  }
  .url {
    font-size: 0.75rem;
    color: var(--accent);
    word-break: break-all;
  }
  .summary {
    font-size: 0.88rem;
    line-height: 1.55;
    margin: 0;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
  }
  .chip {
    font-size: 0.72rem;
    padding: 0.1rem 0.5rem;
    border-radius: 99px;
    border: 1px solid var(--accent);
    color: var(--accent);
  }
  .note-label {
    font-size: 0.75rem;
    color: var(--muted);
    margin-top: 0.4rem;
  }
  textarea {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 0.5rem;
    color: inherit;
    font: inherit;
    font-size: 0.85rem;
    resize: vertical;
  }
  .save {
    align-self: flex-start;
    padding: 0.3rem 0.8rem;
    border-radius: 6px;
    border: 1px solid var(--accent);
    background: var(--accent);
    color: white;
    cursor: pointer;
    font-size: 0.8rem;
  }
  .read {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.82rem;
    color: var(--muted);
  }
  .provenance {
    font-size: 0.72rem;
    color: var(--muted);
    margin: 0;
  }
  .actions {
    display: flex;
    gap: 0.6rem;
    margin-top: auto;
    padding-top: 1rem;
  }
  .btn {
    padding: 0.35rem 0.9rem;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: var(--surface);
    color: inherit;
    cursor: pointer;
    font-size: 0.8rem;
    text-decoration: none;
  }
  .btn.danger {
    color: #c0392b;
    border-color: #c0392b;
  }
  .archive-overlay {
    position: fixed;
    inset: 0;
    z-index: 30;
    background: var(--bg);
    display: flex;
    flex-direction: column;
  }
  .archive-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.5rem 1rem;
    border-bottom: 1px solid var(--border);
    font-size: 0.85rem;
    color: var(--muted);
  }
  .archive-overlay iframe {
    flex: 1;
    border: none;
    background: #fff;
  }
</style>

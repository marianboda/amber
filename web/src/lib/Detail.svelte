<script lang="ts">
  import { tick } from "svelte";
  import { api, type Bookmark } from "./api";
  import { store, guarded, showToast, updateBookmark, removeBookmark } from "./store.svelte";
  import { TYPE_ICONS, provenance } from "./format";
  import Reader from "./Reader.svelte";

  let readerOpen = $state(false);

  let bookmark = $state<Bookmark | null>(null);
  let note = $state("");
  let saving = $state<"" | "saving" | "saved">("");
  let panel = $state<HTMLElement | null>(null);
  let opener: HTMLElement | null = null;

  $effect(() => {
    const requested = store.detailId;
    if (requested) {
      opener = document.activeElement as HTMLElement;
      guarded(() => api.get(requested)).then((b) => {
        // Ignore a slow response for a bookmark the user already navigated away
        // from — otherwise clicking A then B could leave A's data on screen.
        if (!b || store.detailId !== requested) return;
        bookmark = b;
        note = b.note ?? "";
        saving = "";
        tick().then(() => panel?.querySelector<HTMLElement>(".close")?.focus());
      });
    } else {
      bookmark = null;
      readerOpen = false;
      // Hand focus back to the card that opened the panel.
      opener?.focus?.();
      opener = null;
    }
  });

  function close() {
    flushNote();
    store.detailId = null;
  }

  // Notes autosave (debounced + on blur/close) — a typed note must survive any
  // way of leaving the panel; zero-question ethos, no confirm dialogs.
  let noteTimer: ReturnType<typeof setTimeout>;
  function onNoteInput() {
    clearTimeout(noteTimer);
    noteTimer = setTimeout(flushNote, 800);
  }
  async function flushNote() {
    clearTimeout(noteTimer);
    if (!bookmark || note === (bookmark.note ?? "")) return;
    saving = "saving";
    const id = bookmark.id;
    const updated = await guarded(() => api.patch(id, { note }));
    if (updated) {
      if (bookmark?.id === id) bookmark = updated;
      updateBookmark(updated);
      saving = "saved";
      setTimeout(() => (saving = ""), 1500);
    } else {
      saving = "";
    }
  }

  async function toggleRead() {
    if (!bookmark) return;
    const updated = await guarded(() => api.patch(bookmark!.id, { is_read: !bookmark!.is_read }));
    if (updated) {
      bookmark = updated;
      note = updated.note ?? note;
      updateBookmark(updated);
    }
  }
  async function del() {
    if (!bookmark || !confirm("Delete this bookmark? It stays in trash for 30 days.")) return;
    const id = bookmark.id;
    const ok = await guarded(() => api.remove(id));
    if (ok) removeBookmark(id);
  }
  let archiveUrl = $state("");

  // Render the snapshot in a sandboxed iframe (no scripts, opaque origin) —
  // a plain window.open(blobUrl) would run on this app's origin.
  async function openArchive() {
    if (!bookmark) return;
    const res = await fetch(`/api/bookmarks/${bookmark.id}/archive`, {
      headers: { Authorization: `Bearer ${localStorage.getItem("amber_token") ?? ""}` },
    }).catch(() => null);
    if (!res?.ok) {
      showToast("Couldn't load the archived copy");
      return;
    }
    archiveUrl = URL.createObjectURL(await res.blob());
  }
  function closeArchive() {
    URL.revokeObjectURL(archiveUrl);
    archiveUrl = "";
  }

  // Escape peels layers in order: archive overlay → reader → panel.
  function onKeydown(e: KeyboardEvent) {
    if (e.key !== "Escape") {
      if (e.key === "Tab" && bookmark && !readerOpen && !archiveUrl) trapFocus(e);
      return;
    }
    if (archiveUrl) closeArchive();
    else if (readerOpen) readerOpen = false;
    else if (bookmark) close();
  }

  // Minimal focus trap: Tab cycles inside the dialog while it's open.
  function trapFocus(e: KeyboardEvent) {
    if (!panel) return;
    const focusables = [
      ...panel.querySelectorAll<HTMLElement>(
        'button, a[href], input, textarea, [tabindex]:not([tabindex="-1"])'
      ),
    ].filter((el) => el.offsetParent !== null);
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement as HTMLElement;
    if (e.shiftKey && (active === first || !panel.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !panel.contains(active))) {
      e.preventDefault();
      first.focus();
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

{#if bookmark}
  <div class="backdrop" onclick={close} role="presentation"></div>
  <div class="panel" bind:this={panel} role="dialog" aria-modal="true" aria-label={bookmark.title ?? bookmark.url}>
    <button class="close" onclick={close} aria-label="Close details">✕</button>
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

    <label class="note-label" for="note">
      Note
      {#if saving === "saving"}<span class="save-state">saving…</span>
      {:else if saving === "saved"}<span class="save-state">saved ✓</span>{/if}
    </label>
    <textarea
      id="note"
      bind:value={note}
      rows="4"
      placeholder="Your note…"
      oninput={onNoteInput}
      onblur={flushNote}
    ></textarea>

    <label class="read">
      <input type="checkbox" checked={!!bookmark.is_read} onchange={toggleRead} />
      read
    </label>

    <p class="provenance">{provenance(bookmark)} · {new Date(bookmark.saved_at * 1000).toLocaleString()}</p>

    <div class="actions">
      <a class="btn" href={bookmark.url} target="_blank" rel="noopener">Open original ↗</a>
      {#if bookmark.content_text || bookmark.content_html}
        <button class="btn" onclick={() => (readerOpen = true)}>Read 📖</button>
      {/if}
      {#if bookmark.archive_ref}
        <button class="btn" onclick={openArchive}>Archived copy 🗂</button>
      {/if}
      <button class="btn danger" onclick={del}>Delete</button>
    </div>
  </div>
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
  .panel {
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
  .save-state {
    margin-left: 0.5rem;
    font-style: italic;
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

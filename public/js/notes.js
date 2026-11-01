const Notes = (() => {
  const SWATCHES = ['#6366F1', '#E63950', '#F59E0B', '#10B981', '#06B6D4', '#EC4899', '#8B5CF6', '#9090B0'];
  const SAVE_DELAY_MS = 500;
  const UNDO_MS = 6000;

  let notes = [];
  let current = null;           // the note open in the editor; id stays null until it has content
  let query = '';
  let saveTimer = null;
  let saveChain = Promise.resolve();
  const pendingDeletes = new Map();

  // ── Helpers ───────────────────────────────────────────────────────────────

  function esc(str) {
    return Charts.esc(str ?? '');
  }

  function plainTitle(title) {
    return title === 'Untitled' ? '' : (title || '');
  }

  function isBlank(note) {
    return !plainTitle(note.title).trim() && !(note.body || '').trim() && !(note.tags || []).length;
  }

  function displayTitle(note) {
    const firstLine = (note.body || '').split('\n').find(line => line.trim());
    return plainTitle(note.title).trim() || firstLine?.trim() || 'Untitled';
  }

  function snippet(note) {
    const body = (note.body || '').trim();
    if (!plainTitle(note.title).trim()) {
      const lines = body.split('\n').filter(line => line.trim());
      return lines.slice(1).join(' ');
    }
    return body.replace(/\s+/g, ' ');
  }

  function fmtListDate(iso) {
    const d = new Date(iso);
    if (d.toLocaleDateString('sv') === new Date().toLocaleDateString('sv')) {
      return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    }
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  function workingCopy(note) {
    return {
      id: note.id,
      title: plainTitle(note.title),
      body: note.body || '',
      color: note.color || SWATCHES[0],
      tags: [...(note.tags || [])],
      updatedAt: note.updatedAt,
    };
  }

  // ── Saving (automatic) ────────────────────────────────────────────────────

  function setStatus(text) {
    const el = document.getElementById('noteStatus');
    if (el) el.textContent = text;
  }

  async function persist(target) {
    if (!target.id && isBlank(target)) return;
    const body = { title: target.title.trim(), body: target.body, color: target.color, tags: target.tags };
    try {
      if (target.id) {
        const updated = await API.notes.update(target.id, body);
        notes = notes.map(n => (n.id === target.id ? updated : n));
        target.updatedAt = updated.updatedAt;
      } else {
        const created = await API.notes.create(body);
        notes.push(created);
        target.id = created.id;
        target.updatedAt = created.updatedAt;
      }
      if (target === current) setStatus('Saved');
      renderList();
    } catch (err) {
      console.error('Failed to save note:', err);
      if (target === current) setStatus('Could not save');
    }
  }

  function flushSave() {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (!current) return saveChain;
    const target = current;
    saveChain = saveChain.then(() => persist(target));
    return saveChain;
  }

  function scheduleSave() {
    setStatus('Saving…');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, SAVE_DELAY_MS);
    renderList();
  }

  // Leaving a note: save what changed, and drop it if it was left empty.
  async function leaveCurrent() {
    const target = current;
    if (!target) return;
    if (saveTimer) await flushSave();
    await saveChain;
    if (target.id && isBlank(target)) {
      notes = notes.filter(n => n.id !== target.id);
      API.notes.delete(target.id).catch(err => console.error('Failed to delete note:', err));
    }
  }

  // ── Render: list ──────────────────────────────────────────────────────────

  function visibleNotes() {
    const q = query.trim().toLowerCase();
    const merged = notes
      .filter(n => !pendingDeletes.has(n.id))
      .map(n => (current && n.id === current.id ? { ...n, ...current } : n));
    if (current && !current.id) merged.push({ ...current, updatedAt: new Date().toISOString(), isDraft: true });
    return merged
      .filter(n => !q || `${n.title} ${n.body} ${(n.tags || []).join(' ')}`.toLowerCase().includes(q))
      .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  }

  function renderList() {
    const list = document.getElementById('notesList');
    if (!list) return;

    const items = visibleNotes();
    if (items.length === 0) {
      list.innerHTML = `<p class="notes-list__empty">${query.trim() ? 'No notes match that search.' : 'Your notes will show up here.'}</p>`;
      return;
    }

    list.innerHTML = items.map(n => {
      const isActive = current && (n.isDraft ? !current.id : n.id === current.id);
      const text = snippet(n);
      return `
        <button class="notes-item${isActive ? ' is-active' : ''}" data-open-note="${n.id || ''}">
          <span class="notes-item__top">
            <span class="notes-item__dot" style="background:${n.color}"></span>
            <span class="notes-item__title">${n.isDraft && isBlank(n) ? 'New note' : esc(displayTitle(n))}</span>
            <span class="notes-item__date">${fmtListDate(n.updatedAt)}</span>
          </span>
          ${text ? `<span class="notes-item__snippet">${esc(text)}</span>` : ''}
        </button>`;
    }).join('');
  }

  // ── Render: editor ────────────────────────────────────────────────────────

  function tagsHTML() {
    return current.tags.map((t, i) => `
      <span class="note-chip">
        ${esc(t)}
        <button type="button" class="note-chip__remove" data-remove-tag="${i}" aria-label="Remove tag ${esc(t)}"><i data-lucide="x"></i></button>
      </span>`).join('');
  }

  function renderTags() {
    const row = document.getElementById('noteTags');
    if (!row) return;
    row.innerHTML = tagsHTML();
    lucide.createIcons({ nodes: [row] });
  }

  function renderEditor() {
    const editor = document.getElementById('notesEditor');
    if (!editor) return;

    if (!current) {
      editor.innerHTML = `
        <div class="empty-state">
          <i data-lucide="notebook-pen"></i>
          <p class="empty-state__text">Jot down an idea. Everything saves on its own, and any note can become something you track.</p>
          <button class="btn btn--primary" data-new-note><i data-lucide="plus"></i> New note</button>
        </div>`;
      lucide.createIcons({ nodes: [editor] });
      return;
    }

    editor.innerHTML = `
      <div class="note-editor__toolbar">
        <div class="note-swatches" role="group" aria-label="Note color">
          ${SWATCHES.map(color => `
            <button type="button" class="note-swatch${color.toLowerCase() === current.color.toLowerCase() ? ' is-active' : ''}"
                    data-color="${color}" aria-label="Color ${color}" style="--swatch:${color}"></button>`).join('')}
        </div>
        <span class="note-editor__status" id="noteStatus" aria-live="polite">${current.id ? 'Saved' : ''}</span>
        <button type="button" class="btn btn--ghost btn--sm" data-promote><i data-lucide="target"></i> Track this</button>
        <button type="button" class="btn btn--ghost btn--sm btn--icon" data-delete-note aria-label="Delete note" title="Delete note"><i data-lucide="trash-2"></i></button>
      </div>
      <input type="text" class="note-editor__title" id="noteTitle" placeholder="Untitled" maxlength="80" aria-label="Note title" />
      <div class="note-editor__tags">
        <div class="note-tags" id="noteTags">${tagsHTML()}</div>
        <input type="text" class="note-editor__tag-input" id="noteTagInput" placeholder="Add tag" maxlength="24" aria-label="Add a tag, then press Enter" />
      </div>
      <textarea class="note-editor__body" id="noteBody" placeholder="Start writing…" aria-label="Note text"></textarea>`;

    document.getElementById('noteTitle').value = current.title;
    document.getElementById('noteBody').value = current.body;
    lucide.createIcons({ nodes: [editor] });
  }

  // ── Actions ───────────────────────────────────────────────────────────────

  async function newNote() {
    await leaveCurrent();
    current = { id: null, title: '', body: '', color: SWATCHES[0], tags: [] };
    query = '';
    const search = document.getElementById('notesSearch');
    if (search) search.value = '';
    renderList();
    renderEditor();
    document.getElementById('noteTitle')?.focus();
  }

  async function openNote(id) {
    if (current && current.id === (id || null)) return;
    await leaveCurrent();
    const note = notes.find(n => n.id === id);
    current = note ? workingCopy(note) : null;
    renderList();
    renderEditor();
  }

  function selectFirst() {
    const first = visibleNotes()[0];
    const note = first && notes.find(n => n.id === first.id);
    current = note ? workingCopy(note) : null;
  }

  function deleteCurrent() {
    const target = current;
    clearTimeout(saveTimer);
    saveTimer = null;
    current = null;

    if (target.id) {
      const timer = setTimeout(() => {
        pendingDeletes.delete(target.id);
        notes = notes.filter(n => n.id !== target.id);
        API.notes.delete(target.id).catch(err => console.error('Failed to delete note:', err));
      }, UNDO_MS);
      pendingDeletes.set(target.id, timer);

      App.showToast('Note deleted', UNDO_MS, {
        label: 'Undo',
        onClick: () => {
          clearTimeout(pendingDeletes.get(target.id));
          pendingDeletes.delete(target.id);
          current = target;
          renderList();
          renderEditor();
        },
      });
    }

    selectFirst();
    renderList();
    renderEditor();
  }

  // A title-only note has nothing else to keep, so it moves over; notes with text stay.
  function promoteCurrent() {
    const target = current;
    const name = displayTitle(target).slice(0, 40);
    App.openCategoryModalPrefilled(name === 'Untitled' ? '' : name, target.color, async cat => {
      if (target.id && !target.body.trim()) {
        notes = notes.filter(n => n.id !== target.id);
        await API.notes.delete(target.id).catch(err => console.error('Failed to delete note:', err));
        if (current === target) current = null;
      }
      App.showGoalSetup(cat.id);
      App.showToast(`"${cat.name}" added. Set a goal for it, or just start tracking.`);
    });
  }

  function addTag(input) {
    const value = input.value.trim();
    input.value = '';
    if (!value || current.tags.includes(value)) return;
    current.tags.push(value);
    renderTags();
    scheduleSave();
  }

  // ── Event delegation ─────────────────────────────────────────────────────

  function bindControls() {
    document.getElementById('btnAddNote')?.addEventListener('click', newNote);

    document.getElementById('notesSearch')?.addEventListener('input', e => {
      query = e.target.value;
      renderList();
    });

    document.getElementById('notesList')?.addEventListener('click', e => {
      const item = e.target.closest('[data-open-note]');
      if (item) openNote(item.dataset.openNote);
    });

    const editor = document.getElementById('notesEditor');
    if (!editor) return;

    editor.addEventListener('click', e => {
      if (e.target.closest('[data-new-note]')) { newNote(); return; }
      if (e.target.closest('[data-delete-note]')) { deleteCurrent(); return; }
      if (e.target.closest('[data-promote]')) { promoteCurrent(); return; }

      const swatch = e.target.closest('[data-color]');
      if (swatch) {
        current.color = swatch.dataset.color;
        editor.querySelectorAll('.note-swatch').forEach(s => s.classList.toggle('is-active', s === swatch));
        scheduleSave();
        return;
      }

      const removeTag = e.target.closest('[data-remove-tag]');
      if (removeTag) {
        current.tags.splice(parseInt(removeTag.dataset.removeTag), 1);
        renderTags();
        scheduleSave();
      }
    });

    editor.addEventListener('input', e => {
      if (e.target.id === 'noteTitle') { current.title = e.target.value; scheduleSave(); }
      if (e.target.id === 'noteBody')  { current.body  = e.target.value; scheduleSave(); }
    });

    editor.addEventListener('keydown', e => {
      if (e.target.id === 'noteTitle' && e.key === 'Enter') {
        e.preventDefault();
        document.getElementById('noteBody')?.focus();
      }
      if (e.target.id === 'noteTagInput') {
        if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addTag(e.target); }
        if (e.key === 'Backspace' && !e.target.value && current.tags.length) {
          current.tags.pop();
          renderTags();
          scheduleSave();
        }
      }
    });

    editor.addEventListener('focusout', e => {
      if (e.target.id === 'noteTagInput') addTag(e.target);
      else if (saveTimer) flushSave();
    });
  }

  async function refresh() {
    try {
      await saveChain;
      const data = await API.notes.list();

      // Clears out empty notes that older versions created as soon as you pressed New Note
      data.notes.filter(n => isBlank(n) && n.id !== current?.id).forEach(n => {
        API.notes.delete(n.id).catch(err => console.error('Failed to delete note:', err));
      });
      notes = data.notes.filter(n => !isBlank(n) || n.id === current?.id);

      if (current?.id && !notes.some(n => n.id === current.id)) current = null;
      const editingDraft = current && !current.id;
      if (!current && !editingDraft) selectFirst();

      renderList();
      renderEditor();
    } catch (err) { console.error('Failed to load notes:', err); }
  }

  async function init() {
    bindControls();
    await refresh();
  }

  return { init, refresh };
})();

const DEFAULT_PROMPT = 'ugc-script-writer';
const HIDDEN_PROMPTS = new Set(['brain-capture']);

const state = {
  initialized: false,
  prompts: [],
  current: '',
  drafts: new Map(),
  saved: new Map(),
  loading: false,
  saving: false,
};

let editor = null;
let picker = null;
let composer = null;
let saveButton = null;
let statusLine = null;
let pathLine = null;
let titleLine = null;
let backButton = null;
let uploadButton = null;
let fileInput = null;
let toolbar = null;

function apiUrls(promptPath = '') {
  const suffix = promptPath ? `/${encodeURIComponent(promptPath)}` : '';

  return [`/api/prompts${suffix}`, `http://127.0.0.1:8787/api/prompts${suffix}`];
}

function setStatus(message, kind = '') {
  statusLine.textContent = message || '';
  statusLine.className = kind ? `prompt-status is-${kind}` : 'prompt-status';
}

function isDirty(name = state.current) {
  return state.drafts.has(name) && state.drafts.get(name) !== state.saved.get(name);
}

function promptByName(name) {
  return state.prompts.find((prompt) => prompt.name === name) || null;
}

function refreshSaveState() {
  const dirty = isDirty();

  saveButton.disabled = state.loading || state.saving || !dirty;

  if (state.loading || state.saving) {
    return;
  }

  setStatus(dirty ? 'Unsaved changes' : '');
}

async function requestPrompts(promptPath, options) {
  for (const url of apiUrls(promptPath)) {
    try {
      const response = await fetch(url, options);
      const contentType = response.headers.get('content-type') || '';
      const data = contentType.includes('application/json') ? await response.json() : {};

      if (response.ok && contentType.includes('application/json')) {
        return data;
      }

      if (response.ok) {
        throw new Error('The prompt server needs to be restarted before this action can be used.');
      }

      throw new Error(data.error || 'Request failed.');
    } catch (error) {
      if (error instanceof TypeError) {
        continue;
      }

      throw error;
    }
  }

  throw new Error('The prompt server is not reachable.');
}

/**
 * Card grid: one box per prompt file, so a new .txt shows up without a code change.
 *
 * The card is a div, not a button, because it contains its own action buttons and nesting buttons
 * is invalid -- keyboard support is wired explicitly instead.
 */
function renderPicker() {
  picker.innerHTML = '';

  for (const prompt of state.prompts.filter((entry) => !HIDDEN_PROMPTS.has(entry.name))) {
    const card = document.createElement('div');

    card.className = 'prompt-card';
    card.dataset.promptName = prompt.name;
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.addEventListener('keydown', (event) => {
      if (event.target !== card) {
        return;
      }

      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        void openPrompt(prompt.name);
      }
    });

    const title = document.createElement('strong');

    title.textContent = prompt.title || prompt.name;
    card.append(title);

    if (prompt.summary) {
      const summary = document.createElement('p');

      summary.className = 'prompt-card-summary';
      summary.textContent = prompt.summary;
      card.append(summary);
    }

    const meta = document.createElement('small');

    meta.className = 'prompt-card-meta';
    meta.textContent = [
      `${prompt.name}.txt`,
      prompt.lines ? `${prompt.lines} lines` : '',
      isDirty(prompt.name) ? 'unsaved changes' : '',
    ].filter(Boolean).join('  ·  ');
    card.append(meta);

    if (isDirty(prompt.name)) {
      card.classList.add('is-dirty');
    }

    if (prompt.required) {
      const locked = document.createElement('small');

      locked.className = 'prompt-card-locked';
      locked.textContent = 'Used by the pipeline';
      card.append(locked);
    }

    // Every prompt can be renamed or removed. Pipeline prompts get an extra warning before either
    // action because their current file names are referenced directly by the app.
    card.append(promptControls(prompt));

    card.addEventListener('click', () => void openPrompt(prompt.name));
    picker.append(card);
  }
}

function confirmPipelineChange(prompt, action) {
  if (!prompt.required) {
    return true;
  }

  return window.confirm(
    `${prompt.title || prompt.name} is currently used by the pipeline. `
      + `${action} it may stop that feature from working. Continue?`,
  );
}

function promptControls(prompt) {
  const wrap = document.createElement('div');

  wrap.className = 'prompt-card-actions';
  wrap.addEventListener('click', (event) => event.stopPropagation());

  const renameButton = document.createElement('button');

  renameButton.type = 'button';
  renameButton.className = 'prompt-card-rename';
  renameButton.textContent = 'Rename';
  wrap.append(renameButton);

  const removeButton = document.createElement('button');

  removeButton.type = 'button';
  removeButton.className = 'prompt-card-remove';
  removeButton.textContent = 'Remove';
  wrap.append(removeButton);

  const renameForm = document.createElement('form');
  const renameInput = document.createElement('input');
  const renameSave = document.createElement('button');
  const renameCancel = document.createElement('button');

  renameForm.className = 'prompt-rename-form';
  renameForm.hidden = true;
  renameInput.className = 'prompt-rename-input';
  renameInput.type = 'text';
  renameInput.value = prompt.name;
  renameInput.setAttribute('aria-label', `New file name for ${prompt.title || prompt.name}`);
  renameSave.type = 'submit';
  renameSave.className = 'prompt-card-rename-save';
  renameSave.textContent = 'Save name';
  renameCancel.type = 'button';
  renameCancel.className = 'prompt-card-rename-cancel';
  renameCancel.textContent = 'Cancel';
  renameForm.append(renameInput, renameSave, renameCancel);
  wrap.append(renameForm);

  function closeRename() {
    renameForm.hidden = true;
    renameButton.hidden = false;
    removeButton.hidden = false;
    renameInput.value = prompt.name;
  }

  renameButton.addEventListener('click', () => {
    renameButton.hidden = true;
    removeButton.hidden = true;
    renameForm.hidden = false;
    renameInput.focus();
    renameInput.select();
  });

  renameCancel.addEventListener('click', closeRename);
  renameForm.addEventListener('submit', async (event) => {
    event.preventDefault();

    const name = renameInput.value.trim().replace(/\.txt$/i, '');

    if (!name || name === '.' || name === '..' || !/^[\w.-]+$/.test(name)) {
      pathLine.textContent = 'Use only letters, numbers, dots, dashes, or underscores in the file name.';
      renameInput.focus();
      return;
    }

    if (name === prompt.name) {
      pathLine.textContent = `${prompt.name}.txt already has that name.`;
      closeRename();
      return;
    }

    if (promptByName(name)) {
      pathLine.textContent = `${name}.txt already exists.`;
      renameInput.focus();
      return;
    }

    if (!confirmPipelineChange(prompt, 'Renaming')) {
      return;
    }

    renameInput.disabled = true;
    renameSave.disabled = true;
    renameCancel.disabled = true;
    renameSave.textContent = 'Renaming...';

    try {
      const data = await requestPrompts(prompt.name, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });

      if (state.drafts.has(prompt.name)) {
        state.drafts.set(data.name, state.drafts.get(prompt.name));
        state.drafts.delete(prompt.name);
      }

      if (state.saved.has(prompt.name)) {
        state.saved.set(data.name, state.saved.get(prompt.name));
        state.saved.delete(prompt.name);
      }

      await loadPromptList();
      showPicker();
      pathLine.textContent = data.pushError
        ? `Renamed ${prompt.name}.txt to ${data.name}.txt, but the push failed: ${data.pushError}`
        : `Renamed ${prompt.name}.txt to ${data.name}.txt${data.pushed ? ` and pushed to ${data.branch}` : ''}`;
    } catch (error) {
      renameInput.disabled = false;
      renameSave.disabled = false;
      renameCancel.disabled = false;
      renameSave.textContent = 'Save name';
      pathLine.textContent = error.message;
    }
  });

  let armed = false;

  removeButton.addEventListener('click', async (event) => {
    // Never let the click fall through to the card and open the editor.
    event.stopPropagation();

    if (!armed) {
      armed = true;
      removeButton.textContent = 'Click again to delete + push';
      removeButton.classList.add('is-armed');
      return;
    }

    if (!confirmPipelineChange(prompt, 'Removing')) {
      removeButton.textContent = 'Remove';
      removeButton.classList.remove('is-armed');
      armed = false;
      return;
    }

    renameButton.disabled = true;
    removeButton.disabled = true;
    removeButton.textContent = 'Removing...';

    try {
      const response = await fetch(`/api/prompts/${encodeURIComponent(prompt.name)}`, {
        method: 'DELETE',
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Remove failed.');
      }

      state.drafts.delete(prompt.name);
      state.saved.delete(prompt.name);
      await loadPromptList();
      showPicker();
      pathLine.textContent = data.pushError
        ? `Removed ${prompt.name}, but the push failed: ${data.pushError}`
        : `Removed ${prompt.name}${data.pushed ? ` and pushed to ${data.branch}` : ''}`;
    } catch (error) {
      renameButton.disabled = false;
      removeButton.disabled = false;
      removeButton.textContent = 'Remove';
      removeButton.classList.remove('is-armed');
      armed = false;
      pathLine.textContent = error.message;
    }
  });
  return wrap;
}

/** Upload reuses the same write+push path as Save; the file is read in the browser. */
async function uploadPromptFile(file) {
  const rawName = file.name.replace(/\.[^.]+$/, '');
  const name = rawName.trim().toLowerCase().replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '');

  if (!name) {
    pathLine.textContent = 'That filename has no usable characters.';
    return;
  }

  if (promptByName(name) && !window.confirm(`${name} already exists. Overwrite it?`)) {
    return;
  }

  pathLine.textContent = `Uploading ${name}...`;

  try {
    const text = await file.text();
    const data = await requestPrompts(name, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });

    state.drafts.delete(name);
    state.saved.delete(name);
    await loadPromptList();
    showPicker();
    pathLine.textContent = data.pushError
      ? `Uploaded ${name}, but the push failed: ${data.pushError}`
      : `Uploaded ${name}${data.pushed ? ` and pushed to ${data.branch}` : ''}`;
  } catch (error) {
    pathLine.textContent = error.message;
  }
}

function showPicker() {
  state.current = '';
  picker.hidden = false;
  editor.hidden = true;
  composer.hidden = true;
  backButton.hidden = true;

  if (toolbar) {
    toolbar.hidden = false;
  }

  titleLine.textContent = 'Script Writer';

  const dirtyCount = state.prompts
    .filter((prompt) => !HIDDEN_PROMPTS.has(prompt.name) && isDirty(prompt.name)).length;

  pathLine.textContent = dirtyCount
    ? `${dirtyCount} file${dirtyCount > 1 ? 's' : ''} with unsaved changes`
    : 'Pick a writer to open its prompt';
  renderPicker();
}

async function openPrompt(name) {
  const prompt = promptByName(name);

  state.current = name;
  picker.hidden = true;
  editor.hidden = false;
  composer.hidden = false;
  backButton.hidden = false;

  if (toolbar) {
    toolbar.hidden = true;
  }

  titleLine.textContent = prompt?.title || name;
  pathLine.textContent = prompt?.path || 'storage/prompts';

  if (state.drafts.has(name)) {
    editor.value = state.drafts.get(name);
    refreshSaveState();
    return;
  }

  state.loading = true;
  editor.value = '';
  editor.disabled = true;
  saveButton.disabled = true;
  setStatus('Loading...');

  try {
    const data = await requestPrompts(name);

    if (state.current !== name) {
      return;
    }

    state.saved.set(name, data.text);
    state.drafts.set(name, data.text);
    editor.value = data.text;
  } catch (error) {
    if (state.current === name) {
      setStatus(error.message, 'error');
    }
  } finally {
    if (state.current === name) {
      state.loading = false;
      editor.disabled = false;

      if (state.drafts.has(name)) {
        refreshSaveState();
      }
    }
  }
}

async function savePrompt() {
  const name = state.current;

  if (state.loading || state.saving || !isDirty(name)) {
    return;
  }

  const text = state.drafts.get(name);

  state.saving = true;
  saveButton.disabled = true;
  setStatus('Saving and pushing...');

  try {
    const data = await requestPrompts(name, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });

    state.saved.set(name, text);
    state.saving = false;

    if (state.current !== name) {
      return;
    }

    if (data.pushError) {
      setStatus(`Saved, but the push failed: ${data.pushError}`, 'error');
    } else if (data.pushed) {
      setStatus(`Saved and pushed to ${data.branch}`, 'done');
    } else {
      setStatus(data.reason || 'Saved', 'done');
    }

    saveButton.disabled = true;
  } catch (error) {
    state.saving = false;

    if (state.current === name) {
      setStatus(error.message, 'error');
      refreshSaveState();
    }
  }
}

async function loadPromptList() {
  const data = await requestPrompts();

  state.prompts = Array.isArray(data.prompts) ? data.prompts : [];

  return state.prompts;
}

export async function initScriptWriterWindow() {
  if (state.initialized) {
    return;
  }

  editor = document.querySelector('#prompt-editor');
  picker = document.querySelector('#prompt-picker');
  composer = document.querySelector('#prompt-composer');
  saveButton = document.querySelector('#prompt-save');
  statusLine = document.querySelector('#prompt-status');
  pathLine = document.querySelector('#prompt-path');
  titleLine = document.querySelector('#prompt-title');
  backButton = document.querySelector('#prompt-back');
  uploadButton = document.querySelector('#prompt-upload');
  fileInput = document.querySelector('#prompt-file-input');
  toolbar = document.querySelector('.prompt-toolbar');

  if (!editor || !picker || !composer || !saveButton || !statusLine || !pathLine) {
    return;
  }

  state.initialized = true;

  editor.addEventListener('input', () => {
    if (state.loading) {
      return;
    }

    state.drafts.set(state.current, editor.value);
    refreshSaveState();
  });
  editor.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 's') {
      event.preventDefault();
      void savePrompt();
    }
  });
  saveButton.addEventListener('click', () => void savePrompt());
  backButton.addEventListener('click', showPicker);

  if (uploadButton && fileInput) {
    uploadButton.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      const [file] = fileInput.files || [];

      if (file) {
        void uploadPromptFile(file);
      }

      // Reset so re-picking the same file fires change again.
      fileInput.value = '';
    });
  }

  try {
    await loadPromptList();
  } catch (error) {
    setStatus(error.message, 'error');
    pathLine.textContent = error.message;
    return;
  }

  if (!state.prompts.some((prompt) => !HIDDEN_PROMPTS.has(prompt.name))) {
    pathLine.textContent = 'No prompt files were found in storage/prompts.';
    return;
  }

  // Land on the chooser -- the default prompt is only pre-selected, not auto-opened.
  showPicker();
}

export { DEFAULT_PROMPT };

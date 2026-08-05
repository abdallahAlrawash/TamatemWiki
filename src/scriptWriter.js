const DEFAULT_PROMPT = 'ugc-script-writer';

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

function apiUrls(promptPath = '') {
  const suffix = promptPath ? `/${promptPath}` : '';

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
      const data = await response.json();

      if (response.ok) {
        return data;
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

/** Card grid: one box per prompt file, so a new .txt shows up without a code change. */
function renderPicker() {
  picker.innerHTML = '';

  for (const prompt of state.prompts) {
    const card = document.createElement('button');

    card.type = 'button';
    card.className = 'prompt-card';
    card.dataset.promptName = prompt.name;

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

    card.addEventListener('click', () => void openPrompt(prompt.name));
    picker.append(card);
  }
}

function showPicker() {
  state.current = '';
  picker.hidden = false;
  editor.hidden = true;
  composer.hidden = true;
  backButton.hidden = true;
  titleLine.textContent = 'Script Writer';

  const dirtyCount = state.prompts.filter((prompt) => isDirty(prompt.name)).length;

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

  try {
    await loadPromptList();
  } catch (error) {
    setStatus(error.message, 'error');
    pathLine.textContent = error.message;
    return;
  }

  if (!state.prompts.length) {
    pathLine.textContent = 'No prompt files were found in storage/prompts.';
    return;
  }

  // Land on the chooser -- the default prompt is only pre-selected, not auto-opened.
  showPicker();
}

export { DEFAULT_PROMPT };

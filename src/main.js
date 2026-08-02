import './styles.css';
import './wiki-overrides.css';
import { initBrainWindow } from './brain.js';

const state = {
  activeWindow: 'script',
  games: [],
};

const tabs = [...document.querySelectorAll('[data-window-tab]')];
const panels = [...document.querySelectorAll('[data-window-panel]')];
const promptInput = document.querySelector('#wiki-prompt');
const gameSelect = document.querySelector('#game-select');
const askButton = document.querySelector('#ask-wiki');
const writeButton = document.querySelector('#write-script');
const errorMessage = document.querySelector('#error-message');
const statusBox = document.querySelector('#generation-status');
const statusLog = document.querySelector('#status-log');
const output = document.querySelector('#wiki-output');
const outputTitle = document.querySelector('#wiki-output-title');
const outputMeta = document.querySelector('#wiki-output-meta');
const outputBody = document.querySelector('#wiki-output-body');
const scriptWindow = document.querySelector('#script-window');
const clearOutputButton = document.querySelector('#clear-output');

function setWindow(windowName) {
  state.activeWindow = windowName;

  for (const tab of tabs) {
    tab.classList.toggle('active', tab.dataset.windowTab === windowName);
  }

  for (const panel of panels) {
    panel.hidden = panel.dataset.windowPanel !== windowName;
  }

  if (windowName === 'brain') {
    void initBrainWindow();
  }
}

function showError(message) {
  errorMessage.textContent = message;
  errorMessage.hidden = !message;
}

function setLoading(message, isLoading) {
  statusLog.textContent = message || '';
  statusBox.hidden = !isLoading;
  scriptWindow.classList.toggle('is-working', isLoading);
  askButton.disabled = isLoading;
  writeButton.disabled = isLoading;
}

function setResultVisible(isVisible) {
  output.hidden = !isVisible;
  scriptWindow.classList.toggle('has-result', isVisible);
}

async function requestJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || 'Request failed.');
  }

  return data;
}

function sceneText(scene) {
  return [
    `SC${scene.scene_number || ''} - ${scene.description || 'Scene'}`,
    scene.vo ? `VO: ${scene.vo}` : '',
    scene.action ? `Action: ${scene.action}` : '',
    scene.screen ? `Screen: ${scene.screen}` : '',
  ].filter(Boolean).join('\n');
}

function renderScript(result) {
  const script = result.script || {};
  const scenes = Array.isArray(script.scenes) ? script.scenes : [];
  const sfx = Array.isArray(script.background_sfx) ? script.background_sfx : [];

  outputTitle.textContent = 'Script written';
  outputMeta.textContent = result.model ? `Model: ${result.model}` : '';
  outputBody.innerHTML = '';

  for (const scene of scenes) {
    const block = document.createElement('article');
    block.className = 'wiki-script-scene';
    block.textContent = sceneText(scene);
    outputBody.append(block);
  }

  if (sfx.length) {
    const block = document.createElement('article');
    block.className = 'wiki-script-scene';
    block.textContent = `Background SFX\n${sfx.map((item) => `- ${item}`).join('\n')}`;
    outputBody.append(block);
  }

  setResultVisible(true);
}

function renderAnswer(result) {
  const answer = result.answer || {};

  outputTitle.textContent = answer.title || 'Wiki answer';
  outputMeta.textContent = result.model ? `Model: ${result.model}` : '';
  outputBody.innerHTML = '';

  const answerBlock = document.createElement('article');
  answerBlock.className = 'wiki-answer-block';
  answerBlock.textContent = answer.answer || '';
  outputBody.append(answerBlock);

  if (Array.isArray(answer.used_memory) && answer.used_memory.length) {
    const memoryBlock = document.createElement('article');
    memoryBlock.className = 'wiki-memory-used';
    memoryBlock.innerHTML = '<strong>Memory used</strong>';

    for (const item of answer.used_memory) {
      const line = document.createElement('p');
      line.textContent = `${item.section || 'Memory'} / ${item.group || 'Group'} - ${item.reason || ''}`;
      memoryBlock.append(line);
    }

    outputBody.append(memoryBlock);
  }

  setResultVisible(true);
}

function clearOutput() {
  outputBody.innerHTML = '';
  outputTitle.textContent = 'Wiki answer';
  outputMeta.textContent = '';
  setResultVisible(false);
  showError('');
}

async function loadGames() {
  const response = await fetch('/api/games');
  const data = await response.json();

  state.games = Array.isArray(data.games) ? data.games : [];
  gameSelect.innerHTML = '';

  for (const game of state.games) {
    const option = document.createElement('option');
    option.value = game.id;
    option.textContent = game.name || game.id;
    gameSelect.append(option);
  }

  if (!state.games.length) {
    const option = document.createElement('option');
    option.value = 'VIPBaloot';
    option.textContent = 'VIP Baloot';
    gameSelect.append(option);
  }
}

async function askWiki() {
  const question = promptInput.value.trim();

  showError('');

  if (!question) {
    showError('Write a question first.');
    return;
  }

  setLoading('Searching the wiki...', true);

  try {
    renderAnswer(await requestJson('/api/ask-wiki', {
      gameId: gameSelect.value,
      question,
    }));
  } catch (error) {
    showError(error.message);
  } finally {
    setLoading('', false);
  }
}

async function writeScript() {
  const userBrief = promptInput.value.trim();

  showError('');

  if (!userBrief) {
    showError('Write a script brief first.');
    return;
  }

  setLoading('Writing the script...', true);

  try {
    renderScript(await requestJson('/api/write-script', {
      gameId: gameSelect.value,
      userBrief,
    }));
  } catch (error) {
    showError(error.message);
  } finally {
    setLoading('', false);
  }
}

for (const tab of tabs) {
  tab.addEventListener('click', () => setWindow(tab.dataset.windowTab));
}

askButton.addEventListener('click', askWiki);
writeButton.addEventListener('click', writeScript);
clearOutputButton.addEventListener('click', clearOutput);
promptInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    writeScript();
  }
});

await loadGames();

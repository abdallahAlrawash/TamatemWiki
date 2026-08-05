import { execFile } from 'node:child_process';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const runCommand = promisify(execFile);
const promptsDir = path.join('storage', 'prompts');
const defaultPromptName = 'ugc-script-writer';

export function getPromptPath(name) {
  const safeName = path.basename(String(name || '')).replace(/[^\w.-]+/g, '');

  if (!safeName) {
    throw new Error('Prompt name is missing.');
  }

  return path.join(promptsDir, `${safeName}.txt`);
}

// Acronyms that should not be title-cased into "Ugc".
const acronyms = new Set(['ugc', 'ai', 'vo', 'sfx', 'cta', 'ui']);

function titleFor(name) {
  return name
    .split(/[-_]/)
    .filter(Boolean)
    .map((word) => (acronyms.has(word.toLowerCase())
      ? word.toUpperCase()
      : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(' ');
}

/** First meaningful line of the prompt, so a card can say what the prompt is for. */
function summaryOf(text) {
  const line = text
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry && !entry.startsWith('#') && !entry.startsWith('-'));

  if (!line) {
    return '';
  }

  return line.length > 150 ? `${line.slice(0, 149)}…` : line;
}

export async function listPrompts({ cwd = process.cwd() } = {}) {
  let entries = [];

  try {
    entries = await readdir(path.resolve(cwd, promptsDir));
  } catch {
    return [];
  }

  const names = entries
    .filter((entry) => entry.endsWith('.txt'))
    .map((entry) => entry.slice(0, -'.txt'.length))
    .sort((first, second) => {
      if (first === defaultPromptName) {
        return -1;
      }

      if (second === defaultPromptName) {
        return 1;
      }

      return first.localeCompare(second);
    });

  return Promise.all(names.map(async (name) => {
    const relativePath = `${promptsDir.split(path.sep).join('/')}/${name}.txt`;
    let text = '';

    try {
      text = await readFile(path.resolve(cwd, relativePath), 'utf8');
    } catch {
      // listed but unreadable -- still show the card, just without a summary
    }

    return {
      name,
      path: relativePath,
      title: titleFor(name),
      summary: summaryOf(text),
      lines: text ? text.split(/\r?\n/).length : 0,
      characters: text.length,
    };
  }));
}

export async function readPrompt(name, { cwd = process.cwd() } = {}) {
  const promptPath = getPromptPath(name);

  try {
    return {
      name,
      path: promptPath.split(path.sep).join('/'),
      text: await readFile(path.resolve(cwd, promptPath), 'utf8'),
    };
  } catch {
    throw new Error(`Prompt ${name} was not found.`);
  }
}

async function git(args, cwd) {
  const { stdout } = await runCommand('git', args, {
    cwd,
    timeout: 60000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });

  return stdout.trim();
}

async function pushPrompt(promptPath, cwd) {
  const status = await git(['status', '--porcelain', '--', promptPath], cwd);

  if (!status) {
    return { pushed: false, reason: 'The prompt already matches the last commit.' };
  }

  await git(['add', '--', promptPath], cwd);
  await git(['commit', '-m', `Update ${path.basename(promptPath, '.txt')} prompt`], cwd);

  const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);

  await git(['push', 'origin', branch], cwd);

  return { pushed: true, branch };
}

export async function writePrompt(name, text, { cwd = process.cwd() } = {}) {
  const promptPath = getPromptPath(name);

  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('The prompt cannot be empty.');
  }

  await writeFile(path.resolve(cwd, promptPath), text.replace(/\r\n/g, '\n'), 'utf8');

  const result = {
    name,
    path: promptPath.split(path.sep).join('/'),
    saved: true,
    pushed: false,
  };

  try {
    Object.assign(result, await pushPrompt(promptPath, cwd));
  } catch (error) {
    result.pushError = error.stderr ? String(error.stderr).trim() : error.message;
  }

  return result;
}

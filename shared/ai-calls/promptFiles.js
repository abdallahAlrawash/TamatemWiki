import { execFile } from 'node:child_process';
import { access, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const runCommand = promisify(execFile);
const promptsDir = path.join('storage', 'prompts');
const defaultPromptName = 'ugc-script-writer';

// Prompts the pipeline reads by hardcoded path. The UI marks these and warns before renaming or
// deleting them, but still allows the user to manage every prompt file.
//   ugc-script-writer -> ugcScriptWriter.js
//   brain-capture     -> brainCapture.js
//   Story-Telling-Script-Writer -> storytellingScriptWriter.js
//   Script-Router     -> scriptRouter.js
const requiredPrompts = new Set([
  'ugc-script-writer',
  'brain-capture',
  'Story-Telling-Script-Writer',
  'Script-Router',
]);

export function isRequiredPrompt(name) {
  return requiredPrompts.has(name);
}

function getRenameTarget(name) {
  const requested = path.basename(String(name || '')).replace(/\.txt$/i, '');

  if (!requested || requested === '.' || requested === '..' || !/^[\w.-]+$/.test(requested)) {
    throw new Error('Use only letters, numbers, dots, dashes, or underscores in the file name.');
  }

  return {
    name: requested,
    path: path.join(promptsDir, `${requested}.txt`),
  };
}

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
      required: requiredPrompts.has(name),
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

async function pushPrompt(promptPath, cwd, verb = 'Update') {
  const status = await git(['status', '--porcelain', '--', promptPath], cwd);

  if (!status) {
    return { pushed: false, reason: 'The prompt already matches the last commit.' };
  }

  // --all so a deletion stages too, not just a modification.
  await git(['add', '--all', '--', promptPath], cwd);
  await git(['commit', '-m', `${verb} ${path.basename(promptPath, '.txt')} prompt`], cwd);

  const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);

  await git(['push', 'origin', branch], cwd);

  return { pushed: true, branch };
}

async function pushPromptRename(oldPath, newPath, cwd) {
  const paths = [oldPath, newPath];
  const status = await git(['status', '--porcelain', '--', ...paths], cwd);

  if (!status) {
    return { pushed: false, reason: 'The file name already matches the last commit.' };
  }

  await git(['add', '--all', '--', ...paths], cwd);
  await git([
    'commit',
    '-m',
    `Rename ${path.basename(oldPath, '.txt')} prompt to ${path.basename(newPath, '.txt')}`,
  ], cwd);

  const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);

  await git(['push', 'origin', branch], cwd);

  return { pushed: true, branch };
}

export async function deletePrompt(name, { cwd = process.cwd() } = {}) {
  const promptPath = getPromptPath(name);
  const safeName = path.basename(promptPath, '.txt');

  try {
    await rm(path.resolve(cwd, promptPath));
  } catch {
    throw new Error(`Prompt ${name} was not found.`);
  }

  const result = {
    name: safeName,
    path: promptPath.split(path.sep).join('/'),
    deleted: true,
    pushed: false,
  };

  try {
    Object.assign(result, await pushPrompt(promptPath, cwd, 'Remove'));
  } catch (error) {
    result.pushError = error.stderr ? String(error.stderr).trim() : error.message;
  }

  return result;
}

export async function renamePrompt(name, newName, { cwd = process.cwd() } = {}) {
  const oldPath = getPromptPath(name);
  const oldName = path.basename(oldPath, '.txt');
  const target = getRenameTarget(newName);

  if (oldPath === target.path) {
    return {
      name: oldName,
      oldName,
      path: oldPath.split(path.sep).join('/'),
      renamed: false,
      pushed: false,
      reason: 'The file already has that name.',
    };
  }

  try {
    await access(path.resolve(cwd, oldPath));
  } catch {
    throw new Error(`Prompt ${name} was not found.`);
  }

  try {
    await access(path.resolve(cwd, target.path));
    throw new Error(`A prompt named ${target.name} already exists.`);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  }

  await rename(path.resolve(cwd, oldPath), path.resolve(cwd, target.path));

  const result = {
    name: target.name,
    oldName,
    path: target.path.split(path.sep).join('/'),
    renamed: true,
    pushed: false,
  };

  try {
    Object.assign(result, await pushPromptRename(oldPath, target.path, cwd));
  } catch (error) {
    result.pushError = error.stderr ? String(error.stderr).trim() : error.message;
  }

  return result;
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

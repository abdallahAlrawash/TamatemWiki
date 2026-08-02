import { mkdir } from 'node:fs/promises';
import path from 'node:path';

export function createRunId(date = new Date()) {
  return `run-${date.toISOString().replace(/[:.]/g, '-')}`;
}

export function getRunOutputDir(runId) {
  return path.join('storage', 'outputs', runId);
}

export async function ensureRunOutputDir(runId = createRunId()) {
  const outputDir = getRunOutputDir(runId);

  await mkdir(outputDir, { recursive: true });

  return {
    outputDir,
    runId,
  };
}

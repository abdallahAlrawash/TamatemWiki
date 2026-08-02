import { readFile } from 'node:fs/promises';
import path from 'node:path';

const registryPath = path.join('library', 'games', 'games.json');

export async function listGames() {
  try {
    const games = JSON.parse(await readFile(registryPath, 'utf8'));

    return Array.isArray(games) ? games : [];
  } catch {
    return [];
  }
}

export async function getGame(gameId) {
  const games = await listGames();

  return games.find((game) => game.id === gameId) || null;
}

export async function getPhoneOrientation(gameId) {
  const game = await getGame(gameId);

  return game?.phoneOrientation === 'horizontal' ? 'horizontal' : 'vertical';
}

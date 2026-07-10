import type { Project, RuntimeState, MemoryState } from './types';
import { uid } from './utils';

export function createEmptyProject(title = 'Новый проект'): Project {
  const now = Date.now();
  return {
    id: uid('proj'),
    createdAt: now,
    updatedAt: now,
    meta: {
      title,
      author: '',
      genre: 'романтика',
      description: '',
      contentRating: 'sfw',
    },
    lore: {
      worldDescription: '',
      plotOutline: '',
      openingScene: '',
      narrativeRules: 'Повествование от 2-го лица. Не принимай решений за игрока.',
    },
    lorebook: [],
    characters: [],
    stats: [],
    assets: [],
    aiConfig: {
      provider: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      temperature: 0.9,
      maxContextMessages: 12,
      contextBudget: 8000,
      liveWindow: 12,
    },
  };
}

export function initialMemory(): MemoryState {
  return { chronicle: [], currentChapterSummary: '', chapter: 1, facts: [] };
}

export function initialRuntimeState(project: Project): RuntimeState {
  const statValues: Record<string, number> = {};
  for (const s of project.stats) statValues[s.id] = s.initial;
  return {
    statValues,
    currentBackgroundId: null,
    currentMusicId: null,
    onScreen: [],
    history: [],
    memory: initialMemory(),
    lastTurn: null,
    turnCount: 0,
  };
}

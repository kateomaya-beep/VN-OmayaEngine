import type { LlmMessage, Project, RuntimeState } from '../shared/types';
import { defaultImageGenConfig, normalizeNarrativeMode } from '../shared/types';
import { composeCgPrompt } from './imagePrompt';
import { renderImage } from './imageCast';
import { resolvePerson, type Person } from './characterRegistry';
import { ILLUSTRATION_RE, stripStateBlock } from './rpResponse';

// ИЛЛЮСТРАЦИИ В ТЕКСТОВОМ РП.
//
// Решает рассказчик, а не таймер: когда в ответе есть по-настоящему зрелищный
// момент, модель ставит на его место метку <illustration>что в кадре</illustration>.
// Движок рисует её тем же путём, что CG-студия (воркер → стиль проекта → внешность
// и референсы людей в кадре), и картинка встаёт в ответ ровно туда, где метка.
//
// Ограничитель — «не чаще раза в N ходов»: пока срок не вышел, модель о
// иллюстрациях даже не слышит, а случайные метки движок не рисует. В ответе
// рисуется только первая метка.
//
// Картинки хранятся в проекте по ключу метки (а не при сообщении): свайп,
// откат и правка пересобирают сообщение, и картинка, привязанная к нему, терялась
// бы — а с ней и деньги за генерацию.

export interface IllustrateConfig {
  enabled: boolean;
  minGap: number;
}

export const DEFAULT_ILLUSTRATE: IllustrateConfig = { enabled: false, minGap: 3 };

/** Режим включён у проекта (и проект — текстовый РП). */
export function illustrateConfig(project: Project): IllustrateConfig | null {
  const cfg = project.imageGen?.illustrate;
  return cfg?.enabled && normalizeNarrativeMode(project.mode) === 'rp' ? cfg : null;
}

/** Подписи меток в тексте, по порядку. */
export function illustrationMarks(text: string): string[] {
  return [...(text || '').matchAll(ILLUSTRATION_RE)].map((m) => m[1].trim()).filter(Boolean);
}

/** Ключ метки: по нему лежит картинка. Пробелы и регистр не важны. */
export function illustrationKey(caption: string): string {
  const t = caption.replace(/\s+/g, ' ').trim().toLowerCase();
  let h = 5381;
  for (let i = 0; i < t.length; i++) h = ((h << 5) + h + t.charCodeAt(i)) >>> 0;
  return `il_${h.toString(36)}_${t.length}`;
}

/** Сколько ответов модели прошло после последнего с нарисованной иллюстрацией. */
export function turnsSinceIllustration(project: Project, history: LlmMessage[]): number {
  const map = project.imageGen?.illustrations || {};
  let n = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role !== 'assistant') continue;
    if (illustrationMarks(m.content).some((c) => map[illustrationKey(c)])) return n;
    n++;
  }
  return Infinity;
}

/** Можно ли в СЛЕДУЮЩЕМ ответе ставить иллюстрацию (history — до этого ответа). */
export function illustrationDue(project: Project, history: LlmMessage[]): boolean {
  const cfg = illustrateConfig(project);
  if (!cfg) return false;
  return turnsSinceIllustration(project, history) + 1 >= cfg.minGap;
}

/** Инструкция рассказчику — в хвост хода, только когда срок вышел. */
export function illustrationDirective(): string {
  return (
    'ILLUSTRATION (optional, at most ONE in this reply): if this reply contains a truly striking, visual moment — ' +
    'a reveal, a first meeting, a confession, a kiss, a fight, a breathtaking place, a turning point — mark it for an illustration. ' +
    'Put the mark on its own line right after the paragraph it shows:\n' +
    '<illustration>what the frame shows: who, doing what, where; light and mood. One sentence, in the story language.</illustration>\n' +
    'Skip it when nothing in this reply is visually remarkable — an ordinary beat is better without a picture. ' +
    'The mark is engine markup: never mention or refer to it in the story.'
  );
}

/**
 * Кто рядом с героем сейчас. В новелле — спрайты на сцене; в РП спрайтов нет, и
 * источник — Game Master: те, кого сводка этого хода назвала присутствующими,
 * иначе все, кто в той же локации.
 */
export function scenePeople(project: Project, state: RuntimeState): Person[] {
  const out: Person[] = [];
  const push = (p: Person | null) => {
    if (p && !out.some((x) => x.id === p.id)) out.push(p);
  };
  if (normalizeNarrativeMode(project.mode) !== 'rp') {
    for (const o of state.onScreen) push(resolvePerson(project, state, { id: o.characterId }));
    return out;
  }
  const gm = state.gm?.characters || [];
  const now = gm.filter((c) => c.updatedAtTurn === state.turnCount);
  const loc = state.gm?.clock?.location?.trim().toLowerCase();
  const here = now.length ? now : loc ? gm.filter((c) => c.location?.trim().toLowerCase() === loc) : [];
  for (const c of here.slice(0, 6)) push(resolvePerson(project, state, { id: c.charId || undefined, name: c.name }));
  return out;
}

export interface DrawnIllustration {
  blob: Blob;
  prompt: string;
}

/**
 * Рисует момент. prompt задан — рисуем по нему (правка в карточке), без воркера;
 * нет — воркер CG-студии собирает его из метки, текста хода и людей рядом.
 */
export async function drawIllustration(
  project: Project,
  state: RuntimeState,
  caption: string,
  opts: { prompt?: string; signal?: AbortSignal } = {}
): Promise<DrawnIllustration> {
  const ig = project.imageGen ?? defaultImageGenConfig();
  const people = scenePeople(project, state);
  const lastStory = [...state.history].reverse().find((m) => m.role === 'assistant');
  let prompt = opts.prompt?.trim() || '';
  let aspect = ig.aspectRatio === 'auto' || !ig.aspectRatio ? undefined : ig.aspectRatio;
  let cast: Person[] = people;
  if (!prompt) {
    const res = await composeCgPrompt(project, state, ig.systemPrompt, {
      people,
      moment: caption,
      recent: lastStory ? stripStateBlock(lastStory.content) : undefined,
    });
    prompt = res.prompt;
    if (!aspect) aspect = res.aspectRatio;
    if (res.cast) cast = res.cast.map((name) => resolvePerson(project, state, { name })).filter((x): x is Person => !!x);
  }
  if (opts.signal?.aborted) throw new Error('Отменено');
  const { blob } = await renderImage(project, state, {
    prompt,
    cast,
    scanText: opts.prompt ? prompt : undefined,
    withOutfit: true,
    // В ленте переписки горизонтальный кадр читается лучше всего.
    aspectRatio: aspect || '3:2',
    signal: opts.signal,
  });
  return { blob, prompt };
}

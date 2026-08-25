import type { AiTurn, RuntimeState, WorldStateUpdate } from '../shared/types';
import { worldStateSchema } from './schema';
import { extractThinking } from './responseParser';
import { RP_STATE_CLOSE, RP_STATE_OPEN } from './rpPreset';
import { logEvent } from '../shared/logStore';

// РАЗБОР ОТВЕТА В РЕЖИМЕ ТЕКСТОВОГО РП.
//
// В новелле ответ — один JSON-объект по схеме, и «не разобрался» значит «ход
// потерян». Здесь наоборот: разбирать почти нечего, ответ И ЕСТЬ текст истории.
// Единственное, что вырезается, — служебный блок <state> со сводкой мира: он
// нужен движку (память, досье, часы), но игроку его показывать незачем.
//
// Принцип, отличающий этот путь от новеллы: НИЧТО ЗДЕСЬ НЕ МОЖЕТ УРОНИТЬ ХОД.
// Кривой JSON в <state> — сводка просто не применяется, а проза доезжает целиком.

// Тег состояния может приехать обёрнутым в markdown-заборчик (```json … ```) —
// модели любят так делать, и без этого блок не парсился бы ни разу.
const STATE_RE = new RegExp(
  `${RP_STATE_OPEN}\\s*(?:\`\`\`(?:json)?\\s*)?([\\s\\S]*?)(?:\\s*\`\`\`)?\\s*${RP_STATE_CLOSE}`,
  'i'
);

export interface RpResponse {
  /** Текст истории — то, что видит игрок. */
  prose: string;
  /** Сводка мира из <state>, если она была и разобралась. */
  worldState?: WorldStateUpdate;
  /** План из <thinking>, если было управляемое размышление. */
  plan: string;
}

// Убирает служебный блок состояния из текста. Используется и при показе, и при
// сборке контекста: пересылать модели её собственную сводку в истории незачем —
// актуальная версия и так приезжает динамическим блоком Game Master.
export function stripStateBlock(raw: string): string {
  return raw.replace(STATE_RE, '').trim();
}

// Хвост ответа, в котором модель начала писать за игрока. Стоп-строки провайдера
// ловят это на генерации, но не все шлюзы их поддерживают, поэтому подстраховываемся
// и на разборе: всё начиная со строки «Имя героя:» отрезается.
export function trimImpersonation(prose: string, userName: string): string {
  const name = userName.trim();
  if (!name) return prose;
  const re = new RegExp(`\\n\\s*(?:\\*\\*|__|\\*)?${escapeRe(name)}(?:\\*\\*|__|\\*)?\\s*:`, 'i');
  const at = prose.search(re);
  if (at === -1) return prose;
  const cut = prose.slice(0, at).trim();
  // Обрезать ВЕСЬ ответ нельзя: если модель начала прямо с реплики героя, лучше
  // отдать как есть и дать игроку удалить сообщение, чем показать пустой экран.
  if (!cut) return prose;
  logEvent('warn', 'turn', 'Модель начала писать за игрока — хвост ответа обрезан');
  return cut;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Текст для показа ПОКА ОТВЕТ ЕЩЁ ИДЁТ. Отличается от разбора готового ответа
// тем, что теги здесь заведомо недописаны: <thinking> ещё не закрыт, <state> начат
// на середине. Показывать игроку служебные потроха нельзя ни секунды, поэтому всё
// от незакрытого тега и до конца просто отрезается.
export function streamingProse(raw: string): string {
  let t = raw.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '');
  // Незакрытая думалка — значит текста истории ещё нет вовсе.
  if (/<think(?:ing)?>/i.test(t)) return '';
  t = t.replace(STATE_RE, '');
  // Сводка началась — история на этом закончилась, дальше только служебное.
  const at = t.search(new RegExp(RP_STATE_OPEN.replace(/[<>]/g, (c) => '\\' + c), 'i'));
  if (at !== -1) t = t.slice(0, at);
  // Хвост вида «<sta» — начало тега, приехавшее по кусочкам.
  t = t.replace(/<[a-z]*$/i, '');
  return t.trimStart();
}

export function parseRpResponse(raw: string, opts?: { userName?: string; guard?: boolean }): RpResponse {
  const plan = extractThinking(raw);
  // Блок размышления вырезаем тем же способом, что и в новелле, чтобы план не
  // оказался в тексте истории. Тег может быть и <think> (так его называют часть
  // reasoning-моделей), и <thinking> (так его открывает наш префилл).
  let body = raw.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '').trim();
  // Незакрытый тег (обрыв по лимиту токенов) — режем всё до конца ответа: показать
  // игроку сырой план хуже, чем показать пустой ход и переспросить.
  body = body.replace(/^<think(?:ing)?>[\s\S]*$/i, '').trim();

  let worldState: WorldStateUpdate | undefined;
  const m = STATE_RE.exec(body);
  if (m) {
    const parsed = safeParseState(m[1]);
    if (parsed) worldState = parsed;
  }

  let prose = stripStateBlock(body);
  if (opts?.guard !== false) prose = trimImpersonation(prose, opts?.userName || '');

  return { prose, worldState, plan };
}

function safeParseState(text: string): WorldStateUpdate | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    logEvent('warn', 'turn', 'Служебный блок состояния пришёл невалидным JSON — сводка мира за этот ход не применена');
    return undefined;
  }
  const res = worldStateSchema.safeParse(obj);
  if (!res.success) {
    logEvent('warn', 'turn', 'Служебный блок состояния не по схеме: ' + res.error.issues[0]?.message);
    return undefined;
  }
  return (res.data as WorldStateUpdate) ?? undefined;
}

// Ход в терминах движка: одна narration-бита со всей прозой. Так весь конвейер
// новеллы (applyTurn → история → память → свёртка → Game Master) работает без
// единой правки, а разница между режимами остаётся ровно там, где она есть, —
// в промпте и в показе.
export function rpTurn(state: RuntimeState, prose: string, worldState?: WorldStateUpdate): AiTurn {
  return {
    scene: {
      backgroundId: state.currentBackgroundId,
      musicMood: state.currentMusicMood,
      sfxId: null,
      cutsceneCgId: null,
    },
    beats: prose ? [{ type: 'narration', text: prose }] : [],
    statChanges: [],
    choices: [],
    chapterEvent: null,
    worldState,
  };
}

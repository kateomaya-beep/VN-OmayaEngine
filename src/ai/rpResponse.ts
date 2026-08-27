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

// Убирает префилл из начала текста. Префилл — это НАШИ слова, вписанные в уста
// модели, чтобы она начала ответ нужным образом; провайдер приклеивает их обратно
// к результату, иначе ответ был бы обрезан с головы.
//
// Показывать их игроку нужно не всегда: «затравка» для джейлбрейка — чистая
// техника и в истории смотрится инородно, а вот префилл-стабилизатор формата
// (одинокая «*», открывающая курсив) убирать нельзя — разметка останется
// незакрытой. Отличить одно от другого может только автор, поэтому решает
// настройка, а здесь только механика.
export function dropPrefill(text: string, prefill?: string): string {
  const p = prefill?.trim();
  if (!p) return text;
  const t = text.trimStart();
  return t.startsWith(p) ? t.slice(p.length).trimStart() : text;
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
  // Незакрытая думалка. Обычно это значит, что план ещё пишется и прозы нет, —
  // но не всегда: модель могла забыть закрыть тег и уже писать сцену внутри него.
  // Показываем ту часть, которая перестала быть списком (см. splitUnclosedPlan);
  // пока идут пункты плана, она пуста, и на экране честно ничего.
  const tail = afterUnclosedOpen(t);
  if (tail !== null) {
    const prose = splitUnclosedPlan(tail).prose;
    if (!prose) return '';
    t = prose;
  }
  t = t.replace(STATE_RE, '');
  // Сводка началась — история на этом закончилась, дальше только служебное.
  const at = t.search(new RegExp(RP_STATE_OPEN.replace(/[<>]/g, (c) => '\\' + c), 'i'));
  if (at !== -1) t = t.slice(0, at);
  // Хвост вида «<sta» — начало тега, приехавшее по кусочкам.
  t = t.replace(/<[a-z]*$/i, '');
  return t.trimStart();
}

// НЕЗАКРЫТЫЙ <thinking>. Случай частый и коварный: префилл открывает тег за
// модель, а закрыть его должна она сама — и иногда просто забывает, уезжая писать
// сцену прямо внутри блока. Особенно у моделей, чья родная думалка живёт отдельным
// каналом (Sonnet): наш тег для них лишняя формальность, и они её роняют.
//
// Раньше это стоило игроку ВСЕГО ХОДА: разбор считал незакрытый блок обрывком
// плана и вырезал всё до конца ответа, а показ намертво замирал на «размышляет»,
// хотя готовая сцена уже пришла. Здесь блок делится по единственному надёжному
// признаку: наш шаблон плана — это СПИСОК, каждая строка начинается с маркера.
// Ведущие строки-пункты — план; первая строка без маркера означает, что модель
// перешла к прозе, и всё оттуда — уже сцена.
//
// Если маркеры так и не кончились, прозы нет вовсе — значит ответ и правда
// оборвался на середине плана. Тогда prose пустой, и движок переспросит: это
// ровно то поведение, ради которого вырезание задумывалось.
export function splitUnclosedPlan(body: string): { plan: string; prose: string } {
  const lines = body.split('\n');
  let i = 0;
  for (; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l) continue; // пустая строка внутри плана его не заканчивает
    if (/^([-*•–—]|\d+[.)])\s/.test(l)) continue;
    break;
  }
  return {
    plan: lines.slice(0, i).join('\n').trim(),
    prose: lines.slice(i).join('\n').trim(),
  };
}

// Тело после открывающего <thinking>, если тег так и не закрыт. Пусто — тег либо
// закрыт, либо его нет вовсе.
function afterUnclosedOpen(raw: string): string | null {
  const stripped = raw.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '');
  const open = /<think(?:ing)?>/i.exec(stripped);
  return open ? stripped.slice(open.index + open[0].length) : null;
}

// Текст ДУМАЛКИ по мере набора — то, что модель пишет внутри <thinking>, пока блок
// ещё не закрыт. Нужен ровно для одного: показать, что модель уже работает.
//
// Без него управляемое размышление выглядит как зависание: прозы ещё нет (она
// начнётся только после закрытия блока), думалка не видна — и отличить думающую
// модель от намертво вставшей невозможно. На моделях, которые размышляют минутами,
// это разница между «идёт работа» и «всё сломалось».
export function streamingThinking(raw: string): string {
  const open = /<think(?:ing)?>/i.exec(raw);
  if (!open) return '';
  const after = raw.slice(open.index + open[0].length);
  const close = /<\/think(?:ing)?>/i.exec(after);
  // Хвост вида «</thin» — закрывающий тег, приехавший по кусочкам.
  const body = (close ? after.slice(0, close.index) : after).replace(/<\/?[a-z]*$/i, '');
  // Тег не закрыт — берём только пункты плана. Проза, которую модель написала
  // внутри незакрытого блока, уходит в ответ, а не дублируется в панель.
  return (close ? body : splitUnclosedPlan(body).plan).trim();
}

export function parseRpResponse(
  raw: string,
  opts?: { userName?: string; guard?: boolean; prefill?: string }
): RpResponse {
  let plan = extractThinking(raw);
  // Блок размышления вырезаем тем же способом, что и в новелле, чтобы план не
  // оказался в тексте истории. Тег может быть и <think> (так его называют часть
  // reasoning-моделей), и <thinking> (так его открывает наш префилл).
  let body = raw.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '').trim();
  // Незакрытый тег. Раньше здесь вырезалось ВСЁ до конца ответа — из соображения
  // «сырой план на экране хуже пустого хода». Но чаще случается другое: модель
  // забыла закрыть тег и написала внутри него готовую сцену, и вырезание съедало
  // её целиком. Делим по маркерам списка: пункты плана — в план, остальное — в
  // ответ. Оборвавшийся на середине плана ход по-прежнему даёт пустую прозу, и
  // движок переспросит.
  const tail = afterUnclosedOpen(body);
  if (tail !== null) {
    const split = splitUnclosedPlan(tail);
    if (split.prose) {
      logEvent(
        'warn',
        'turn',
        'Модель не закрыла </thinking> и продолжила сценой внутри блока — ' +
          'план отделён от прозы по разметке списка, ход не потерян.'
      );
    }
    body = split.prose;
    // extractThinking на незакрытом теге отдаёт пустоту — план брать неоткуда,
    // кроме как отсюда. Без этого он бесследно пропадал бы из журнала.
    if (!plan) plan = split.plan;
  }

  let worldState: WorldStateUpdate | undefined;
  const m = STATE_RE.exec(body);
  if (m) {
    const parsed = safeParseState(m[1]);
    if (parsed) worldState = parsed;
  }

  let prose = dropPrefill(stripStateBlock(body), opts?.prefill);
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

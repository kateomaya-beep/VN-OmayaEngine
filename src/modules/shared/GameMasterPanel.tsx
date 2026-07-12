import { useState } from 'react';
import { Modal, Field } from '../../shared/ui';
import { useLang } from '../../shared/i18n';
import { usePlayerStore } from '../player/playerStore';
import { ApiConnectionField } from '../constructor/editors/ApiConnectionField';
import { getConnection } from '../../ai/connection';
import { formatClock } from '../../ai/gameMaster';
import { scanCharacter, scanEvents, scanAgenda } from '../../ai/gmScan';
import { pushToast, updateToast } from '../../shared/toast';
import { uid } from '../../shared/utils';
import { DEFAULT_MONTHS } from '../../shared/types';
import type {
  Project, MemoryConfig, VectorizationMode, GmCharacter, GameMasterState,
} from '../../shared/types';

// Game Master (вдохновлено Horae): динамическое состояние мира — персонажи с
// автозаполнением по контексту («волшебная палочка»), события=меморибук, сетка
// отношений, календарь (день/месяц/год/время/локация + кастомные месяцы), адженда,
// список саммари (свёрток) и векторизация. Двуязычно (по глобальному языку UI).
type Tab = 'characters' | 'events' | 'relations' | 'calendar' | 'agenda' | 'summary' | 'vector';
type Lf = (ru: string, en: string) => string;
type GM = GameMasterState;
type PatchGm = (m: (gm: GM) => void) => void;

export function GameMasterPanel({
  open, onClose, project, onPatch,
}: {
  open: boolean;
  onClose: () => void;
  project?: Project | null;
  onPatch?: (mutator: (p: Project) => void) => void;
}) {
  const lang = useLang((s) => s.lang);
  const L: Lf = (ru, en) => (lang === 'en' ? en : ru);
  const [tab, setTab] = useState<Tab>('characters');
  const s = usePlayerStore();
  const gm = s.state?.gm ?? null;

  if (!open) return null;

  const TABS: { id: Tab; label: string; icon: string }[] = [
    { id: 'characters', label: L('Персонажи', 'Characters'), icon: '👥' },
    { id: 'events', label: L('События', 'Events'), icon: '🎬' },
    { id: 'relations', label: L('Взаимоотношения', 'Relationships'), icon: '🕸' },
    { id: 'calendar', label: L('Календарь', 'Calendar'), icon: '🗓' },
    { id: 'agenda', label: L('Адженда', 'Agenda'), icon: '✅' },
    { id: 'summary', label: L('Саммари', 'Summary'), icon: '🧠' },
    { id: 'vector', label: L('Векторизация', 'Vectorization'), icon: '🔎' },
  ];

  const noGame = (
    <p className="text-sm text-gray-500">
      {L('Эти данные появляются во время игры. Откройте игру.', 'This data appears during play. Open the game.')}
    </p>
  );

  return (
    <Modal open={open} onClose={onClose} title="Game Master" wide>
      <div className="flex gap-1 mb-4 flex-wrap">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`px-2.5 py-1.5 rounded-lg text-sm ${tab === t.id ? 'bg-accent text-white' : 'bg-panel2 hover:bg-white/10'}`}
            onClick={() => setTab(t.id)}
          >
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      {tab === 'characters' && (gm ? <CharactersTab gm={gm} patchGm={s.patchGm} L={L} /> : noGame)}
      {tab === 'events' && (gm ? <EventsTab gm={gm} patchGm={s.patchGm} L={L} /> : noGame)}
      {tab === 'relations' && (gm ? <RelationsTab gm={gm} patchGm={s.patchGm} L={L} /> : noGame)}
      {tab === 'calendar' && (gm ? <CalendarTab gm={gm} patchGm={s.patchGm} L={L} /> : noGame)}
      {tab === 'agenda' && (gm ? <AgendaTab gm={gm} patchGm={s.patchGm} L={L} /> : noGame)}
      {tab === 'summary' && <SummaryTab project={project} onPatch={onPatch} L={L} />}
      {tab === 'vector' && <VectorTab project={project} onPatch={onPatch} L={L} />}
    </Modal>
  );
}

// «Волшебная палочка» — общий обработчик скана с тостами.
async function runScan<T>(L: Lf, label: string, fn: () => Promise<T>, apply: (r: T) => void) {
  const id = pushToast('info', L(`Сканирую: ${label}…`, `Scanning: ${label}…`));
  try {
    const r = await fn();
    apply(r);
    updateToast(id, 'success', L('Готово', 'Done'));
  } catch (e) {
    updateToast(id, 'error', L('Ошибка скана: ', 'Scan error: ') + (e as Error).message);
  }
}

function WandButton({ busy, onClick, title }: { busy: boolean; onClick: () => void; title: string }) {
  return (
    <button
      className="btn-ghost !px-2 !py-1 text-xs"
      title={title}
      disabled={busy}
      onClick={onClick}
    >
      {busy ? '…' : '✨'}
    </button>
  );
}

function CharactersTab({ gm, patchGm, L }: { gm: GM; patchGm: PatchGm; L: Lf }) {
  const [busy, setBusy] = useState<number | null>(null);
  const setChar = (i: number, patch: Partial<GmCharacter>) =>
    patchGm((g) => { g.characters[i] = { ...g.characters[i], ...patch }; });

  const wand = async (i: number, name: string) => {
    const st = usePlayerStore.getState().state;
    if (!st) return;
    setBusy(i);
    await runScan(L, name || L('персонаж', 'character'), () => scanCharacter(st, name), (r) => {
      // применяем только непустые поля
      const patch: Partial<GmCharacter> = {};
      for (const [k, v] of Object.entries(r)) {
        if (Array.isArray(v) ? v.length : typeof v === 'string' && v.trim()) (patch as any)[k] = v;
      }
      setChar(i, patch);
    });
    setBusy(null);
  };

  const field = (label: string, value: string, onChange: (v: string) => void, area = false) => (
    <div>
      <label className="label">{label}</label>
      {area ? (
        <textarea className="input h-16 text-sm" value={value} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input className="input !py-1 text-sm" value={value} onChange={(e) => onChange(e.target.value)} />
      )}
    </div>
  );

  return (
    <div className="space-y-3">
      <div className="flex justify-between items-center">
        <p className="text-xs text-gray-500">
          {L('✨ автозаполнит досье по контексту истории.', '✨ auto-fills the dossier from story context.')}
        </p>
        <button
          className="btn-ghost !px-3 !py-1 text-xs"
          onClick={() =>
            patchGm((g) =>
              g.characters.push({
                name: L('Новый персонаж', 'New character'),
                dossier: '', appearance: '', personality: '', roleToHero: '',
                outfit: '', mood: '', status: '', location: '', tags: [],
              })
            )
          }
        >
          + {L('Персонаж', 'Character')}
        </button>
      </div>
      {gm.characters.length === 0 && <p className="text-gray-600 text-sm">—</p>}
      {gm.characters.map((c, i) => (
        <div key={i} className="card !p-3 !bg-panel2">
          <div className="flex items-center gap-2 mb-2">
            <input
              className="input !py-1 text-sm font-semibold flex-1"
              value={c.name}
              onChange={(e) => setChar(i, { name: e.target.value })}
            />
            <WandButton busy={busy === i} onClick={() => wand(i, c.name)} title={L('Автозаполнить по контексту', 'Auto-fill from context')} />
            <button className="btn-danger !px-2 !py-1 text-xs" onClick={() => patchGm((g) => g.characters.splice(i, 1))}>✕</button>
          </div>
          <div className="grid sm:grid-cols-2 gap-2">
            {field(L('Кто это (досье)', 'Who (dossier)'), c.dossier, (v) => setChar(i, { dossier: v }), true)}
            {field(L('Кто для героя', 'Role to hero'), c.roleToHero, (v) => setChar(i, { roleToHero: v }))}
            {field(L('Статус', 'Status'), c.status, (v) => setChar(i, { status: v }))}
            {field(L('Настроение', 'Mood'), c.mood, (v) => setChar(i, { mood: v }))}
            {field(L('Одежда', 'Outfit'), c.outfit, (v) => setChar(i, { outfit: v }))}
            {field(L('Локация', 'Location'), c.location, (v) => setChar(i, { location: v }))}
            {field(L('Внешность', 'Appearance'), c.appearance, (v) => setChar(i, { appearance: v }), true)}
            {field(L('Характер', 'Personality'), c.personality, (v) => setChar(i, { personality: v }), true)}
          </div>
          <div className="mt-2">
            {field(L('Теги (через запятую)', 'Tags (comma-separated)'), c.tags.join(', '),
              (v) => setChar(i, { tags: v.split(',').map((t) => t.trim()).filter(Boolean) }))}
          </div>
        </div>
      ))}
    </div>
  );
}

function EventsTab({ gm, patchGm, L }: { gm: GM; patchGm: PatchGm; L: Lf }) {
  const [busy, setBusy] = useState(false);
  const scan = async () => {
    const st = usePlayerStore.getState().state;
    if (!st) return;
    setBusy(true);
    await runScan(L, L('события', 'events'), () => scanEvents(st), (events) => {
      patchGm((g) => {
        const date = formatClock(g.clock);
        for (const e of events) {
          if (!e.summary.trim()) continue;
          if (g.events.some((x) => x.summary.toLowerCase() === e.summary.toLowerCase())) continue;
          g.events.push({ id: uid('evt'), turn: st.turnCount, date, chars: e.chars, summary: e.summary, mood: e.mood, source: 'manual' });
        }
      });
    });
    setBusy(false);
  };
  const setEvt = (i: number, patch: Partial<GM['events'][number]>) =>
    patchGm((g) => { g.events[i] = { ...g.events[i], ...patch }; });

  return (
    <div className="space-y-2">
      <div className="flex justify-between items-center">
        <p className="text-xs text-gray-500">
          {L('Журнал событий (= меморибук): что, когда, с кем. Внутриигровая дата держит хронологию.', 'Event log (= memorybook): what, when, with whom. In-game dates keep chronology.')}
        </p>
        <div className="flex gap-2">
          <WandButton busy={busy} onClick={scan} title={L('Собрать события из контекста', 'Extract events from context')} />
          <button
            className="btn-ghost !px-3 !py-1 text-xs"
            onClick={() => patchGm((g) => g.events.push({ id: uid('evt'), turn: 0, date: formatClock(g.clock), chars: [], summary: '', mood: '', source: 'manual' }))}
          >
            + {L('Событие', 'Event')}
          </button>
        </div>
      </div>
      {gm.events.length === 0 && <p className="text-gray-600 text-sm">—</p>}
      {[...gm.events].reverse().map((e, ri) => {
        const i = gm.events.length - 1 - ri;
        return (
          <div key={e.id} className="card !p-2 !bg-panel2">
            <div className="flex items-center gap-2 mb-1">
              <input
                className="input !py-0.5 text-xs w-40"
                placeholder={L('когда (дата)', 'when (date)')}
                value={e.date}
                onChange={(ev) => setEvt(i, { date: ev.target.value })}
              />
              <input
                className="input !py-0.5 text-xs flex-1"
                placeholder={L('с кем (через запятую)', 'with whom (comma)')}
                value={e.chars.join(', ')}
                onChange={(ev) => setEvt(i, { chars: ev.target.value.split(',').map((t) => t.trim()).filter(Boolean) })}
              />
              <button className="btn-danger !px-2 !py-0.5 text-xs" onClick={() => patchGm((g) => g.events.splice(i, 1))}>✕</button>
            </div>
            <textarea
              className="input !py-1 text-sm h-14"
              placeholder={L('что произошло', 'what happened')}
              value={e.summary}
              onChange={(ev) => setEvt(i, { summary: ev.target.value })}
            />
          </div>
        );
      })}
    </div>
  );
}

function RelationsTab({ gm, patchGm, L }: { gm: GM; patchGm: PatchGm; L: Lf }) {
  return (
    <div className="space-y-2">
      <div className="flex justify-between items-center">
        <p className="text-xs text-gray-500">{L('Связи между персонажами.', 'Ties between characters.')}</p>
        <button className="btn-ghost !px-3 !py-1 text-xs" onClick={() => patchGm((g) => g.relations.push({ from: '', to: '', label: '' }))}>
          + {L('Связь', 'Edge')}
        </button>
      </div>
      {gm.relations.length === 0 && <p className="text-gray-600 text-sm">—</p>}
      {gm.relations.map((r, i) => (
        <div key={i} className="flex gap-2 items-center">
          <input className="input !py-1 text-sm w-28" placeholder={L('от', 'from')} value={r.from} onChange={(e) => patchGm((g) => (g.relations[i].from = e.target.value))} />
          <span className="text-gray-500">→</span>
          <input className="input !py-1 text-sm w-28" placeholder={L('к', 'to')} value={r.to} onChange={(e) => patchGm((g) => (g.relations[i].to = e.target.value))} />
          <input className="input !py-1 text-sm flex-1" placeholder={L('характер связи', 'relationship')} value={r.label} onChange={(e) => patchGm((g) => (g.relations[i].label = e.target.value))} />
          <button className="btn-danger !px-2 !py-1 text-xs" onClick={() => patchGm((g) => g.relations.splice(i, 1))}>✕</button>
        </div>
      ))}
    </div>
  );
}

function CalendarTab({ gm, patchGm, L }: { gm: GM; patchGm: PatchGm; L: Lf }) {
  const [month, setMonth] = useState('');
  return (
    <div className="space-y-4 max-w-lg">
      <div className="grid grid-cols-3 gap-3">
        <Field label={L('День', 'Day')}>
          <input className="input" value={gm.clock.day} placeholder="1" onChange={(e) => patchGm((g) => (g.clock.day = e.target.value))} />
        </Field>
        <Field label={L('Месяц', 'Month')}>
          <input className="input" value={gm.clock.month} onChange={(e) => patchGm((g) => (g.clock.month = e.target.value))} />
        </Field>
        <Field label={L('Год', 'Year')}>
          <input className="input" value={gm.clock.year} placeholder="1024" onChange={(e) => patchGm((g) => (g.clock.year = e.target.value))} />
        </Field>
        <Field label={L('Время', 'Time')}>
          <input className="input" value={gm.clock.time} placeholder="09:00" onChange={(e) => patchGm((g) => (g.clock.time = e.target.value))} />
        </Field>
        <Field label={L('Локация', 'Location')}>
          <input className="input" value={gm.clock.location} onChange={(e) => patchGm((g) => (g.clock.location = e.target.value))} />
        </Field>
      </div>

      {/* Быстрый выбор месяца из настроенного списка */}
      {gm.calendar.months.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {gm.calendar.months.map((m) => (
            <button
              key={m}
              className={`chip !px-2 !py-1 text-xs ${gm.clock.month === m ? 'bg-accent2 text-white' : ''}`}
              onClick={() => patchGm((g) => (g.clock.month = m))}
            >
              {m}
            </button>
          ))}
        </div>
      )}

      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={gm.showClockInGame} onChange={(e) => patchGm((g) => (g.showClockInGame = e.target.checked))} />
        {L('Показывать часы/дату в игре (оверлей)', 'Show clock/date in game (overlay)')}
      </label>

      {/* Настройка названий месяцев (для фэнтези) */}
      <div className="card !bg-panel2 !p-3">
        <div className="flex items-center justify-between mb-2">
          <h4 className="font-semibold text-sm">{L('Названия месяцев', 'Month names')}</h4>
          <button
            className="btn-ghost !px-2 !py-1 text-xs"
            onClick={() => patchGm((g) => (g.calendar.months = [...DEFAULT_MONTHS]))}
          >
            {L('Земные по умолч.', 'Earth default')}
          </button>
        </div>
        <p className="text-xs text-gray-500 mb-2">
          {L('Свой набор месяцев для фэнтези-сеттинга (по умолчанию земные 12).', 'A custom month set for fantasy settings (default is the Earth 12).')}
        </p>
        <div className="flex flex-wrap gap-1 mb-2">
          {gm.calendar.months.map((m, i) => (
            <span key={i} className="inline-flex items-center gap-1 bg-panel rounded px-2 py-0.5 text-xs">
              <input
                className="bg-transparent w-24 outline-none"
                value={m}
                onChange={(e) => patchGm((g) => (g.calendar.months[i] = e.target.value))}
              />
              <button className="text-red-400" onClick={() => patchGm((g) => g.calendar.months.splice(i, 1))}>✕</button>
            </span>
          ))}
        </div>
        <div className="flex gap-2">
          <input
            className="input !py-1 text-sm flex-1"
            placeholder={L('добавить месяц…', 'add a month…')}
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && month.trim()) {
                patchGm((g) => g.calendar.months.push(month.trim()));
                setMonth('');
              }
            }}
          />
          <button
            className="btn-ghost !px-3 !py-1 text-xs"
            onClick={() => { if (month.trim()) { patchGm((g) => g.calendar.months.push(month.trim())); setMonth(''); } }}
          >
            +
          </button>
        </div>
        <p className="text-xs text-gray-500 mt-1">{L('Месяцев в году: ', 'Months per year: ')}{gm.calendar.months.length}</p>
      </div>

      <p className="text-xs text-gray-500">
        {L('Дата и время меняются каждый ход — ИИ продвигает их по сюжету, поэтому хронология не путается.', 'Date and time advance each turn — the AI moves them with the story, so chronology stays consistent.')}
      </p>
    </div>
  );
}

function AgendaTab({ gm, patchGm, L }: { gm: GM; patchGm: PatchGm; L: Lf }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const add = () => {
    if (!text.trim()) return;
    patchGm((g) => g.agenda.push({ id: uid('task'), text: text.trim(), done: false, source: 'manual' }));
    setText('');
  };
  const scan = async () => {
    const st = usePlayerStore.getState().state;
    if (!st) return;
    setBusy(true);
    await runScan(L, L('задачи', 'tasks'), () => scanAgenda(st), (tasks) => {
      patchGm((g) => {
        for (const t of tasks) {
          const v = t.trim();
          if (!v || g.agenda.some((x) => x.text.toLowerCase() === v.toLowerCase())) continue;
          g.agenda.push({ id: uid('task'), text: v, done: false, source: 'manual' });
        }
      });
    });
    setBusy(false);
  };
  return (
    <div className="space-y-2">
      <div className="flex justify-between items-center">
        <p className="text-xs text-gray-500">{L('Задачи по ходу истории. ✨ соберёт открытые цели из контекста.', 'Story tasks. ✨ extracts open goals from context.')}</p>
        <WandButton busy={busy} onClick={scan} title={L('Собрать задачи из контекста', 'Extract tasks from context')} />
      </div>
      <div className="flex gap-2">
        <input
          className="input !py-1 text-sm flex-1"
          placeholder={L('Новая задача…', 'New task…')}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
        />
        <button className="btn-ghost !px-3 !py-1 text-xs" onClick={add}>+</button>
      </div>
      {gm.agenda.length === 0 && <p className="text-gray-600 text-sm">—</p>}
      {gm.agenda.map((t, i) => (
        <div key={t.id} className="flex items-center gap-2">
          <input type="checkbox" checked={t.done} onChange={(e) => patchGm((g) => (g.agenda[i].done = e.target.checked))} />
          <input
            className={`input !py-1 text-sm flex-1 ${t.done ? 'line-through text-gray-500' : ''}`}
            value={t.text}
            onChange={(e) => patchGm((g) => (g.agenda[i].text = e.target.value))}
          />
          <button className="btn-danger !px-2 !py-1 text-xs" onClick={() => patchGm((g) => g.agenda.splice(i, 1))}>✕</button>
        </div>
      ))}
    </div>
  );
}

function SummaryTab({ project, onPatch, L }: { project?: Project | null; onPatch?: (m: (p: Project) => void) => void; L: Lf }) {
  const s = usePlayerStore();
  const memory = s.state?.memory ?? null;
  const patchMemory = s.patchMemory;

  return (
    <div className="space-y-4">
      <p className="text-xs text-gray-500">
        {L('Вместо раздутого контекста — краткие свёртки каждые N сообщений (всегда на английском). Список свёрток можно править и удалять.', 'Instead of a bloated context — short recaps every N messages (always English). The recap list is editable and deletable.')}
      </p>

      {/* Список свёрток/саммари */}
      {memory && (
        <div className="space-y-2">
          <h4 className="font-semibold text-sm">{L('Свёртки', 'Compressions')} ({memory.chronicle.length})</h4>
          {memory.chronicle.length === 0 && <p className="text-gray-600 text-sm">{L('пока нет свёрток', 'no compressions yet')}</p>}
          {memory.chronicle.map((c, i) => (
            <div key={c.id} className="card !p-2 !bg-panel2">
              <div className="flex items-center justify-between text-xs text-gray-500 mb-1">
                <span>
                  #{i + 1} · {L('сообщения', 'messages')} {c.fromMsg}–{c.toMsg}
                  {c.atTurn ? ` · ${L('ход', 'turn')} ${c.atTurn}` : ''}
                </span>
                <button className="btn-danger !px-2 !py-0.5 text-xs" onClick={() => patchMemory((m) => m.chronicle.splice(i, 1))}>✕</button>
              </div>
              <textarea
                className="input !py-1 text-sm h-20"
                value={c.text}
                onChange={(e) => patchMemory((m) => { m.chronicle[i].text = e.target.value; })}
              />
            </div>
          ))}
        </div>
      )}
      {!memory && <p className="text-xs text-gray-500">{L('Список свёрток появится во время игры.', 'The compression list appears during play.')}</p>}

      {/* Настройки саммари (проектные) */}
      {project && onPatch && <SummaryConfig project={project} onPatch={onPatch} L={L} />}
    </div>
  );
}

function SummaryConfig({ project, onPatch, L }: { project: Project; onPatch: (m: (p: Project) => void) => void; L: Lf }) {
  const mc = project.memoryConfig;
  const patchMem = (p: Partial<MemoryConfig>) => onPatch((proj) => Object.assign(proj.memoryConfig, p));
  return (
    <div className="card !bg-panel2 !p-3 space-y-3">
      <h4 className="font-semibold text-sm">{L('Настройки саммари', 'Summary settings')}</h4>
      <Field label={L(`Частота: каждые ${mc.summaryEveryN} ходов`, `Every ${mc.summaryEveryN} turns`)}>
        <div className="flex gap-2">
          {[20, 30, 40].map((n) => (
            <button key={n} className={`chip !px-3 !py-1.5 ${mc.summaryEveryN === n ? 'bg-accent2 text-white' : ''}`} onClick={() => patchMem({ summaryEveryN: n })}>{n}</button>
          ))}
          <input type="number" min={4} className="input w-24" value={mc.summaryEveryN} onChange={(e) => patchMem({ summaryEveryN: Number(e.target.value) })} />
        </div>
      </Field>
      <Field label={L('Кастомный промпт саммарайзера (опц.)', 'Custom summarizer prompt (opt.)')}>
        <textarea className="input h-20" value={mc.summaryPrompt || ''} onChange={(e) => patchMem({ summaryPrompt: e.target.value || undefined })} />
      </Field>
      <div>
        <label className="flex items-center gap-2 text-sm mb-2">
          <input
            type="checkbox"
            checked={!!project.aiConfig.summaryConnection}
            onChange={(e) => onPatch((p) => {
              const g = getConnection();
              p.aiConfig.summaryConnection = e.target.checked ? { provider: g.provider, baseUrl: g.baseUrl, model: g.model } : undefined;
            })}
          />
          {L('Отдельный API для саммари (иначе — основной)', 'Separate API for summary (else — main)')}
        </label>
        {project.aiConfig.summaryConnection && (
          <ApiConnectionField conn={project.aiConfig.summaryConnection} keyRole="summary" onChange={(conn) => onPatch((p) => (p.aiConfig.summaryConnection = conn))} />
        )}
      </div>
    </div>
  );
}

function VectorTab({ project, onPatch, L }: { project?: Project | null; onPatch?: (m: (p: Project) => void) => void; L: Lf }) {
  if (!project || !onPatch) return <p className="text-sm text-gray-400">{L('Откройте проект.', 'Open a project.')}</p>;
  const mc = project.memoryConfig;
  const patchMem = (p: Partial<MemoryConfig>) => onPatch((proj) => Object.assign(proj.memoryConfig, p));
  return (
    <div>
      <p className="text-xs text-gray-500 mb-3">
        {L('Подсос релевантных кусков истории по смыслу — на основном или стороннем API.', 'Retrieves relevant history chunks by meaning — on the main or a third-party API.')}
      </p>
      <div className="flex gap-2 mb-3">
        {(['off', 'builtin', 'custom'] as VectorizationMode[]).map((m) => (
          <button key={m} className={`chip !px-3 !py-1.5 ${mc.vectorization === m ? 'bg-accent2 text-white' : ''}`} onClick={() => patchMem({ vectorization: m })}>
            {m === 'off' ? L('Выкл', 'Off') : m === 'builtin' ? L('Встроенная', 'Built-in') : L('Свой API', 'Custom API')}
          </button>
        ))}
      </div>
      {mc.vectorization === 'builtin' && (
        <p className="text-xs text-gray-500">{L('Модель (~25 МБ, MiniLM) грузится в браузере, считает в Web Worker.', 'Model (~25 MB, MiniLM) loads in-browser, runs in a Web Worker.')}</p>
      )}
      {mc.vectorization === 'custom' && (
        <ApiConnectionField
          conn={mc.embeddingsConnection || { provider: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', model: 'text-embedding-3-small' }}
          keyRole="embeddings"
          onChange={(conn) => patchMem({ embeddingsConnection: conn })}
        />
      )}
    </div>
  );
}

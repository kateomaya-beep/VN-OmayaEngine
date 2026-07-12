import { useState } from 'react';
import { Modal, Field } from '../../shared/ui';
import { useLang } from '../../shared/i18n';
import { usePlayerStore } from '../player/playerStore';
import { ApiConnectionField } from '../constructor/editors/ApiConnectionField';
import { getConnection } from '../../ai/connection';
import { uid } from '../../shared/utils';
import type { Project, MemoryConfig, VectorizationMode, GmCharacter } from '../../shared/types';

// Game Master (вдохновлено Horae): единая панель динамического состояния мира —
// персонажи/досье, события, сетка отношений, календарь+часы, саммари, векторизация,
// адженда. Character/event/… данные живут в runtime (usePlayerStore.state.gm) и
// обновляются ИИ каждый ход; summary/vectorization — проектные настройки.
type Tab = 'characters' | 'events' | 'relations' | 'calendar' | 'agenda' | 'summary' | 'vector';

export function GameMasterPanel({
  open,
  onClose,
  project,
  onPatch,
}: {
  open: boolean;
  onClose: () => void;
  project?: Project | null;
  onPatch?: (mutator: (p: Project) => void) => void;
}) {
  const lang = useLang((s) => s.lang);
  const L = (ru: string, en: string) => (lang === 'en' ? en : ru);
  const [tab, setTab] = useState<Tab>('characters');
  const s = usePlayerStore();
  const gm = s.state?.gm ?? null;
  const patchGm = s.patchGm;

  if (!open) return null;

  const TABS: { id: Tab; label: string; icon: string; needsGame?: boolean }[] = [
    { id: 'characters', label: L('Персонажи', 'Characters'), icon: '👥', needsGame: true },
    { id: 'events', label: L('События', 'Events'), icon: '🎬', needsGame: true },
    { id: 'relations', label: L('Взаимоотношения', 'Relationships'), icon: '🕸', needsGame: true },
    { id: 'calendar', label: L('Календарь', 'Calendar'), icon: '🗓', needsGame: true },
    { id: 'agenda', label: L('Адженда', 'Agenda'), icon: '✅', needsGame: true },
    { id: 'summary', label: L('Саммари', 'Summary'), icon: '🧠' },
    { id: 'vector', label: L('Векторизация', 'Vectorization'), icon: '🔎' },
  ];

  const noGame = (
    <p className="text-sm text-gray-500">
      {L(
        'Эти данные появляются во время игры — ИИ наполняет их каждый ход. Откройте игру.',
        'This data appears during play — the AI fills it each turn. Open the game.'
      )}
    </p>
  );

  return (
    <Modal open={open} onClose={onClose} title={L('Game Master', 'Game Master')} wide>
      <div className="flex gap-1 mb-4 flex-wrap">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`px-2.5 py-1.5 rounded-lg text-sm ${
              tab === t.id ? 'bg-accent text-white' : 'bg-panel2 hover:bg-white/10'
            }`}
            onClick={() => setTab(t.id)}
          >
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      {tab === 'characters' &&
        (gm ? <CharactersTab gm={gm} patchGm={patchGm} L={L} /> : noGame)}
      {tab === 'events' && (gm ? <EventsTab gm={gm} patchGm={patchGm} L={L} /> : noGame)}
      {tab === 'relations' && (gm ? <RelationsTab gm={gm} patchGm={patchGm} L={L} /> : noGame)}
      {tab === 'calendar' && (gm ? <CalendarTab gm={gm} patchGm={patchGm} L={L} /> : noGame)}
      {tab === 'agenda' && (gm ? <AgendaTab gm={gm} patchGm={patchGm} L={L} /> : noGame)}
      {tab === 'summary' && <SummaryTab project={project} onPatch={onPatch} L={L} />}
      {tab === 'vector' && <VectorTab project={project} onPatch={onPatch} L={L} />}
    </Modal>
  );
}

type PatchGm = (m: (gm: import('../../shared/types').GameMasterState) => void) => void;
type Lf = (ru: string, en: string) => string;
type GM = import('../../shared/types').GameMasterState;

function CharactersTab({ gm, patchGm, L }: { gm: GM; patchGm: PatchGm; L: Lf }) {
  const field = (
    label: string,
    value: string,
    onChange: (v: string) => void,
    area = false
  ) => (
    <div>
      <label className="label">{label}</label>
      {area ? (
        <textarea className="input h-16 text-sm" value={value} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input className="input !py-1 text-sm" value={value} onChange={(e) => onChange(e.target.value)} />
      )}
    </div>
  );
  const setChar = (i: number, patch: Partial<GmCharacter>) =>
    patchGm((g) => {
      g.characters[i] = { ...g.characters[i], ...patch };
    });
  return (
    <div className="space-y-3">
      <div className="flex justify-between items-center">
        <p className="text-xs text-gray-500">
          {L('Досье персонажей — ИИ обновляет каждый ход, можно править.', 'Character dossiers — the AI refreshes them each turn; editable.')}
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
            <button
              className="btn-danger !px-2 !py-1 text-xs"
              onClick={() => patchGm((g) => g.characters.splice(i, 1))}
            >
              ✕
            </button>
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
            {field(
              L('Теги (через запятую)', 'Tags (comma-separated)'),
              c.tags.join(', '),
              (v) => setChar(i, { tags: v.split(',').map((t) => t.trim()).filter(Boolean) })
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function EventsTab({ gm, patchGm, L }: { gm: GM; patchGm: PatchGm; L: Lf }) {
  return (
    <div className="space-y-2">
      <p className="text-xs text-gray-500">
        {L('Анализ сцен по ходам (событие + настроение).', 'Per-turn scene analysis (event + mood).')}
      </p>
      {gm.events.length === 0 && <p className="text-gray-600 text-sm">—</p>}
      {[...gm.events].reverse().map((e, ri) => {
        const i = gm.events.length - 1 - ri;
        return (
          <div key={i} className="card !p-2 !bg-panel2 flex items-start gap-2">
            <span className="text-xs text-gray-500 shrink-0 mt-1">t{e.turn}</span>
            <div className="flex-1">
              <div className="text-sm">{e.summary}</div>
              {e.mood && <div className="text-xs text-accent2">{e.mood}</div>}
            </div>
            <button
              className="btn-ghost !px-2 !py-0.5 text-xs"
              onClick={() => patchGm((g) => g.events.splice(i, 1))}
            >
              ✕
            </button>
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
        <button
          className="btn-ghost !px-3 !py-1 text-xs"
          onClick={() => patchGm((g) => g.relations.push({ from: '', to: '', label: '' }))}
        >
          + {L('Связь', 'Edge')}
        </button>
      </div>
      {gm.relations.length === 0 && <p className="text-gray-600 text-sm">—</p>}
      {gm.relations.map((r, i) => (
        <div key={i} className="flex gap-2 items-center">
          <input
            className="input !py-1 text-sm w-28"
            placeholder={L('от', 'from')}
            value={r.from}
            onChange={(e) => patchGm((g) => (g.relations[i].from = e.target.value))}
          />
          <span className="text-gray-500">→</span>
          <input
            className="input !py-1 text-sm w-28"
            placeholder={L('к', 'to')}
            value={r.to}
            onChange={(e) => patchGm((g) => (g.relations[i].to = e.target.value))}
          />
          <input
            className="input !py-1 text-sm flex-1"
            placeholder={L('характер связи', 'relationship')}
            value={r.label}
            onChange={(e) => patchGm((g) => (g.relations[i].label = e.target.value))}
          />
          <button
            className="btn-danger !px-2 !py-1 text-xs"
            onClick={() => patchGm((g) => g.relations.splice(i, 1))}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}

function CalendarTab({ gm, patchGm, L }: { gm: GM; patchGm: PatchGm; L: Lf }) {
  return (
    <div className="space-y-3 max-w-md">
      <div className="grid grid-cols-2 gap-3">
        <Field label={L('Дата (в игре)', 'In-game date')}>
          <input
            className="input"
            value={gm.clock.date}
            placeholder={L('День 1', 'Day 1')}
            onChange={(e) => patchGm((g) => (g.clock.date = e.target.value))}
          />
        </Field>
        <Field label={L('Время (в игре)', 'In-game time')}>
          <input
            className="input"
            value={gm.clock.time}
            placeholder="09:00"
            onChange={(e) => patchGm((g) => (g.clock.time = e.target.value))}
          />
        </Field>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={gm.showClockInGame}
          onChange={(e) => patchGm((g) => (g.showClockInGame = e.target.checked))}
        />
        {L('Показывать часы/дату в игре (оверлей)', 'Show clock/date in game (overlay)')}
      </label>
      <p className="text-xs text-gray-500">
        {L(
          'Время и дата меняются каждый ход — ИИ продвигает их по сюжету.',
          'Date and time advance each turn — the AI moves them with the story.'
        )}
      </p>
    </div>
  );
}

function AgendaTab({ gm, patchGm, L }: { gm: GM; patchGm: PatchGm; L: Lf }) {
  const [text, setText] = useState('');
  return (
    <div className="space-y-2">
      <p className="text-xs text-gray-500">
        {L('Задачи по ходу истории. Галочка — выполнено; можно добавлять/править/удалять.', 'Story tasks. Check when done; add/edit/remove your own.')}
      </p>
      <div className="flex gap-2">
        <input
          className="input !py-1 text-sm flex-1"
          placeholder={L('Новая задача…', 'New task…')}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && text.trim()) {
              patchGm((g) => g.agenda.push({ id: uid('task'), text: text.trim(), done: false, source: 'manual' }));
              setText('');
            }
          }}
        />
        <button
          className="btn-ghost !px-3 !py-1 text-xs"
          onClick={() => {
            if (!text.trim()) return;
            patchGm((g) => g.agenda.push({ id: uid('task'), text: text.trim(), done: false, source: 'manual' }));
            setText('');
          }}
        >
          +
        </button>
      </div>
      {gm.agenda.length === 0 && <p className="text-gray-600 text-sm">—</p>}
      {gm.agenda.map((t, i) => (
        <div key={t.id} className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={t.done}
            onChange={(e) => patchGm((g) => (g.agenda[i].done = e.target.checked))}
          />
          <input
            className={`input !py-1 text-sm flex-1 ${t.done ? 'line-through text-gray-500' : ''}`}
            value={t.text}
            onChange={(e) => patchGm((g) => (g.agenda[i].text = e.target.value))}
          />
          <button
            className="btn-danger !px-2 !py-1 text-xs"
            onClick={() => patchGm((g) => g.agenda.splice(i, 1))}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}

function SummaryTab({
  project,
  onPatch,
  L,
}: {
  project?: Project | null;
  onPatch?: (m: (p: Project) => void) => void;
  L: Lf;
}) {
  if (!project || !onPatch)
    return <p className="text-sm text-gray-400">{L('Откройте проект.', 'Open a project.')}</p>;
  const mc = project.memoryConfig;
  const patchMem = (p: Partial<MemoryConfig>) => onPatch((proj) => Object.assign(proj.memoryConfig, p));
  return (
    <div className="space-y-4">
      <p className="text-xs text-gray-500">
        {L(
          'Вместо раздутого контекста — краткий пересказ каждые N сообщений. Пересказ всегда на английском. В фоне; о процессе — всплывающие сообщения.',
          'Instead of a bloated context — a short recap every N messages. The recap is always in English. Runs in the background with pop-up status.'
        )}
      </p>
      <Field label={L(`Частота свёртки: каждые ${mc.summaryEveryN} ходов`, `Summarize every ${mc.summaryEveryN} turns`)}>
        <div className="flex gap-2">
          {[20, 30, 40].map((n) => (
            <button
              key={n}
              className={`chip !px-3 !py-1.5 ${mc.summaryEveryN === n ? 'bg-accent2 text-white' : ''}`}
              onClick={() => patchMem({ summaryEveryN: n })}
            >
              {n}
            </button>
          ))}
          <input
            type="number"
            min={4}
            className="input w-24"
            value={mc.summaryEveryN}
            onChange={(e) => patchMem({ summaryEveryN: Number(e.target.value) })}
          />
        </div>
      </Field>
      <Field label={L('Кастомный промпт саммарайзера (опц.)', 'Custom summarizer prompt (opt.)')}>
        <textarea
          className="input h-24"
          value={mc.summaryPrompt || ''}
          onChange={(e) => patchMem({ summaryPrompt: e.target.value || undefined })}
        />
      </Field>
      <div>
        <label className="flex items-center gap-2 text-sm mb-2">
          <input
            type="checkbox"
            checked={!!project.aiConfig.summaryConnection}
            onChange={(e) =>
              onPatch((p) => {
                const g = getConnection();
                p.aiConfig.summaryConnection = e.target.checked
                  ? { provider: g.provider, baseUrl: g.baseUrl, model: g.model }
                  : undefined;
              })
            }
          />
          {L('Отдельный API для саммари (иначе — основной)', 'Separate API for summary (else — main)')}
        </label>
        {project.aiConfig.summaryConnection && (
          <ApiConnectionField
            conn={project.aiConfig.summaryConnection}
            keyRole="summary"
            onChange={(conn) => onPatch((p) => (p.aiConfig.summaryConnection = conn))}
          />
        )}
      </div>
    </div>
  );
}

function VectorTab({
  project,
  onPatch,
  L,
}: {
  project?: Project | null;
  onPatch?: (m: (p: Project) => void) => void;
  L: Lf;
}) {
  if (!project || !onPatch)
    return <p className="text-sm text-gray-400">{L('Откройте проект.', 'Open a project.')}</p>;
  const mc = project.memoryConfig;
  const patchMem = (p: Partial<MemoryConfig>) => onPatch((proj) => Object.assign(proj.memoryConfig, p));
  return (
    <div>
      <p className="text-xs text-gray-500 mb-3">
        {L(
          'Подсос релевантных кусков свёрнутой истории по смыслу хода — на основном или стороннем API.',
          'Retrieves relevant chunks of compressed history by meaning — on the main or a third-party API.'
        )}
      </p>
      <div className="flex gap-2 mb-3">
        {(['off', 'builtin', 'custom'] as VectorizationMode[]).map((m) => (
          <button
            key={m}
            className={`chip !px-3 !py-1.5 ${mc.vectorization === m ? 'bg-accent2 text-white' : ''}`}
            onClick={() => patchMem({ vectorization: m })}
          >
            {m === 'off' ? L('Выкл', 'Off') : m === 'builtin' ? L('Встроенная', 'Built-in') : L('Свой API', 'Custom API')}
          </button>
        ))}
      </div>
      {mc.vectorization === 'builtin' && (
        <p className="text-xs text-gray-500">
          {L('Модель (~25 МБ, MiniLM) грузится в браузере, считает в Web Worker.', 'Model (~25 MB, MiniLM) loads in-browser, runs in a Web Worker.')}
        </p>
      )}
      {mc.vectorization === 'custom' && (
        <ApiConnectionField
          conn={
            mc.embeddingsConnection || {
              provider: 'openai-compatible',
              baseUrl: 'https://api.openai.com/v1',
              model: 'text-embedding-3-small',
            }
          }
          keyRole="embeddings"
          onChange={(conn) => patchMem({ embeddingsConnection: conn })}
        />
      )}
    </div>
  );
}

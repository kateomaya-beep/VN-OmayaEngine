import { useState } from 'react';
import { Modal, Field } from '../../shared/ui';
import { useLang } from '../../shared/i18n';
import { usePlayerStore } from '../player/playerStore';
import { ApiConnectionField } from '../constructor/editors/ApiConnectionField';
import { getConnection } from '../../ai/connection';
import { formatClock } from '../../ai/gameMaster';
import { scanCharacter, scanEvents, scanAgenda, generateCharacterSheet, type GeneratedSheet } from '../../ai/gmScan';
import { buildRegistryView, findDuplicatePairs } from '../../ai/characterRegistry';
import { pushToast, updateToast } from '../../shared/toast';
import { uid } from '../../shared/utils';
import { DEFAULT_MONTHS, RELATIONSHIP_FIELDS, RELATIONSHIP_META } from '../../shared/types';
import type {
  Project, MemoryConfig, VectorizationMode, GmCharacter, GameMasterState, RelationshipStats,
  AssetSelectorSource, CharacterRole, MemoryState,
} from '../../shared/types';
import { resummarizeArchived } from '../../ai/memoryEngine';

// Game Master (вдохновлено Horae): динамическое состояние мира — персонажи с
// автозаполнением по контексту («волшебная палочка»), события=меморибук, сетка
// отношений, календарь (день/месяц/год/время/локация + кастомные месяцы), адженда,
// список саммари (свёрток) и векторизация. Двуязычно (по глобальному языку UI).
type Tab = 'characters' | 'inventory' | 'sheets' | 'events' | 'relations' | 'locations' | 'calendar' | 'agenda' | 'summary' | 'vector' | 'selector';
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
    { id: 'inventory', label: L('Инвентарь', 'Inventory'), icon: '🎒' },
    { id: 'sheets', label: L('Анкеты', 'Sheets'), icon: '📇' },
    { id: 'events', label: L('События', 'Events'), icon: '🎬' },
    { id: 'relations', label: L('Взаимоотношения', 'Relationships'), icon: '🕸' },
    { id: 'locations', label: L('Локации', 'Locations'), icon: '📍' },
    { id: 'calendar', label: L('Календарь', 'Calendar'), icon: '🗓' },
    { id: 'agenda', label: L('Адженда', 'Agenda'), icon: '✅' },
    { id: 'summary', label: L('Саммари', 'Summary'), icon: '🧠' },
    { id: 'vector', label: L('Векторизация', 'Vectorization'), icon: '🔎' },
    { id: 'selector', label: L('Селектор', 'Selector'), icon: '🎨' },
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

      {tab === 'characters' && (gm ? <CharactersTab gm={gm} patchGm={s.patchGm} L={L} project={project} relationship={s.state?.relationship ?? {}} /> : noGame)}
      {tab === 'inventory' && (s.state ? <InventoryTab L={L} /> : noGame)}
      {tab === 'sheets' && (s.state ? <SheetsTab L={L} project={project} /> : noGame)}
      {tab === 'events' && (gm ? <EventsTab gm={gm} patchGm={s.patchGm} L={L} /> : noGame)}
      {tab === 'relations' && (gm ? <RelationsTab gm={gm} patchGm={s.patchGm} L={L} /> : noGame)}
      {tab === 'locations' && (gm ? <LocationsTab gm={gm} patchGm={s.patchGm} L={L} /> : noGame)}
      {tab === 'calendar' && (gm ? <CalendarTab gm={gm} patchGm={s.patchGm} L={L} /> : noGame)}
      {tab === 'agenda' && (gm ? <AgendaTab gm={gm} patchGm={s.patchGm} L={L} /> : noGame)}
      {tab === 'summary' && <SummaryTab project={project} onPatch={onPatch} L={L} />}
      {tab === 'vector' && <VectorTab project={project} onPatch={onPatch} L={L} />}
      {tab === 'selector' && <SelectorTab project={project} onPatch={onPatch} L={L} />}
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

// Живые статы отношений персонажа к герою (❤️🔥🍀🎖), диверджентные полоски -100..100.
// Обновляются каждый ход (значения берутся из runtime-состояния), поэтому за динамикой
// можно следить прямо в анкете.
function RelationshipBars({ rel, L }: { rel?: RelationshipStats; L: Lf }) {
  if (!rel) return null;
  return (
    <div className="mt-2 pt-2 border-t border-white/10">
      <p className="text-[11px] text-gray-500 mb-1">{L('Отношение к герою (динамически)', 'Toward the hero (live)')}</p>
      <div className="grid sm:grid-cols-2 gap-x-4 gap-y-1">
        {RELATIONSHIP_FIELDS.map((f) => {
          const meta = RELATIONSHIP_META[f];
          const v = rel[f] ?? 0;
          const pct = Math.min(50, Math.abs(v) / 2); // 0..50% от центра
          return (
            <div key={f} className="flex items-center gap-1.5 text-xs" title={L(meta.ru, meta.en)}>
              <span className="w-4 text-center">{meta.icon}</span>
              <div className="relative flex-1 h-1.5 rounded bg-black/40 overflow-hidden">
                <div className="absolute left-1/2 top-0 bottom-0 w-px bg-white/25" />
                <div
                  className={`absolute top-0 bottom-0 ${v >= 0 ? 'bg-emerald-400/80' : 'bg-rose-400/80'}`}
                  style={v >= 0 ? { left: '50%', width: `${pct}%` } : { right: '50%', width: `${pct}%` }}
                />
              </div>
              <span
                className={`w-8 text-right tabular-nums ${
                  v > 0 ? 'text-emerald-300' : v < 0 ? 'text-rose-300' : 'text-gray-600'
                }`}
              >
                {v > 0 ? `+${v}` : v}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function CharactersTab({
  gm, patchGm, L, project, relationship,
}: {
  gm: GM; patchGm: PatchGm; L: Lf;
  project?: Project | null;
  relationship: Record<string, RelationshipStats>;
}) {
  const [busy, setBusy] = useState<number | null>(null);
  const setChar = (i: number, patch: Partial<GmCharacter>) =>
    patchGm((g) => { g.characters[i] = { ...g.characters[i], ...patch }; });

  // Резолвим id проектного персонажа (для живых статов отношений): по charId, иначе по имени.
  const byName = new Map((project?.characters ?? []).map((c) => [c.name.trim().toLowerCase(), c.id]));
  const idSet = new Set((project?.characters ?? []).map((c) => c.id));
  const resolveRel = (c: GmCharacter): RelationshipStats | undefined => {
    const id = c.charId && idSet.has(c.charId) ? c.charId : byName.get((c.name || '').trim().toLowerCase());
    return id ? relationship[id] : undefined;
  };

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
          <RelationshipBars rel={resolveRel(c)} L={L} />
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

const INV_CATEGORIES = ['одежда', 'еда', 'ценности', 'ключевые', 'прочее'];

function InventoryTab({ L }: { L: Lf }) {
  const s = usePlayerStore();
  const inv = s.state?.inventory ?? [];
  const patch = s.patchInventory;
  const add = () =>
    patch((list) =>
      list.push({
        id: uid('inv'),
        name: L('Новый предмет', 'New item'),
        emoji: '📦',
        quantity: 1,
        category: 'прочее',
        manualEntry: true,
      })
    );

  return (
    <div className="space-y-2">
      <div className="flex justify-between items-center">
        <p className="text-xs text-gray-500">
          {L('Вещи протагониста. ИИ не даёт использовать то, чего здесь нет; расходники убывают.', "The hero's belongings. The AI won't let them use what's not here; consumables deplete.")}
        </p>
        <button className="btn-ghost !px-3 !py-1 text-xs" onClick={add}>+ {L('Предмет', 'Item')}</button>
      </div>
      {inv.length === 0 && <p className="text-gray-600 text-sm">{L('Пусто.', 'Empty.')}</p>}
      <div className="space-y-1.5">
        {inv.map((it, i) => (
          <div key={it.id} className="flex items-center gap-2 rounded-lg bg-panel2 px-2 py-1.5">
            <input
              className="input !py-1 !px-1 text-center w-10"
              value={it.emoji}
              maxLength={4}
              onChange={(e) => patch((l) => (l[i].emoji = [...e.target.value.trim()][0] || '📦'))}
              title={L('Эмодзи', 'Emoji')}
            />
            <input
              className="input !py-1 text-sm flex-1"
              value={it.name}
              onChange={(e) => patch((l) => (l[i].name = e.target.value))}
            />
            <input
              className="input !py-1 text-sm w-14"
              type="number"
              min={1}
              value={it.quantity}
              onChange={(e) => patch((l) => (l[i].quantity = Math.max(1, Math.round(Number(e.target.value) || 1))))}
              title={L('Количество', 'Quantity')}
            />
            <select
              className="input !py-1 text-xs w-24"
              value={it.category || 'прочее'}
              onChange={(e) => patch((l) => (l[i].category = e.target.value))}
            >
              {INV_CATEGORIES.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
              {it.category && !INV_CATEGORIES.includes(it.category) && <option value={it.category}>{it.category}</option>}
            </select>
            <button className="btn-danger !px-2 !py-1 text-xs" onClick={() => patch((l) => l.splice(i, 1))}>✕</button>
          </div>
        ))}
      </div>
    </div>
  );
}

// Поиск и склейка дублей персонажей (patch character-registry §3.3).
function MergeDuplicates({ L, project }: { L: Lf; project?: Project | null }) {
  const s = usePlayerStore();
  const [scanned, setScanned] = useState<null | [string, string][]>(null); // пары id
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  const nameOf = (id: string) => {
    const reg = s.state ? buildRegistryView(project!, s.state.gm) : [];
    const e = reg.find((x) => x.id === id);
    if (!e) return id;
    const aka = e.aliases.filter((a) => a.toLowerCase() !== e.canonicalName.toLowerCase());
    return `${e.canonicalName}${aka.length ? ` (${aka.join(', ')})` : ''}`;
  };

  const run = () => {
    if (!s.state || !project) return;
    const reg = buildRegistryView(project, s.state.gm);
    const pairs = findDuplicatePairs(reg).map(([a, b]) => [a.id, b.id] as [string, string]);
    setScanned(pairs);
    setDismissed(new Set());
  };

  const visible = (scanned || []).filter(([a, b]) => !dismissed.has(`${a}|${b}`));

  return (
    <div className="rounded-lg border border-white/10 bg-panel2 p-2.5 space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-xs uppercase tracking-wide text-gray-500">
          {L('Дубли персонажей', 'Duplicate characters')}
        </div>
        <button className="btn-ghost !px-3 !py-1 text-xs" onClick={run}>
          🔗 {L('Найти дубли', 'Find duplicates')}
        </button>
      </div>
      {scanned && visible.length === 0 && (
        <p className="text-xs text-gray-500">{L('Подозрительных пар не найдено.', 'No suspicious pairs found.')}</p>
      )}
      {visible.map(([a, b]) => {
        const key = `${a}|${b}`;
        return (
          <div key={key} className="rounded bg-black/20 p-2 text-sm">
            <div className="text-white/90 mb-1.5">
              {nameOf(a)} <span className="text-gray-500">↔</span> {nameOf(b)}
            </div>
            <div className="flex flex-wrap gap-1.5">
              <button
                className="btn-ghost !px-2 !py-1 text-xs"
                onClick={() => { s.mergeCharacters(a, b); setDismissed((d) => new Set(d).add(key)); }}
                title={L('Оставить первого, второго влить в него', 'Keep the first, merge the second into it')}
              >
                {L('Оставить', 'Keep')} «{nameOf(a).split(' (')[0]}»
              </button>
              <button
                className="btn-ghost !px-2 !py-1 text-xs"
                onClick={() => { s.mergeCharacters(b, a); setDismissed((d) => new Set(d).add(key)); }}
              >
                {L('Оставить', 'Keep')} «{nameOf(b).split(' (')[0]}»
              </button>
              <button
                className="btn-ghost !px-2 !py-1 text-xs text-gray-400"
                onClick={() => setDismissed((d) => new Set(d).add(key))}
              >
                {L('Не дубли', 'Not dupes')}
              </button>
            </div>
          </div>
        );
      })}
      {!scanned && (
        <p className="text-[11px] text-gray-500">
          {L('Ищет одинаковых персонажей под разными именами и сливает их (статы отношений — по максимуму, алиасы и контакты объединяются).',
             'Finds the same character under different names and merges them (relationship stats take the max; aliases and contacts are combined).')}
        </p>
      )}
    </div>
  );
}

// Анкеты (Batch 8 §VI.2-3): генерация полной карточки на английском → правка → экспорт.
function SheetsTab({ L, project }: { L: Lf; project?: Project | null }) {
  const s = usePlayerStore();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [sheet, setSheet] = useState<GeneratedSheet | null>(null);
  const [role, setRole] = useState<CharacterRole>('important_character');
  const [done, setDone] = useState(false);

  const gen = async () => {
    const n = name.trim();
    if (!n || !s.state || busy) return;
    setBusy(true);
    setDone(false);
    try {
      const sh = await generateCharacterSheet(s.state, n);
      setSheet(sh);
    } catch (e) {
      pushToast('error', L('Не удалось сгенерировать анкету: ', 'Sheet generation failed: ') + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  };

  const upd = (k: keyof GeneratedSheet, v: string) => setSheet((sh) => (sh ? { ...sh, [k]: v } : sh));
  const existing = sheet && project?.characters.find((c) => c.name.toLowerCase() === sheet.name.toLowerCase());

  const doExport = () => {
    if (!sheet) return;
    s.exportCharacterSheet(sheet, role);
    setDone(true);
  };

  const npcAndMentioned = [
    ...(project?.characters.filter((c) => c.role === 'npc').map((c) => c.name) || []),
    ...(s.state?.gm.characters.map((c) => c.name) || []),
  ].filter((n, i, a) => n && a.indexOf(n) === i);

  return (
    <div className="space-y-3">
      <MergeDuplicates L={L} project={project} />

      <p className="text-xs text-gray-500">
        {L(
          'Полная анкета персонажа на английском (для совместимости с ST/Janitor) по имени из истории. Правьте перед добавлением в проект.',
          'A full English character sheet (ST/Janitor-compatible) built from the transcript. Edit before adding to the project.'
        )}
      </p>
      <div className="flex gap-2 items-center flex-wrap">
        <input
          className="input !py-1.5 text-sm flex-1 min-w-[160px]"
          placeholder={L('Имя персонажа', 'Character name')}
          value={name}
          list="gm-sheet-names"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && gen()}
        />
        <datalist id="gm-sheet-names">
          {npcAndMentioned.map((n) => <option key={n} value={n} />)}
        </datalist>
        <button className="btn-primary !py-1.5 text-sm" onClick={gen} disabled={busy || !name.trim()}>
          {busy ? '⏳' : '🪄'} {L('Сгенерировать', 'Generate')}
        </button>
      </div>

      {sheet && (
        <div className="card space-y-2">
          {(['name', 'appearance', 'personality', 'backstory', 'speechStyle', 'scenario'] as (keyof GeneratedSheet)[]).map((k) => (
            <Field key={k as string} label={k as string}>
              {k === 'name' ? (
                <input className="input !py-1 text-sm" value={(sheet[k] as string) || ''} onChange={(e) => upd(k, e.target.value)} />
              ) : (
                <textarea className="input text-sm h-16" value={(sheet[k] as string) || ''} onChange={(e) => upd(k, e.target.value)} />
              )}
            </Field>
          ))}
          {existing && (
            <p className="text-[11px] text-amber-400">
              {L(`Персонаж «${sheet.name}» уже есть — экспорт обновит его (без дубля).`, `Character "${sheet.name}" already exists — export will update it (no duplicate).`)}
            </p>
          )}
          <div className="flex gap-2 items-center flex-wrap pt-1">
            <label className="text-xs text-gray-400">{L('Роль:', 'Role:')}</label>
            <select className="input !py-1 text-sm !w-auto" value={role} onChange={(e) => setRole(e.target.value as CharacterRole)}>
              <option value="important_character">{L('Важный персонаж', 'Important character')}</option>
              <option value="love_interest">{L('Любовный интерес', 'Love interest')}</option>
              <option value="npc">NPC</option>
            </select>
            <button className="btn-primary !py-1.5 text-sm" onClick={doExport}>
              {L('Добавить как персонажа проекта', 'Add as project character')}
            </button>
            {done && <span className="text-xs text-green-400">✓ {L('добавлено', 'added')}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

function RelationsTab({ gm, patchGm, L }: { gm: GM; patchGm: PatchGm; L: Lf }) {
  const s = usePlayerStore();
  const project = s.project;
  const rel = s.state?.relationship ?? {};
  // Значимые пары с протагонистом: персонажи (не протагонист) с числовыми статами.
  const heroPairs = (project?.characters || []).filter((c) => c.role !== 'protagonist' && rel[c.id]);

  return (
    <div className="space-y-4">
      {/* Пары с протагонистом — числа ❤️🔥🍀 + текстовая динамика (досье GM). */}
      {heroPairs.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs uppercase tracking-wide text-gray-500">
            {L('С протагонистом', 'With the protagonist')}
          </div>
          {heroPairs.map((c) => {
            const r = rel[c.id];
            const gc = gm.characters.find((x) => x.charId === c.id);
            return (
              <div key={c.id} className="rounded-lg bg-panel2 p-2.5">
                <div className="flex items-center gap-3 text-sm">
                  <span className="font-medium flex-1">{c.name}</span>
                  <span className="text-pink-400">❤️{r.affection}</span>
                  <span className="text-orange-400">🔥{r.passion_stat}</span>
                  <span className="text-green-400">🍀{r.friendship}</span>
                  <span className="text-sky-400">🎖{r.respect}</span>
                </div>
                {gc && (
                  <input
                    className="input !py-1 text-xs mt-1.5 w-full"
                    placeholder={L('динамика (кто он герою, как меняется)', 'dynamic (who they are to the hero, how it shifts)')}
                    value={gc.roleToHero}
                    onChange={(e) =>
                      patchGm((g) => {
                        const t = g.characters.find((x) => x.charId === c.id);
                        if (t) t.roleToHero = e.target.value;
                      })
                    }
                  />
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Связи между персонажами (NPC↔NPC) — только текст. */}
      <div className="space-y-2">
        <div className="flex justify-between items-center">
          <div className="text-xs uppercase tracking-wide text-gray-500">{L('Между персонажами', 'Between characters')}</div>
          <button className="btn-ghost !px-3 !py-1 text-xs" onClick={() => patchGm((g) => g.relations.push({ from: '', to: '', label: '' }))}>
            + {L('Связь', 'Edge')}
          </button>
        </div>
        {gm.relations.length === 0 && <p className="text-gray-600 text-sm">—</p>}
        {gm.relations.map((r, i) => (
          <div key={i} className="flex gap-2 items-center">
            <input className="input !py-1 text-sm w-28" placeholder={L('от', 'from')} value={r.from} onChange={(e) => patchGm((g) => (g.relations[i].from = e.target.value))} />
            <span className="text-gray-500">↔</span>
            <input className="input !py-1 text-sm w-28" placeholder={L('к', 'to')} value={r.to} onChange={(e) => patchGm((g) => (g.relations[i].to = e.target.value))} />
            <input className="input !py-1 text-sm flex-1" placeholder={L('характер связи', 'relationship')} value={r.label} onChange={(e) => patchGm((g) => (g.relations[i].label = e.target.value))} />
            <button className="btn-danger !px-2 !py-1 text-xs" onClick={() => patchGm((g) => g.relations.splice(i, 1))}>✕</button>
          </div>
        ))}
      </div>
    </div>
  );
}

function LocationsTab({ gm, patchGm, L }: { gm: GM; patchGm: PatchGm; L: Lf }) {
  const locs = gm.locations || [];
  return (
    <div className="space-y-3">
      <div className="flex justify-between items-center">
        <p className="text-xs text-gray-500">
          {L('Память мест: ИИ дополняет их по ходу, описания остаются непротиворечивыми.',
            'Location memory: the AI fills these in as you play; descriptions stay consistent.')}
        </p>
        <button
          className="btn-ghost !px-3 !py-1 text-xs"
          onClick={() => patchGm((g) => (g.locations ||= []).push({ id: uid('loc'), name: L('Новое место', 'New place'), description: '', tags: [], source: 'manual' }))}
        >
          + {L('Локация', 'Location')}
        </button>
      </div>
      {locs.length === 0 && <p className="text-gray-600 text-sm">—</p>}
      {locs.map((l, i) => (
        <div key={l.id} className="card !p-3 !bg-panel2">
          <div className="flex items-center gap-2 mb-2">
            <input
              className="input !py-1 text-sm font-semibold flex-1"
              value={l.name}
              onChange={(e) => patchGm((g) => (g.locations[i].name = e.target.value))}
            />
            <button className="btn-danger !px-2 !py-1 text-xs" onClick={() => patchGm((g) => g.locations.splice(i, 1))}>✕</button>
          </div>
          <textarea
            className="input !py-1 text-sm h-16"
            placeholder={L('описание места, атмосфера, кто там бывает', 'description, atmosphere, who is there')}
            value={l.description}
            onChange={(e) => patchGm((g) => (g.locations[i].description = e.target.value))}
          />
          <input
            className="input !py-1 text-sm mt-2"
            placeholder={L('теги (через запятую)', 'tags (comma-separated)')}
            value={l.tags.join(', ')}
            onChange={(e) => patchGm((g) => (g.locations[i].tags = e.target.value.split(',').map((t) => t.trim()).filter(Boolean)))}
          />
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

      {/* Живой снапшот состояния — редактируемый (единый источник «где мы сейчас»). */}
      {memory && (
        <div className="space-y-1">
          <h4 className="font-semibold text-sm">{L('Состояние истории (живой снапшот)', 'Story state (living snapshot)')}</h4>
          <p className="text-[11px] text-gray-500">
            {L(
              'Обновляется при каждой свёртке (заменяется целиком). Правьте, если ИИ что-то понял не так — это авторитетное «текущее положение дел» для следующих ходов.',
              'Replaced wholesale on each fold. Edit it if the AI got something wrong — this is the authoritative "where things stand now" for future turns.'
            )}
          </p>
          <textarea
            className="input !py-1 text-xs font-mono h-40"
            placeholder={L('появится после первой свёртки…', 'appears after the first fold…')}
            value={memory.storyState || ''}
            onChange={(e) => patchMemory((m) => { m.storyState = e.target.value; })}
          />
        </div>
      )}

      {/* Журнал эпизодов — хронологический, редактируемый. */}
      {memory && (
        <div className="space-y-2">
          <h4 className="font-semibold text-sm">
            {L('Журнал эпизодов (хронология)', 'Episode log (chronological)')} ({memory.chronicle.length})
          </h4>
          <p className="text-[11px] text-gray-500">
            {L(
              'Каждая свёртка добавляет запись «что произошло за период». Записи уходят в контекст по порядку, от старых к новым, и больше не переписываются.',
              'Each fold appends a "what happened this period" entry. Entries go to context oldest → newest and are never rewritten.'
            )}
          </p>
          {memory.chronicle.length === 0 && <p className="text-gray-600 text-sm">{L('пока нет записей', 'no entries yet')}</p>}
          {memory.chronicle.map((c, i) => (
            <div key={c.id} className="card !p-2 !bg-panel2">
              <div className="flex items-center justify-between text-xs text-gray-500 mb-1">
                <span>
                  {L('Период', 'Period')} {i + 1} · {L('сообщения', 'messages')} {c.fromMsg}–{c.toMsg}
                  {c.atTurn ? ` · ${L('до хода', 'up to turn')} ${c.atTurn}` : ''}
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
      {/* Архив сырых периодов — страховка: из него свёртку можно пересобрать. */}
      {memory && project && <RawArchiveList memory={memory} project={project} patchMemory={patchMemory} L={L} />}

      {!memory && <p className="text-xs text-gray-500">{L('Список свёрток появится во время игры.', 'The compression list appears during play.')}</p>}

      {/* Настройки саммари (проектные) */}
      {project && onPatch && <SummaryConfig project={project} onPatch={onPatch} L={L} />}
    </div>
  );
}

// Архив периодов: сырой текст каждого свёрнутого куска истории. Если свёртка
// вышла плохой или её вовсе нет (сбой саммарайзера), запись пересобирается отсюда.
function RawArchiveList({
  memory,
  project,
  patchMemory,
  L,
}: {
  memory: MemoryState;
  project: Project;
  patchMemory: (m: (mem: MemoryState) => void) => void;
  L: Lf;
}) {
  const [busy, setBusy] = useState<number | null>(null);
  const [err, setErr] = useState<string>('');
  const [open, setOpen] = useState<number | null>(null);
  const restore = usePlayerStore((st) => st.restoreArchivedPeriod);
  if (!memory.rawArchive?.length) return null;

  async function rebuild(i: number) {
    setBusy(i);
    setErr('');
    try {
      const next = await resummarizeArchived(project, memory, i);
      patchMemory((m) => {
        m.chronicle = next.chronicle;
      });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-2">
      <h4 className="font-semibold text-sm">
        {L('Архив периодов (сырой текст)', 'Period archive (raw text)')} ({memory.rawArchive.length})
      </h4>
      <p className="text-[11px] text-gray-500">
        {L(
          'Полный текст каждого свёрнутого куска истории — страховка от потери. «Пересобрать» просит модель сделать выжимку заново. «В историю» возвращает сообщения периода в живой контекст ДОСЛОВНО: так восстанавливается даже то, что пропало из журнала. Учтите, что вернувшиеся сообщения занимают бюджет контекста — после них стоит дать движку свернуть период заново.',
          'The full text of every folded chunk — your safety net. "Rebuild" asks the model to summarize it again. "To history" puts the period back into live context VERBATIM, recovering even what vanished from the log. Restored messages count against the context budget — let the engine fold the period again afterwards.'
        )}
      </p>
      {err && <p className="text-xs text-red-400">{err}</p>}
      {memory.rawArchive.map((chunk, i) => {
        const has = memory.chronicle.some((c) => c.atTurn === chunk.turn);
        return (
          <div key={`${chunk.turn}-${i}`} className="card !p-2 !bg-panel2">
            <div className="flex items-center gap-2 text-xs text-gray-500">
              <span>
                {L('до хода', 'up to turn')} {chunk.turn} · {Math.round(chunk.text.length / 1000)}k {L('симв.', 'chars')}
              </span>
              {!has && (
                <span className="text-amber-400">· {L('записи в журнале нет', 'no log entry')}</span>
              )}
              <button className="btn-ghost !px-2 !py-0.5 text-xs ml-auto" onClick={() => setOpen(open === i ? null : i)}>
                {open === i ? L('скрыть', 'hide') : L('текст', 'text')}
              </button>
              <button className="btn-ghost !px-2 !py-0.5 text-xs" disabled={busy !== null} onClick={() => rebuild(i)}>
                {busy === i ? '…' : `↻ ${has ? L('пересобрать', 'rebuild') : L('восстановить', 'restore')}`}
              </button>
              <button
                className="btn-ghost !px-2 !py-0.5 text-xs"
                title={L(
                  'Вернуть сообщения этого периода в живую историю — ИИ снова увидит их дословно',
                  'Put this period back into live history — the AI will see it verbatim again'
                )}
                onClick={() => restore(i)}
              >
                ⤴ {L('в историю', 'to history')}
              </button>
            </div>
            {open === i && (
              <pre className="mt-1.5 max-h-48 overflow-y-auto scrollbar-thin whitespace-pre-wrap text-[11px] text-gray-300">
                {chunk.text}
              </pre>
            )}
          </div>
        );
      })}
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
      <Field label={L(`Лимит «мелких событий» в саммари: ${mc.minorEventsLimit ?? 10}`, `Minor-events limit in summary: ${mc.minorEventsLimit ?? 10}`)}>
        <input
          type="number"
          min={3}
          max={40}
          className="input w-24"
          value={mc.minorEventsLimit ?? 10}
          onChange={(e) => patchMem({ minorEventsLimit: Math.max(3, Math.min(40, Number(e.target.value) || 10)) })}
        />
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

// Селектор ассетов (Batch 5.4): источник выбора emotion/наряда/музыки — основной
// (как сейчас), отдельное дешёвое подключение, или локальная модель в браузере.
function SelectorTab({ project, onPatch, L }: { project?: Project | null; onPatch?: (m: (p: Project) => void) => void; L: Lf }) {
  if (!project || !onPatch) return <p className="text-sm text-gray-400">{L('Откройте проект.', 'Open a project.')}</p>;
  const cfg = project.aiConfig.assetSelector || { source: 'main' as const };
  const setSource = (source: AssetSelectorSource) =>
    onPatch((p) => {
      const g = getConnection();
      p.aiConfig.assetSelector = {
        source,
        customApi:
          source === 'custom'
            ? p.aiConfig.assetSelector?.customApi || { provider: g.provider, baseUrl: g.baseUrl, model: g.model }
            : undefined,
      };
    });
  const options: { id: AssetSelectorSource; label: string; hint: string }[] = [
    { id: 'main', label: L('Основной', 'Main'), hint: L('Ассеты выбирает сам Рассказчик (как сейчас).', 'The Narrator picks assets itself (as now).') },
    { id: 'custom', label: L('Отдельный API', 'Separate API'), hint: L('Дешёвая/быстрая модель только для выбора ассетов.', 'A cheap/fast model just for asset selection.') },
    { id: 'local', label: L('Локальная', 'Local'), hint: L('Модель MiniLM в браузере (Web Worker), ничего наружу.', 'MiniLM model in-browser (Web Worker), nothing leaves the device.') },
  ];
  return (
    <div>
      <p className="text-xs text-gray-500 mb-3">
        {L(
          'Выбор эмоции (из 11), наряда и музыкального настроения — задача классификации из закрытого списка. Её можно снять с дорогого основного запроса. Эмоции остаются закрытым словарём; невалидный ответ селектора не крашит игру (откат к выбору Рассказчика).',
          'Picking emotion (of 11), outfit and music mood is closed-list classification. It can be offloaded from the expensive main request. Emotions stay a closed vocabulary; an invalid selector reply never crashes the game (falls back to the Narrator\'s choice).'
        )}
      </p>
      <div className="flex gap-2 mb-3 flex-wrap">
        {options.map((o) => (
          <button key={o.id} className={`chip !px-3 !py-1.5 ${cfg.source === o.id ? 'bg-accent2 text-white' : ''}`} onClick={() => setSource(o.id)}>
            {o.label}
          </button>
        ))}
      </div>
      <p className="text-xs text-gray-500 mb-3">{options.find((o) => o.id === cfg.source)?.hint}</p>
      {cfg.source === 'custom' && (
        <ApiConnectionField
          conn={cfg.customApi || { provider: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', model: '' }}
          keyRole="assetSelector"
          onChange={(conn) => onPatch((p) => { if (p.aiConfig.assetSelector) p.aiConfig.assetSelector.customApi = conn; })}
        />
      )}
    </div>
  );
}

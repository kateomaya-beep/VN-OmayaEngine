import { useEffect, useMemo, useState } from 'react';
import { usePlayerStore } from '../player/playerStore';
import { useChapterJob, runChapterJob, stopChapterJob, countUnits } from '../player/chapterJob';
import { chaptersOf, isLiveChapter, trackedCharacters } from '../../ai/chapters';
import { selectMemory } from '../../ai/promptBuilder';
import { uid } from '../../shared/utils';
import type { ArcStage, MemoryBookEntry, MemoryEntryKind, MemoryEntryMode, MemoryState, Project } from '../../shared/types';

type Lf = (ru: string, en: string) => string;

// МЕМОРИБУК В ИГРЕ — «лорбук случившегося». Главы кладёт свёртка памяти, записи
// можно заводить руками или просить ассистента. Каждая запись видит, уходит ли
// она модели на этом ходу и почему: целиком как свежая глава, по какому ключу,
// только строкой оглавления или никак.

const MODE_LABEL: Record<MemoryEntryMode, [string, string]> = {
  constant: ['Постоянная', 'Constant'],
  keyword: ['По ключам', 'By keywords'],
  off: ['Выкл', 'Off'],
};
const KIND_LABEL: Record<MemoryEntryKind, [string, string, string]> = {
  chapter: ['Глава', 'Chapter', '📜'],
  event: ['Событие', 'Event', '✦'],
  fact: ['Факт', 'Fact', '📌'],
};

function turnsOf(e: MemoryBookEntry, L: Lf): string {
  const msgs =
    typeof e.fromMsg === 'number' && typeof e.toMsg === 'number' ? ` (${e.toMsg - e.fromMsg + 1} ${L('сообщ.', 'msgs')})` : '';
  if (e.fromTurn && e.toTurn)
    return (e.fromTurn === e.toTurn ? `${L('ход', 'turn')} ${e.toTurn}` : `${L('ходы', 'turns')} ${e.fromTurn}–${e.toTurn}`) + msgs;
  return e.turn ? `${L('ход', 'turn')} ${e.turn}${msgs}` : '';
}

function JobBar({ L }: { L: Lf }) {
  const job = useChapterJob();
  if (!job.running) return null;
  const pct = job.total ? Math.round((job.done / job.total) * 100) : 0;
  return (
    <div className="card !bg-panel2 !p-2.5 space-y-1.5">
      <div className="flex items-center gap-2 text-xs">
        <span className="text-gray-300">
          {job.label}: {job.done} {L('из', 'of')} {job.total}
          {job.failed ? ` · ${L('не вышло', 'failed')} ${job.failed}` : ''}
        </span>
        <button className="btn-ghost !px-2 !py-0.5 text-xs ml-auto" disabled={job.stop} onClick={stopChapterJob}>
          {job.stop ? L('останавливаю…', 'stopping…') : `■ ${L('Остановить', 'Stop')}`}
        </button>
      </div>
      <div className="h-1.5 rounded-full bg-white/10 overflow-hidden">
        <div className="h-full bg-emerald-500" style={{ width: `${pct}%` }} />
      </div>
      <p className="text-[11px] text-gray-500">
        {L(
          'Каждая глава сохраняется сразу. Остановили или закрыли вкладку — повторный запуск продолжит с того же места. Играть во время сборки можно.',
          'Each chapter is saved right away. Stop or close the tab — running again resumes where it left off. You can keep playing meanwhile.'
        )}
      </p>
    </div>
  );
}

function EntryEditor({
  entry,
  number,
  status,
  memory,
  L,
}: {
  entry: MemoryBookEntry;
  number: number;
  status: { tone: string; text: string };
  memory: MemoryState;
  L: Lf;
}) {
  const patchMemory = usePlayerStore((s) => s.patchMemory);
  const running = useChapterJob((s) => s.running);
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(entry.title);
  const [text, setText] = useState(entry.text);
  const [keys, setKeys] = useState(entry.keys.join(', '));
  const [gist, setGist] = useState(entry.gist || '');
  // Запись поменялась снаружи (пересборка, ассистент) — подтягиваем. Пока вы
  // печатаете, запись не меняется: сохранение идёт по уходу из поля.
  const keysJoined = entry.keys.join(', ');
  useEffect(() => setTitle(entry.title), [entry.title]);
  useEffect(() => setText(entry.text), [entry.text]);
  useEffect(() => setKeys(keysJoined), [keysJoined]);
  useEffect(() => setGist(entry.gist || ''), [entry.gist]);
  // Правки копятся локально и сохраняются по уходу из поля: каждое нажатие клавиши
  // иначе переписывало бы всю память и сохранение игры.
  const save = (p: Partial<MemoryBookEntry>) =>
    patchMemory((m) => {
      const i = m.memorybook.findIndex((x) => x.id === entry.id);
      if (i >= 0) m.memorybook[i] = { ...m.memorybook[i], ...p };
    });
  const archiveIndex = entry.archiveTurn ? memory.rawArchive.findIndex((c) => c.turn === entry.archiveTurn) : -1;
  const canRebuild = entry.kind === 'chapter' && (archiveIndex >= 0 || (entry.fromTurn && entry.toTurn));

  return (
    <div className={`card !p-2 !bg-panel2 ${entry.mode === 'off' ? 'opacity-60' : ''}`}>
      <button className="w-full flex items-start gap-2 text-left" onClick={() => setOpen(!open)}>
        <span className="shrink-0">{KIND_LABEL[entry.kind][2]}</span>
        <span className="flex-1 min-w-0">
          <span className="block text-sm text-gray-200 truncate">
            {entry.kind === 'chapter' && number ? <span className="text-gray-500">{number}. </span> : null}
            {entry.title || L('(без названия)', '(untitled)')}
          </span>
          <span className="block text-[11px] text-gray-500 truncate">
            {[turnsOf(entry, L), entry.dates, entry.keys.length ? `🔑 ${entry.keys.join(', ')}` : ''].filter(Boolean).join(' · ')}
          </span>
        </span>
        <span className="shrink-0 flex flex-col items-end gap-0.5">
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/10 text-gray-300">{L(...MODE_LABEL[entry.mode])}</span>
          <span className={`text-[10px] ${status.tone}`}>{status.text}</span>
        </span>
      </button>

      {open && (
        <div className="mt-2 space-y-2">
          <div className="flex flex-wrap gap-1">
            {(['constant', 'keyword', 'off'] as MemoryEntryMode[]).map((m) => (
              <button
                key={m}
                className={`chip !px-2.5 !py-1 text-xs ${entry.mode === m ? 'bg-accent2 text-white' : ''}`}
                onClick={() => save({ mode: m })}
              >
                {L(...MODE_LABEL[m])}
              </button>
            ))}
            <select
              className="input !py-1 !w-auto text-xs ml-auto"
              value={entry.kind}
              onChange={(e) => save({ kind: e.target.value as MemoryEntryKind })}
            >
              {(['chapter', 'event', 'fact'] as MemoryEntryKind[]).map((k) => (
                <option key={k} value={k}>
                  {KIND_LABEL[k][2]} {L(KIND_LABEL[k][0], KIND_LABEL[k][1])}
                </option>
              ))}
            </select>
          </div>
          <input
            className="input !py-1 text-sm"
            value={title}
            placeholder={L('Название', 'Title')}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => title !== entry.title && save({ title })}
          />
          <input
            className="input !py-1 text-xs"
            value={keys}
            placeholder={L('Ключи через запятую: имена, места, предметы — как в тексте игры', 'Keys, comma-separated: names, places, objects — as written in the story')}
            onChange={(e) => setKeys(e.target.value)}
            onBlur={() => {
              const next = keys.split(',').map((k) => k.trim()).filter(Boolean);
              if (next.join('|') !== entry.keys.join('|')) save({ keys: next });
            }}
          />
          {entry.kind === 'chapter' && (
            <input
              className="input !py-1 text-xs"
              value={gist}
              placeholder={L('Суть одной строкой — для оглавления', 'One-line gist — for the chapter index')}
              onChange={(e) => setGist(e.target.value)}
              onBlur={() => gist !== (entry.gist || '') && save({ gist })}
            />
          )}
          <textarea
            className="input !py-1 text-sm h-40"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onBlur={() => text !== entry.text && save({ text })}
          />
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-gray-500">
            <span>
              {entry.source === 'legacy'
                ? L('из старого журнала (до глав): текст может быть пережат', 'from the old log (pre-chapters): may be over-compressed')
                : entry.source === 'assistant'
                  ? L('внёс ассистент', 'added by the assistant')
                  : entry.source === 'manual'
                    ? L('ваша запись', 'your entry')
                    : L('собрана движком', 'built by the engine')}
            </span>
            {canRebuild && (
              <button
                className="btn-ghost !px-2 !py-0.5 text-xs ml-auto"
                disabled={running}
                title={L('Собрать главу заново по дословному тексту периода', 'Rebuild the chapter from the verbatim text of its period')}
                onClick={() =>
                  void runChapterJob(
                    archiveIndex >= 0
                      ? { kind: 'chunk', archiveIndex }
                      : { kind: 'range', fromTurn: entry.fromTurn!, toTurn: entry.toTurn!, replaceIds: [entry.id] }
                  )
                }
              >
                ↻ {L('пересобрать', 'rebuild')}
              </button>
            )}
            <button
              className={`btn-danger !px-2 !py-0.5 text-xs ${canRebuild ? '' : 'ml-auto'}`}
              onClick={() => {
                if (!confirm(L('Удалить запись из меморибука?', 'Delete this memorybook entry?'))) return;
                patchMemory((m) => {
                  m.memorybook = m.memorybook.filter((x) => x.id !== entry.id);
                  m.arcs = (m.arcs || []).map((a) => ({ ...a, stages: a.stages.filter((s) => s.chapterId !== entry.id) }));
                });
              }}
            >
              ✕ {L('удалить', 'delete')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function MemorybookTab({
  project,
  onPatch,
  L,
}: {
  project?: Project | null;
  onPatch?: (m: (p: Project) => void) => void;
  L: Lf;
}) {
  const state = usePlayerStore((s) => s.state);
  const patchMemory = usePlayerStore((s) => s.patchMemory);
  const running = useChapterJob((s) => s.running);
  const [filter, setFilter] = useState<'all' | MemoryEntryKind>('all');
  const [q, setQ] = useState('');

  const sel = useMemo(
    () => (project && state ? selectMemory(project, state, '') : null),
    [project, state]
  );
  // Сколько глав собрала бы каждая кнопка. Считается по всему архиву — только
  // когда меняется память, а не на каждую перерисовку.
  const todo = useMemo(
    () =>
      running || !state
        ? { archive: 0, fill: 0, regroup: 0 }
        : {
            archive: countUnits({ kind: 'archive' }),
            fill: countUnits({ kind: 'fill' }),
            regroup: countUnits({ kind: 'archive', rebuildAll: true }),
          },
    [running, state?.memory, state?.history.length, project?.memoryConfig.chapterSize]
  );
  if (!project || !state || !sel) {
    return <p className="text-sm text-gray-500">{L('Меморибук появляется во время игры.', 'The memorybook appears during play.')}</p>;
  }
  const memory = state.memory;
  const numbers = sel.numbers;
  const fullIds = new Set(sel.recent.map((c) => c.id));
  const triggered = new Map(sel.pick.triggered.map((t) => [t.entry.id, t.keys] as const));
  const constIds = new Set(sel.pick.constant.map((e) => e.id));
  const skipped = new Set(sel.pick.skipped.map((e) => e.id));

  const statusOf = (e: MemoryBookEntry): { tone: string; text: string } => {
    if (e.mode === 'off') return { tone: 'text-gray-600', text: L('не уходит', 'not sent') };
    if (isLiveChapter(e, memory)) return { tone: 'text-gray-500', text: L('ходы ещё в живой истории', 'turns still live') };
    if (fullIds.has(e.id)) return { tone: 'text-emerald-400', text: L('целиком (свежая)', 'in full (recent)') };
    if (constIds.has(e.id)) return { tone: 'text-emerald-400', text: L('целиком (постоянная)', 'in full (constant)') };
    const keys = triggered.get(e.id);
    if (keys) return { tone: 'text-emerald-400', text: `${L('по ключу', 'by key')}: ${keys.join(', ')}` };
    if (skipped.has(e.id)) return { tone: 'text-amber-400', text: L('ключ есть, не влезла', 'key hit, over budget') };
    if (e.kind === 'chapter') return { tone: 'text-gray-500', text: L('строкой оглавления', 'index line') };
    return { tone: 'text-gray-600', text: e.keys.length ? L('ждёт ключа', 'waiting for a key') : L('нет ключей', 'no keys') };
  };

  const chapters = chaptersOf(memory);
  const others = memory.memorybook.filter((e) => e.kind !== 'chapter').sort((a, b) => a.turn - b.turn);
  const all = [...chapters, ...others].filter((e) => filter === 'all' || e.kind === filter);
  const needle = q.trim().toLowerCase();
  const shown = needle
    ? all.filter((e) => `${e.title}\n${e.text}\n${e.keys.join(' ')}`.toLowerCase().includes(needle))
    : all;

  const archiveTodo = todo.archive;
  const fillTodo = todo.fill;
  const legacy = memory.memorybook.filter((e) => e.source === 'legacy' && e.mode !== 'off').length;
  // Главы-огрызки (собраны до того, как глава стала копиться до размера): их
  // укрупняет пересборка из архива. Последнюю — открытую — не считаем.
  const size = project.memoryConfig.chapterSize ?? 12;
  const realChapters = chapters.filter((c) => c.source !== 'legacy' && c.mode !== 'off' && typeof c.fromMsg === 'number');
  const small = realChapters
    .slice(0, -1)
    .filter((c) => c.toMsg! - c.fromMsg! + 1 < size * 0.6 && c.toMsg! <= memory.foldedMsgCount).length;
  const mbTokens = sel.pick.tokens;

  return (
    <div className="space-y-3">
      <p className="text-xs text-gray-500">
        {L(
          'Лорбук того, что уже случилось. Каждая свёртка памяти кладёт сюда главу — с названием, ключами и диапазоном ходов, — и главы больше никогда не пережимаются. Модели всегда уходят оглавление всех глав и свежие главы целиком, а старая глава приходит полностью, когда в сцене всплывает её ключ. Режимы — как в лорбуке: постоянная (всегда), по ключам, выкл.',
          'A lorebook of what has already happened. Every memory fold adds a chapter here — title, keys, turn range — and chapters are never re-compressed. The model always gets the index of all chapters and the recent ones in full; an older chapter comes back in full when its key shows up in the scene. Modes work like the lorebook: constant, by keywords, off.'
        )}
      </p>

      <JobBar L={L} />

      <div className="card !bg-panel2 !p-2.5 text-xs space-y-1">
        <div className="flex flex-wrap justify-between gap-x-2">
          <span className="text-gray-500">{L('Блок «Память»', 'Memory block')}</span>
          <span className="text-gray-300 text-right ml-auto">
            {L('оглавление', 'index')}: {sel.tocCount} · {L('целиком', 'in full')}: {sel.recent.length} · ~{sel.memoryTokens.toLocaleString()} / {sel.budgets.memory.toLocaleString()} {L('ток.', 'tok.')}
          </span>
        </div>
        <div className="flex flex-wrap justify-between gap-x-2">
          <span className="text-gray-500">{L('Блок «Меморибук»', 'Memorybook block')}</span>
          <span className="text-gray-300 text-right ml-auto">
            {L('постоянных', 'constant')}: {sel.pick.constant.length} · {L('по ключам', 'by key')}: {sel.pick.triggered.length} · ~{mbTokens.toLocaleString()} / {sel.budgets.memorybook.toLocaleString()} {L('ток.', 'tok.')}
          </span>
        </div>
        <p className="text-[11px] text-gray-600">
          {L(
            'Ключи проверяются по последним сообщениям и вашему ходу — статусы ниже показаны на момент перед следующим ходом. Бюджеты — доли «Бюджета контекста» в пресете. Где в запросе стоят блоки, решает порядок в пресете: блок «Меморибук» можно опустить под историю, ближе к ходу.',
            'Keys are checked against the latest messages and your move — statuses below are as of right before the next turn. Budgets are shares of the preset context budget. Block placement follows the preset order: the Memorybook block can be moved below the history, closer to the move.'
          )}
        </p>
        {onPatch && (
          <label className="flex items-center gap-2 text-[11px] text-gray-400 pt-1">
            {L('Глубина поиска ключей: последних сообщений', 'Key scan depth: last messages')}
            <input
              type="number"
              min={1}
              max={40}
              className="input !py-0.5 !w-16 text-xs"
              value={project.memoryConfig.memorybookScanDepth ?? 6}
              onChange={(e) =>
                onPatch((p) => {
                  p.memoryConfig.memorybookScanDepth = Math.max(1, Math.min(40, Number(e.target.value) || 6));
                })
              }
            />
          </label>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          className="btn-ghost !px-2.5 !py-1 text-xs"
          onClick={() =>
            patchMemory((m) => {
              m.memorybook.push({
                id: uid('mem'),
                kind: 'event',
                title: L('Новая запись', 'New entry'),
                text: '',
                keys: [],
                mode: 'keyword',
                turn: state.turnCount,
                source: 'manual',
              });
            })
          }
        >
          + {L('Запись', 'Entry')}
        </button>
        {(archiveTodo > 0 || legacy > 0) && (
          <button
            className="btn-primary !px-2.5 !py-1 text-xs"
            disabled={running || !archiveTodo}
            title={L(
              'Собрать главы по дословному тексту свёрнутых периодов. Старые записи журнала, которые новые главы покроют, выключатся (не удалятся).',
              'Build chapters from the verbatim text of folded periods. Old log entries covered by the new chapters are switched off (not deleted).'
            )}
            onClick={() => void runChapterJob({ kind: 'archive' })}
          >
            ↻ {L('Восстановить главы из архива', 'Restore chapters from archive')} ({archiveTodo})
          </button>
        )}
        {small >= 2 && todo.regroup > 0 && todo.regroup < realChapters.length && (
          <button
            className="btn-primary !px-2.5 !py-1 text-xs"
            disabled={running}
            title={L(
              `Собрать главы заново по дословному тексту архива — по ~${size} сообщений на главу. Мелкие главы заменятся крупными.`,
              `Rebuild chapters from the verbatim archive — ~${size} messages per chapter. Small chapters get replaced by larger ones.`
            )}
            onClick={() => void runChapterJob({ kind: 'archive', rebuildAll: true })}
          >
            ⇲ {L('Пересобрать главы крупнее', 'Rebuild into larger chapters')} ({realChapters.length} → ~{todo.regroup})
          </button>
        )}
        {/* «С нуля» — когда памяти не было вовсе. В обычной игре живая история по
            определению ещё не описана главами, и кнопка висела бы всегда. */}
        {fillTodo > 0 && !chapters.some((c) => c.source !== 'legacy') && (
          <button
            className="btn-ghost !px-2.5 !py-1 text-xs"
            disabled={running}
            title={L(
              'Описать главами всё, что ещё не описано: архив и живую историю, кроме текущей сцены.',
              'Cover with chapters everything not yet covered: the archive and live history, except the current scene.'
            )}
            onClick={() => void runChapterJob({ kind: 'fill' })}
          >
            ✦ {L('Заполнить с нуля', 'Fill from scratch')} ({fillTodo})
          </button>
        )}
      </div>
      {legacy > 0 && archiveTodo === 0 && (
        <p className="text-[11px] text-gray-500">
          {L(
            `${legacy} записей перенесены из старого журнала эпизодов. Сырого архива этих периодов нет, поэтому пересобрать их нечем: дайте им ключи или поправьте текст вручную — или попросите ассистента.`,
            `${legacy} entries came from the old episode log. There is no raw archive for those periods to rebuild from: give them keys or edit them by hand — or ask the assistant.`
          )}
        </p>
      )}
      {legacy > 0 && archiveTodo > 0 && (
        <p className="text-[11px] text-amber-400/90">
          {L(
            `${legacy} записей перенесены из старого журнала эпизодов: их текст мог быть пережат повторными уплотнениями, ключей у них нет. «Восстановить главы из архива» соберёт нормальные главы по дословному тексту — старые записи при этом выключатся.`,
            `${legacy} entries came from the old episode log: their text may be over-compressed and they have no keys. "Restore chapters from archive" rebuilds proper chapters from verbatim text and switches the old ones off.`
          )}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-1">
        {(['all', 'chapter', 'event', 'fact'] as const).map((f) => (
          <button
            key={f}
            className={`chip !px-2.5 !py-1 text-xs ${filter === f ? 'bg-accent2 text-white' : ''}`}
            onClick={() => setFilter(f)}
          >
            {f === 'all' ? L('Все', 'All') : `${KIND_LABEL[f][2]} ${L(KIND_LABEL[f][0], KIND_LABEL[f][1])}`}
          </button>
        ))}
        <input
          className="input !py-1 text-xs flex-1 min-w-[8rem]"
          placeholder={L('поиск…', 'search…')}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      {shown.length === 0 && (
        <p className="text-sm text-gray-600">
          {memory.memorybook.length
            ? L('Ничего не найдено.', 'Nothing found.')
            : L('Пока пусто. Первая глава появится при первой свёртке памяти.', 'Empty so far. The first chapter appears at the first memory fold.')}
        </p>
      )}
      <div className="space-y-2">
        {shown.map((e) => (
          <EntryEditor
            key={e.id}
            entry={e}
            number={numbers.get(e.id) || 0}
            status={statusOf(e)}
            memory={memory}
            L={L}
          />
        ))}
      </div>
    </div>
  );
}

// ---- Эволюция персонажей ----------------------------------------------------

function StageEditor({ arcName, stage, L }: { arcName: string; stage: ArcStage; L: Lf }) {
  const patchMemory = usePlayerStore((s) => s.patchMemory);
  const [f, setF] = useState({ label: stage.label, change: stage.change, cause: stage.cause, now: stage.now, turn: String(stage.turn) });
  const save = () =>
    patchMemory((m) => {
      const arc = (m.arcs || []).find((a) => a.name === arcName);
      const st = arc?.stages.find((x) => x.id === stage.id);
      if (!arc || !st) return;
      Object.assign(st, { label: f.label, change: f.change, cause: f.cause, now: f.now, turn: Number(f.turn) || st.turn });
      arc.stages.sort((a, b) => a.turn - b.turn);
    });
  const field = (k: keyof typeof f, ph: string, area = false) =>
    area ? (
      <textarea
        className="input !py-1 text-xs h-14"
        placeholder={ph}
        value={f[k]}
        onChange={(e) => setF({ ...f, [k]: e.target.value })}
        onBlur={save}
      />
    ) : (
      <input className="input !py-1 text-xs" placeholder={ph} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} onBlur={save} />
    );
  return (
    <div className="border-l-2 border-accent2/40 pl-2 space-y-1">
      <div className="flex gap-1">
        <input
          className="input !py-1 text-xs w-16"
          title={L('ход', 'turn')}
          value={f.turn}
          onChange={(e) => setF({ ...f, turn: e.target.value })}
          onBlur={save}
        />
        {field('label', L('этап: «осторожный интерес»', 'stage: "cautious interest"'))}
        <button
          className="btn-danger !px-2 !py-0.5 text-xs"
          onClick={() =>
            patchMemory((m) => {
              const arc = (m.arcs || []).find((a) => a.name === arcName);
              if (arc) arc.stages = arc.stages.filter((x) => x.id !== stage.id);
            })
          }
        >
          ✕
        </button>
      </div>
      {field('change', L('что в нём изменилось', 'what changed in them'), true)}
      {field('cause', L('из-за чего', 'because of'))}
      {field('now', L('кто он теперь (1–2 предложения)', 'who they are now (1–2 sentences)'), true)}
      {stage.dates && <p className="text-[10px] text-gray-600">{stage.dates}</p>}
    </div>
  );
}

export function ArcsTab({ project, L }: { project?: Project | null; L: Lf }) {
  const state = usePlayerStore((s) => s.state);
  const patchMemory = usePlayerStore((s) => s.patchMemory);
  const [open, setOpen] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  if (!project || !state) {
    return <p className="text-sm text-gray-500">{L('Лента появляется во время игры.', 'The timeline appears during play.')}</p>;
  }
  const memory = state.memory;
  const tracked = trackedCharacters(project, memory);
  const arcOf = (name: string, charId?: string) =>
    (memory.arcs || []).find((a) => (charId && a.charId === charId) || a.name.toLowerCase() === name.toLowerCase());
  const ensureArc = (m: MemoryState, name: string, charId?: string) => {
    m.arcs ||= [];
    let a = m.arcs.find((x) => (charId && x.charId === charId) || x.name.toLowerCase() === name.toLowerCase());
    if (!a) {
      a = { name, charId, stages: [] };
      m.arcs.push(a);
    }
    return a;
  };

  return (
    <div className="space-y-3">
      <p className="text-xs text-gray-500">
        {L(
          'Как история меняет любовные интересы и важных персонажей. Анкета — это человек на старте; лента — кем он стал. Модели уходит «кто он сейчас» и путь по этапам, анкета остаётся основой. Этапы добавляет свёртка памяти по прозе периода, а «Восстановить главы из архива» соберёт ленту за всю историю.',
          'How the story changes love interests and important characters. The sheet is who they were at the start; the timeline is who they became. The model gets "who they are now" and the path of stages, with the sheet as the base. Stages are added by memory folds from the prose; "Restore chapters from archive" rebuilds the timeline for the whole story.'
        )}
      </p>
      {tracked.length === 0 && (
        <p className="text-sm text-gray-600">
          {L(
            'Отслеживаются персонажи с ролью «любовный интерес» и «важный персонаж». Назначьте роль в конструкторе или добавьте персонажа ниже.',
            'Characters with the "love interest" or "important character" role are tracked. Set the role in the constructor or add someone below.'
          )}
        </p>
      )}
      {tracked.map((t) => {
        const arc = arcOf(t.name, t.charId);
        const stages = arc?.stages || [];
        const last = stages[stages.length - 1];
        const key = t.charId || t.name;
        return (
          <div key={key} className="card !p-2.5 !bg-panel2 space-y-1.5">
            <button className="w-full text-left" onClick={() => setOpen(open === key ? null : key)}>
              <div className="flex items-center gap-2">
                <span className="font-semibold text-sm">{t.name}</span>
                <span className="text-[11px] text-gray-500">{stages.length} {L('этап(ов)', 'stage(s)')}</span>
                <span className="ml-auto text-xs text-gray-500">{open === key ? '▾' : '▸'}</span>
              </div>
              {stages.length > 0 ? (
                <>
                  <div className="flex flex-wrap items-center gap-1 mt-1">
                    {stages.map((s, i) => (
                      <span key={s.id} className="flex items-center gap-1">
                        {i > 0 && <span className="text-gray-600 text-xs">→</span>}
                        <span
                          className={`text-[11px] px-1.5 py-0.5 rounded ${i === stages.length - 1 ? 'bg-accent2/80 text-white' : 'bg-white/10 text-gray-300'}`}
                        >
                          {s.label}
                        </span>
                      </span>
                    ))}
                  </div>
                  <p className="text-xs text-gray-300 mt-1">
                    <span className="text-gray-500">{L('Сейчас', 'Now')}: </span>
                    {last.now || last.change}
                  </p>
                </>
              ) : (
                <p className="text-[11px] text-gray-600 mt-1">{L('пока как в анкете', 'as in the sheet so far')}</p>
              )}
            </button>
            {open === key && (
              <div className="space-y-2 pt-1">
                {stages.map((s) => (
                  <StageEditor key={s.id + s.label + s.turn} arcName={arc!.name} stage={s} L={L} />
                ))}
                <div className="flex gap-2">
                  <button
                    className="btn-ghost !px-2 !py-0.5 text-xs"
                    onClick={() =>
                      patchMemory((m) => {
                        const a = ensureArc(m, t.name, t.charId);
                        a.stages.push({
                          id: uid('arc'),
                          turn: state.turnCount,
                          label: L('новый этап', 'new stage'),
                          change: '',
                          cause: '',
                          now: '',
                          source: 'manual',
                        });
                      })
                    }
                  >
                    + {L('этап вручную', 'add stage')}
                  </button>
                  {arc && !t.sheet && (
                    <button
                      className="btn-ghost !px-2 !py-0.5 text-xs ml-auto"
                      onClick={() =>
                        confirm(L('Перестать отслеживать и удалить ленту?', 'Stop tracking and delete the timeline?')) &&
                        patchMemory((m) => {
                          m.arcs = (m.arcs || []).filter((a) => a.name !== arc.name);
                        })
                      }
                    >
                      {L('не отслеживать', 'untrack')}
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        );
      })}
      <div className="flex gap-2">
        <input
          className="input !py-1 text-xs flex-1"
          placeholder={L('Имя — как в истории', 'Name as in the story')}
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
        />
        <button
          className="btn-ghost !px-2.5 !py-1 text-xs"
          disabled={!newName.trim()}
          onClick={() => {
            const name = newName.trim();
            patchMemory((m) => {
              ensureArc(m, name);
            });
            setNewName('');
          }}
        >
          + {L('Отслеживать', 'Track')}
        </button>
      </div>
    </div>
  );
}

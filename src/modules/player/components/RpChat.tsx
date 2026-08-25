import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { usePlayerStore } from '../playerStore';
import { Console } from './Console';
import { Markdown } from '../../../shared/markdown';
import { stripMoveTag } from '../../../ai/responseParser';
import { stripStateBlock } from '../../../ai/rpResponse';
import { protagonistName } from '../../../ai/macros';

// ЛЕНТА ПЕРЕПИСКИ — экран режима «классический РП».
//
// Показывает то же самое, что уходит в контекст: state.history. Никакого второго
// хранилища у чата нет намеренно — иначе экран и промпт разъезжались бы после
// правки сообщения, свёртки памяти или загрузки сейва.
//
// Сообщения свёрнутые в память здесь не видны: они физически удалены из истории и
// живут в журнале эпизодов (Game Master → Память). Так и должно быть — лента
// показывает ровно то, что модель ещё помнит дословно.

export function RpChat({
  hasNotes,
  onOpenNotes,
}: {
  hasNotes: boolean;
  onOpenNotes: () => void;
}) {
  const s = usePlayerStore();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [editText, setEditText] = useState('');

  const state = s.state;
  const project = s.project;
  const history = state?.history ?? [];
  const lastIndex = history.length - 1;

  // Прокрутка вниз при новом сообщении и на время генерации. useLayoutEffect, а не
  // useEffect: иначе кадр между версткой и прокруткой видно как рывок вверх.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [history.length, s.thinking, s.pendingMove]);

  // Правка закрывается сама, если сообщение исчезло (реролл, свёртка, загрузка сейва) —
  // иначе открытая форма начала бы редактировать чужой текст под тем же индексом.
  useEffect(() => {
    if (editing !== null && editing >= history.length) setEditing(null);
  }, [history.length, editing]);

  if (!project || !state) return null;

  const heroName = protagonistName(project, state);
  // Ответ ИИ — это целая сцена с несколькими персонажами, а не реплика одного бота,
  // как в карточке Таверны. Подписывать её именем персонажа было бы враньём.
  const narratorName = 'Рассказчик';

  const startEdit = (i: number, text: string) => {
    setEditing(i);
    setEditText(text);
  };
  const commitEdit = () => {
    if (editing === null) return;
    s.editHistoryMessage(editing, editText);
    setEditing(null);
  };

  return (
    <div className="absolute inset-0 pt-14 flex flex-col">
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 sm:px-4 py-5">
        <div className="max-w-3xl mx-auto space-y-4">
          {history.length === 0 && !s.pendingMove && (
            <p className="text-center text-sm text-gray-500 py-10">
              История пустая. Напишите первую реплику — или нажмите ▶ в строке ввода, и мир начнёт сам.
            </p>
          )}

          {history.map((m, i) => {
            const mine = m.role === 'user';
            // В историю ход игрока кладётся с технической пометкой ([VERBATIM] и др.):
            // модели она нужна, игроку — нет.
            const text = mine ? stripMoveTag(m.content) : stripStateBlock(m.content);
            return (
              <Message
                key={i}
                mine={mine}
                who={mine ? heroName : narratorName}
                text={text}
                editing={editing === i}
                editText={editText}
                onEditText={setEditText}
                onStartEdit={() => startEdit(i, m.content)}
                onCommitEdit={commitEdit}
                onCancelEdit={() => setEditing(null)}
                onDelete={() => {
                  if (confirm('Удалить это сообщение из истории? Модель перестанет его помнить.'))
                    s.deleteHistoryMessage(i);
                }}
                // Перегенерировать можно только последний ответ: реролл откатывает
                // ровно один ход, для середины ленты у движка нет снимка состояния.
                onRegenerate={!mine && i === lastIndex && !s.thinking ? () => s.regenerate() : undefined}
                busy={s.thinking}
              />
            );
          })}

          {/* Отправленный ход, пока идёт генерация: в историю он попадёт только вместе
              с ответом, а исчезать с экрана на полминуты ему нельзя. */}
          {s.pendingMove && s.thinking && (
            <Message mine who={heroName} text={stripMoveTag(s.pendingMove)} pending busy />
          )}

          {s.thinking && (
            <div className="flex items-center gap-2 text-sm text-gray-400 pl-1">
              <span className="inline-block w-3 h-3 border-2 border-[var(--pl-accent)] border-t-transparent rounded-full animate-spin" />
              <span>{narratorName} печатает…</span>
              <button
                className="ml-1 rounded-full bg-white/10 hover:bg-white/20 px-2.5 py-1 text-xs"
                onClick={() => s.cancel()}
              >
                ✕ Отменить
              </button>
            </div>
          )}
        </div>
      </div>

      <Console
        disabled={s.thinking}
        value={s.draft}
        onValueChange={(t) => s.setDraft(t)}
        canContinue={!s.thinking}
        onSubmit={(txt) => s.submitFreeInput(txt)}
        onContinue={() => s.continueStory()}
        hasNotes={hasNotes}
        onOpenNotes={onOpenNotes}
      />
    </div>
  );
}

function Message({
  mine,
  who,
  text,
  pending,
  busy,
  editing,
  editText,
  onEditText,
  onStartEdit,
  onCommitEdit,
  onCancelEdit,
  onDelete,
  onRegenerate,
}: {
  mine: boolean;
  who: string;
  text: string;
  pending?: boolean;
  busy?: boolean;
  editing?: boolean;
  editText?: string;
  onEditText?: (t: string) => void;
  onStartEdit?: () => void;
  onCommitEdit?: () => void;
  onCancelEdit?: () => void;
  onDelete?: () => void;
  onRegenerate?: () => void;
}) {
  return (
    <div className={`group rounded-2xl px-4 py-3 border ${
      mine
        ? 'bg-[var(--pl-accent-soft)] border-[rgba(180,150,255,0.28)]'
        : 'bg-[var(--pl-bubble-bg)] border-[rgba(180,150,255,0.14)]'
    } ${pending ? 'opacity-60' : ''}`}
    >
      <div className="flex items-center gap-2 mb-1.5">
        {/* Не берём --pl-name: цвет имени темы рассчитан на светлую плашку в
            диалоговом окне новеллы и на тёмном пузыре чата почти не читается. */}
        <span
          className={`text-xs font-semibold tracking-wide ${mine ? '' : 'opacity-70'}`}
          style={{ color: mine ? 'var(--pl-accent-bright)' : 'var(--pl-text)' }}
        >
          {who}
        </span>
        {!pending && (
          <div className="ml-auto flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
            {onRegenerate && (
              <button className="text-xs px-2 py-0.5 rounded hover:bg-white/10" title="Другой вариант ответа" onClick={onRegenerate}>
                ↻
              </button>
            )}
            {onStartEdit && !editing && (
              <button className="text-xs px-2 py-0.5 rounded hover:bg-white/10" title="Редактировать" onClick={onStartEdit}>
                ✎
              </button>
            )}
            {onDelete && !editing && (
              <button
                className="text-xs px-2 py-0.5 rounded hover:bg-white/10 text-red-300"
                title="Удалить сообщение"
                onClick={onDelete}
                disabled={busy}
              >
                ✕
              </button>
            )}
          </div>
        )}
      </div>

      {editing ? (
        <div>
          {/* Правим СЫРОЙ текст сообщения, включая техническую пометку хода: именно
              он уходит в контекст, и прятать его в редакторе значило бы молча его
              стирать при сохранении. */}
          <textarea
            className="input w-full h-40 text-sm font-mono"
            value={editText ?? ''}
            onChange={(e) => onEditText?.(e.target.value)}
          />
          <div className="flex gap-2 justify-end mt-2">
            <button className="btn-ghost !py-1 !px-3 text-xs" onClick={onCancelEdit}>
              Отмена
            </button>
            <button className="btn-primary !py-1 !px-3 text-xs" onClick={onCommitEdit}>
              Сохранить
            </button>
          </div>
        </div>
      ) : (
        <Markdown
          text={text}
          className="block leading-relaxed whitespace-pre-wrap text-[color:var(--pl-text)]"
        />
      )}
    </div>
  );
}

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { usePlayerStore } from '../playerStore';
import { Console } from './Console';
import { Markdown } from '../../../shared/markdown';
import { stripMoveTag } from '../../../ai/responseParser';
import { parseRpResponse } from '../../../ai/rpResponse';
import { protagonistName } from '../../../ai/macros';
import { applyRegexRules } from '../../../ai/regexRules';
import { usePresetSettings } from '../../../ai/presetSettings';
import type { WorldStateUpdate } from '../../../shared/types';
import { StateInfobox } from './StateInfobox';
import { MessageMenu, type MessageMenuItem } from '../../../shared/MessageMenu';
import { copyToClipboard } from '../../../shared/utils';
import { loadGlobalTheme } from '../playerTheme';
import { useAssetUrl } from '../../../shared/ui';

// ЛЕНТА ПЕРЕПИСКИ — экран режима «классический РП».
//
// Показывает то же самое, что уходит в контекст: state.history. Никакого второго
// хранилища у чата нет намеренно — иначе экран и промпт разъезжались бы после
// правки сообщения, свёртки памяти или загрузки сейва.
//
// Сообщения, свёрнутые в память, здесь не видны: они физически удалены из истории
// и живут в журнале эпизодов (Game Master → Память). Так и должно быть — лента
// показывает ровно то, что модель ещё помнит дословно.
//
// Аватарок здесь НЕТ (сознательно): говорит всегда рассказчик, а не конкретный
// персонаж, и лицо ему приписать нельзя — для «визуала» есть отдельный режим
// новеллы со спрайтами. Вместо аватарки — имя, центрированное над баблом.

// Стартовая сцена — это задание миру от автора, а не реплика героя. В историю она
// как ход игрока уже не попадает (см. applyTurn), но ПРЕДПРОСМОТР отправленного
// хода жил отдельно и всё равно рисовал её баблом «Героя» на всё время генерации —
// а на медленной модели это минуты.
function isGameStart(move: string): boolean {
  return move.trimStart().startsWith('[GAME START]');
}

interface Rendered {
  /** Проза для показа: без служебного блока, после правил-регэкспов. */
  text: string;
  /** Разобранная сводка мира этого хода — из неё рисуется инфобокс. */
  world?: WorldStateUpdate;
}

export function RpChat({ hasNotes, onOpenNotes }: { hasNotes: boolean; onOpenNotes: () => void }) {
  const s = usePlayerStore();
  const cfg = usePresetSettings((x) => x.settings);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [editText, setEditText] = useState('');

  const state = s.state;
  const project = s.project;
  const history = state?.history ?? [];
  const lastIndex = history.length - 1;
  const heroName = project && state ? protagonistName(project, state) : 'Герой';
  // Рассказчик подписывается именем проекта — у него нет своего лица и голоса,
  // это условность, а не персонаж; называть его «Рассказчик» всюду было безликим
  // ярлыком там, где уже есть куда более осмысленное имя.
  const narratorName = project?.meta.title?.trim() || 'Рассказчик';
  // Тот же фолбэк, что и в PlayerPage: у проекта своя тема, а нет — прежняя
  // глобальная (localStorage), чтобы старый выбор не терялся.
  const theme = project?.playerTheme ?? loadGlobalTheme();
  const bgKey = project?.assets.find((a) => a.id === theme.chatBgAssetId)?.blobKey;
  const bgUrl = useAssetUrl(bgKey);

  // Разбор всей ленты — заметная работа (регэкспы плюс JSON сводки на каждое
  // сообщение), поэтому считаем один раз на изменение истории, а не на каждый кадр
  // перерисовки: во время стриминга кадров десятки в секунду.
  const rendered: Rendered[] = useMemo(() => {
    return history.map((m) => {
      if (m.role === 'user') {
        return {
          text: applyRegexRules(stripMoveTag(m.content), cfg.regexRules, {
            role: 'user',
            scope: 'display',
          }),
        };
      }
      // guard: false — обрезать «письмо за игрока» на показе поздно и вредно: ход
      // уже применён, и текст на экране разошёлся бы с текстом в контексте.
      const rp = parseRpResponse(m.content, {
        guard: false,
        prefill: cfg.hidePrefill ? cfg.prefill : undefined,
      });
      return {
        text: applyRegexRules(rp.prose, cfg.regexRules, { role: 'ai', scope: 'display' }),
        world: rp.worldState,
      };
    });
  }, [history, cfg.regexRules, cfg.hidePrefill, cfg.prefill]);

  // Прокрутка вниз при новом сообщении и по мере набора текста. useLayoutEffect, а
  // не useEffect: иначе кадр между вёрсткой и прокруткой видно как рывок вверх.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [history.length, s.thinking, s.pendingMove, s.streamingText]);

  // Правка закрывается сама, если сообщение исчезло (свайп, свёртка, загрузка
  // сейва) — иначе открытая форма начала бы редактировать чужой текст под тем же
  // индексом.
  useEffect(() => {
    if (editing !== null && editing >= history.length) setEditing(null);
  }, [history.length, editing]);

  // Секундомер ожидания: неясно, ждём модель или она уже печатает — особенно на
  // медленных моделях, где счёт идёт на десятки секунд, а не на «думает…» без
  // единого ориентира. Считает от начала ЛЮБОЙ фазы (думает/печатает) до конца хода.
  const [elapsedSec, setElapsedSec] = useState(0);
  useEffect(() => {
    if (!s.thinking) {
      setElapsedSec(0);
      return;
    }
    const startedAt = Date.now();
    const id = setInterval(() => setElapsedSec(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(id);
  }, [s.thinking]);

  if (!project || !state) return null;

  const startEdit = (i: number, text: string) => {
    setEditing(i);
    setEditText(text);
  };
  const commitEdit = () => {
    if (editing === null) return;
    s.editHistoryMessage(editing, editText);
    setEditing(null);
  };

  const last = history[lastIndex];
  const swipeCount = last?.role === 'assistant' ? last.swipes?.length ?? 0 : 0;
  const swipeAt = last?.swipe ?? 0;

  return (
    <div className="absolute inset-0 pt-14 flex flex-col" style={{ background: 'var(--pl-chat-bg)' }}>
      {/* Своя картинка на фон. Отдельным слоем под лентой, а не background у неё:
          так она не съезжает вместе с прокруткой и не перерисовывается на каждом
          куске потока. Затемнение — сверху, чтобы текст оставался читаемым. */}
      {bgUrl && (
        <div className="absolute inset-0 pointer-events-none" aria-hidden>
          <img src={bgUrl} alt="" className="w-full h-full object-cover" />
          <div className="absolute inset-0" style={{ background: `rgba(0,0,0,${theme.chatBgDim})` }} />
        </div>
      )}
      <div ref={scrollRef} className="relative flex-1 overflow-y-auto px-3 sm:px-4 py-5">
        <div className="max-w-3xl mx-auto flex flex-col" style={{ gap: 'var(--pl-msg-gap)' }}>
          {history.length === 0 && !s.pendingMove && (
            <p className="text-center text-sm text-gray-500 py-10">
              История пустая. Напишите первую реплику — или нажмите ▶ в строке ввода, и мир начнёт сам.
            </p>
          )}

          {history.map((m, i) => {
            const mine = m.role === 'user';
            const r = rendered[i];
            const isLast = i === lastIndex;
            // Нулевое сообщение — авторская стартовая сцена, а не ответ модели:
            // вариантов у неё нет и быть не может (менять её нужно в проекте).
            const canSwipe = !mine && isLast && i > 0 && !s.thinking;
            return (
              <Message
                key={i}
                mine={mine}
                who={mine ? heroName : narratorName}
                number={theme.showMessageNumbers ? i + 1 : undefined}
                text={r?.text ?? ''}
                infobox={
                  !mine && cfg.showStateInfobox && r?.world ? <StateInfobox state={r.world} /> : null
                }
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
                onCopy={() => copyToClipboard(r?.text ?? '')}
                // Варианты — только у последнего ответа: откат состояния движок
                // умеет ровно на один ход назад, для середины ленты снимка нет.
                swipes={canSwipe ? { count: Math.max(1, swipeCount), at: swipeAt } : undefined}
                onSwipe={(dir) => {
                  if (dir === 1 && swipeAt >= swipeCount - 1) void s.addSwipe();
                  else void s.setSwipe(swipeAt + dir);
                }}
                onNewSwipe={canSwipe ? () => void s.addSwipe() : undefined}
                busy={s.thinking}
              />
            );
          })}

          {/* Отправленный ход, пока идёт генерация: в историю он попадёт только
              вместе с ответом, а исчезать с экрана на полминуты ему нельзя. */}
          {s.pendingMove && s.thinking && !isGameStart(s.pendingMove) && (
            <Message mine who={heroName} text={stripMoveTag(s.pendingMove)} pending busy />
          )}

          {/* Ответ, который набирается прямо сейчас. */}
          {s.thinking && !!s.streamingText && (
            <Message
              mine={false}
              who={narratorName}
              text={applyRegexRules(s.streamingText, cfg.regexRules, { role: 'ai', scope: 'display' })}
              streaming
              busy
            />
          )}

          {/* Живой черновик размышления. Показывается ДО первой буквы прозы —
              именно ради этого и существует: на модели, думающей минуту-две, иначе
              не отличить работу от зависания. Свёрнут по умолчанию: это черновик,
              а не часть истории, и разворачивать его нужно не всем и не всегда. */}
          {s.thinking && !!s.thinkingText && <ThinkingDraft text={s.thinkingText} />}

          {s.thinking && (
            <div className="flex items-center gap-2 text-sm text-gray-400 pl-1">
              <span className="inline-block w-3 h-3 border-2 border-[var(--pl-accent)] border-t-transparent rounded-full animate-spin" />
              <span>
                {s.streamingText ? 'печатает…' : s.thinkingText ? 'размышляет…' : 'думает…'} {elapsedSec} с
              </span>
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

// ЧЕРНОВИК РАЗМЫШЛЕНИЯ, пока идёт генерация.
//
// Свёрнут по умолчанию, но НЕ пуст даже свёрнутым: в заголовке идёт последняя
// строка черновика, и она обновляется на каждом куске. Это и есть доказательство
// жизни — по бегущей строке видно, что модель пишет, не требуя ничего открывать.
// Развёрнутый вид сам прокручивается вниз: читать интересно именно конец.
function ThinkingDraft({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (open && el) el.scrollTop = el.scrollHeight;
  }, [text, open]);
  // Последняя непустая строка — «что модель думает прямо сейчас».
  const lines = text.split('\n').filter((l) => l.trim());
  const tail = lines[lines.length - 1] ?? '';

  return (
    <div className="rounded-xl border border-dashed border-[rgba(180,150,255,0.25)] bg-black/20 overflow-hidden">
      <button
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-white/[0.03]"
        onClick={() => setOpen((v) => !v)}
        title={open ? 'Свернуть размышление' : 'Показать размышление целиком'}
      >
        <span className="text-xs shrink-0 opacity-60">💭</span>
        <span className="flex-1 min-w-0 text-[11px] text-gray-400 truncate italic">
          {open ? 'черновик размышления' : tail || 'модель размышляет…'}
        </span>
        <span className="text-[11px] text-gray-500 shrink-0">{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div
          ref={boxRef}
          className="px-3 pb-2.5 max-h-56 overflow-y-auto border-t border-white/[0.06] pt-2"
        >
          <p className="m-0 text-[12px] leading-relaxed text-gray-400 whitespace-pre-wrap italic">
            {text}
          </p>
        </div>
      )}
    </div>
  );
}

function Message({
  mine,
  who,
  number,
  text,
  infobox,
  pending,
  streaming,
  busy,
  editing,
  editText,
  onEditText,
  onStartEdit,
  onCommitEdit,
  onCancelEdit,
  onDelete,
  onCopy,
  swipes,
  onSwipe,
  onNewSwipe,
}: {
  mine: boolean;
  who: string;
  /** Порядковый номер в ленте (1-based) — тумблер «Счётчик сообщений» в оформлении. */
  number?: number;
  text: string;
  infobox?: React.ReactNode;
  pending?: boolean;
  streaming?: boolean;
  busy?: boolean;
  editing?: boolean;
  editText?: string;
  onEditText?: (t: string) => void;
  onStartEdit?: () => void;
  onCommitEdit?: () => void;
  onCancelEdit?: () => void;
  onDelete?: () => void;
  onCopy?: () => void;
  swipes?: { count: number; at: number };
  onSwipe?: (dir: -1 | 1) => void;
  onNewSwipe?: () => void;
}) {
  const menuItems: MessageMenuItem[] = [];
  if (onStartEdit) menuItems.push({ icon: '✎', label: 'Редактировать', onClick: onStartEdit });
  if (onCopy) menuItems.push({ icon: '⧉', label: 'Копировать', onClick: onCopy });
  if (onNewSwipe) menuItems.push({ icon: '↻', label: 'Другой вариант', onClick: onNewSwipe });
  if (onDelete) menuItems.push({ icon: '✕', label: 'Удалить', onClick: onDelete, danger: true });

  return (
    <div
      className={`group relative rounded-2xl px-4 pt-8 pb-3 border ${pending ? 'opacity-60' : ''} ${
        mine
          ? 'bg-[var(--pl-user-bg)] border-[rgba(180,150,255,0.28)]'
          : 'bg-[var(--pl-narrator-bg)] border-[rgba(180,150,255,0.14)]'
      }`}
    >
      {/* Имя — центрировано вверху бабла, без аватарки: в РП говорит всегда
          рассказчик или герой, а не конкретный персонаж с лицом. */}
      <div className="absolute top-2 inset-x-0 flex items-center justify-center gap-1.5">
        <span
          className={`text-xs font-semibold tracking-wide ${mine ? '' : 'opacity-70'}`}
          style={{
            color: mine ? 'var(--pl-accent-bright)' : 'var(--pl-text)',
            fontSize: 'calc(0.75rem * var(--pl-name-scale, 1))',
          }}
        >
          {who}
        </span>
        {number !== undefined && <span className="text-[10px] text-gray-500 tabular-nums">#{number}</span>}
      </div>

      {!pending && !streaming && (
        <div className="absolute top-1.5 right-1.5 flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
          {swipes && (
            <span className="flex items-center gap-0.5">
              <button
                className="text-xs px-1.5 py-0.5 rounded hover:bg-white/10 disabled:opacity-30"
                title="Предыдущий вариант"
                disabled={swipes.at <= 0}
                onClick={() => onSwipe?.(-1)}
              >
                ‹
              </button>
              <span className="text-[11px] text-gray-500 tabular-nums">
                {swipes.at + 1}/{swipes.count}
              </span>
              <button
                className="text-xs px-1.5 py-0.5 rounded hover:bg-white/10"
                title={swipes.at >= swipes.count - 1 ? 'Сгенерировать новый вариант' : 'Следующий вариант'}
                onClick={() => onSwipe?.(1)}
              >
                ›
              </button>
            </span>
          )}
          {!editing && <MessageMenu items={menuItems} disabled={busy} />}
        </div>
      )}

      {editing ? (
        <div>
          {/* Правим СЫРОЙ текст сообщения — с технической пометкой хода и со
              служебной сводкой. Именно он уходит в контекст, и прятать его в
              редакторе значило бы молча стирать при сохранении. */}
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
        <>
          {/* md-content ОБЯЗАТЕЛЕН, а не украшение: Tailwind обнуляет отступы у всех
              элементов, и без этого класса абзацы слипались в сплошную простыню, а
              заодно молча не работали три настройки оформления — отступ между
              абзацами, цвет прямой речи и цвет курсива (все они висят на .md-content).
              lineAsParagraph — разбивка по одиночным переводам строк, как в Таверне. */}
          <Markdown
            text={text}
            lineAsParagraph
            className="block md-content text-[color:var(--pl-text)]"
            style={{
              lineHeight: 'var(--pl-line-height)',
              fontSize: 'calc(15px * var(--pl-font-scale, 1))',
            }}
          />
          {streaming && (
            <span className="inline-block w-1.5 h-4 align-text-bottom ml-0.5 bg-[var(--pl-accent)] animate-pulse" />
          )}
          {infobox}
        </>
      )}
    </div>
  );
}

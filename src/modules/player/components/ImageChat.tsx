import { useEffect, useRef, useState } from 'react';
import { AssetImage } from '../../../shared/ui';
import { usePlayerStore } from '../playerStore';
import { imageGenFor } from '../../../ai/imageConnection';
import { renderImage, type RefReport } from '../../../ai/imageCast';
import { chatCast, imageChatTurn } from '../../../ai/imageChat';
import { getAssetBlob, putAsset, deleteAsset } from '../../../storage/db';
import { uid } from '../../../shared/utils';
import { defaultImageGenConfig, type AssetMeta, type ImageChatMsg, type ImageGenConfig, type Project, type RuntimeState } from '../../../shared/types';

type L = (ru: string, en: string) => string;

const PROVIDER_LABEL: Record<ImageGenConfig['providerKind'], string> = {
  novelai: 'NovelAI',
  gemini: 'Nano Banana',
  openai: 'OpenAI',
  openai_chat: 'OpenRouter / чат',
};

// РУЧНОЙ РЕЖИМ СТУДИИ: чат с ассистентом картинок. Пишешь по-простому — получаешь
// промпт под текущего провайдера, правишь при желании и жмёшь «🎨 Нарисовать».
// Следующее сообщение правит прошлый промпт. Переписка хранится в истории.
export function ImageChat({ project, state, L }: { project: Project; state: RuntimeState; L: L }) {
  const s = usePlayerStore();
  const ig = imageGenFor(project);
  const chat = ig.chat || [];
  const seeScene = ig.chatSeeScene !== false;
  const [text, setText] = useState('');
  const [thinking, setThinking] = useState(false);
  const [drawing, setDrawing] = useState<string | null>(null); // id сообщения
  const [err, setErr] = useState('');
  const [refs, setRefs] = useState<Record<string, RefReport>>({});
  const abortRef = useRef<AbortController | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [chat.length, thinking]);

  const patchChat = (fn: (c: ImageChatMsg[]) => ImageChatMsg[]) =>
    s.patchProject((p) => {
      const cur = p.imageGen ?? defaultImageGenConfig();
      p.imageGen = { ...cur, chat: fn(cur.chat || []) };
    });
  const patchMsg = (id: string, patch: Partial<ImageChatMsg>) => patchChat((c) => c.map((m) => (m.id === id ? { ...m, ...patch } : m)));

  async function send() {
    const req = text.trim();
    if (!req || thinking) return;
    setErr('');
    setText('');
    const userMsg: ImageChatMsg = { id: uid('msg'), role: 'user', text: req, at: Date.now() };
    const history = chat;
    await patchChat((c) => [...c, userMsg]);
    setThinking(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const st = usePlayerStore.getState();
      const r = await imageChatTurn(st.project || project, st.state || state, history, req, { seeScene, signal: controller.signal });
      if (controller.signal.aborted) return;
      await patchChat((c) => [
        ...c,
        {
          id: uid('msg'),
          role: 'assistant',
          text: r.reply,
          ...(r.prompt ? { prompt: r.prompt, provider: ig.providerKind } : {}),
          ...(r.aspect ? { aspect: r.aspect } : {}),
          ...(r.cast.length ? { cast: r.cast } : {}),
          at: Date.now(),
        },
      ]);
    } catch (e) {
      if (!controller.signal.aborted) setErr((e as Error).message);
    } finally {
      setThinking(false);
      abortRef.current = null;
    }
  }

  async function draw(m: ImageChatMsg) {
    if (!m.prompt?.trim() || drawing) return;
    setErr('');
    setDrawing(m.id);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const st = usePlayerStore.getState();
      const pr = st.project || project;
      const stt = st.state || state;
      const req = [...chat].reverse().find((x) => x.role === 'user' && x.at <= m.at)?.text || '';
      const cast = chatCast(pr, stt, m.cast || [], `${req}\n${m.prompt}`);
      const cur = imageGenFor(pr);
      const { blob, refs: report } = await renderImage(pr, stt, {
        prompt: m.prompt,
        cast,
        withOutfit: true,
        aspectRatio: cur.aspectRatio === 'auto' ? m.aspect || '16:9' : undefined,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      const blobKey = uid('blob');
      await putAsset(blobKey, blob);
      await patchMsg(m.id, { images: [...(m.images || []), blobKey], error: undefined });
      if (report) setRefs((x) => ({ ...x, [m.id]: report }));
    } catch (e) {
      if (!controller.signal.aborted) await patchMsg(m.id, { error: (e as Error).message });
    } finally {
      setDrawing(null);
      abortRef.current = null;
    }
  }

  function stop() {
    abortRef.current?.abort();
    setThinking(false);
    setDrawing(null);
  }

  const inGallery = (blobKey: string) => (usePlayerStore.getState().project?.assets || []).some((a) => a.blobKey === blobKey);

  async function toGallery(m: ImageChatMsg, blobKey: string) {
    if (inGallery(blobKey)) return;
    const blob = await getAssetBlob(blobKey);
    const asset: AssetMeta = {
      id: uid('cg'),
      type: 'cg',
      name: (m.prompt || 'CG').split(/[\s,.|]+/).slice(0, 4).join(' ').slice(0, 40) || 'CG',
      generated: true,
      blobKey,
      mime: blob?.type || 'image/png',
    };
    await s.patchProject((p) => {
      p.assets.push(asset);
      const cur = p.imageGen ?? defaultImageGenConfig();
      p.imageGen = { ...cur, gallery: [...cur.gallery, asset.id] };
    });
  }

  async function download(blobKey: string) {
    const b = await getAssetBlob(blobKey);
    if (!b) return;
    const url = URL.createObjectURL(b);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'image.png';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  async function removeImage(m: ImageChatMsg, blobKey: string) {
    if (!inGallery(blobKey)) await deleteAsset(blobKey);
    await patchMsg(m.id, { images: (m.images || []).filter((k) => k !== blobKey) });
  }

  async function clearChat() {
    if (!chat.length) return;
    if (!window.confirm(L('Стереть переписку? Картинки, сохранённые в галерею, останутся.', 'Clear the chat? Images saved to the gallery stay.'))) return;
    for (const m of chat) for (const k of m.images || []) if (!inGallery(k)) await deleteAsset(k);
    await patchChat(() => []);
    setRefs({});
  }

  return (
    <div className="nf-image-chat glass-panel p-3 !rounded-2xl space-y-2">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="text-sm font-semibold">
          💬 {L('Ассистент картинок', 'Image assistant')}
          <span className="text-[11px] font-normal text-gray-400"> · {L('промпт для', 'prompt for')} {PROVIDER_LABEL[ig.providerKind]}</span>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <label className="flex items-center gap-1.5 text-xs text-gray-300" title={L('Ассистент знает место, кто рядом и что только что было', 'The assistant knows the location, who is near and what just happened')}>
            <input
              type="checkbox"
              className="nf-chat-see"
              checked={seeScene}
              onChange={(e) =>
                s.patchProject((p) => {
                  p.imageGen = { ...(p.imageGen ?? defaultImageGenConfig()), chatSeeScene: e.target.checked };
                })
              }
            />
            {L('Видеть сцену', 'See the scene')}
          </label>
          <button className="btn-ghost !px-2 !py-1 text-xs nf-chat-clear" disabled={!chat.length || thinking || !!drawing} onClick={() => void clearChat()}>
            🧹 {L('Очистить', 'Clear')}
          </button>
        </div>
      </div>

      <div ref={listRef} className="nf-chat-list max-h-[46vh] overflow-y-auto scrollbar-thin space-y-2 pr-1">
        {chat.length === 0 && (
          <p className="text-[12px] text-gray-500 py-2">
            {L(
              'Напишите по-простому, что нарисовать: «Тони и Пеппер на крыше на закате, она смеётся, вид снизу» или «Макима из Человека-бензопилы в кафе, дождь за окном». Персонажей истории ассистент узнаёт по имени — их внешность и рефы подставятся сами. Потом можно править: «сделай ночь», «пусть он обнимает её сзади».',
              'Describe the picture plainly. Story characters are recognised by name — their looks and references are added automatically. Then refine: "make it night", "let him hug her from behind".'
            )}
          </p>
        )}
        {chat.map((m) =>
          m.role === 'user' ? (
            <div key={m.id} className="nf-chat-user ml-auto max-w-[85%] rounded-xl bg-accent2/30 px-3 py-2 text-sm whitespace-pre-wrap">
              {m.text}
            </div>
          ) : (
            <ChatAnswer
              key={m.id}
              m={m}
              provider={ig.providerKind}
              busy={drawing === m.id}
              locked={!!drawing || thinking}
              refs={refs[m.id]}
              onPrompt={(prompt) => patchMsg(m.id, { prompt })}
              onDraw={() => void draw(m)}
              onGallery={(k) => void toGallery(m, k)}
              onDownload={(k) => void download(k)}
              onRemove={(k) => void removeImage(m, k)}
              inGallery={inGallery}
              L={L}
            />
          )
        )}
        {thinking && <div className="text-xs text-gray-400 nf-chat-thinking">{L('Пишу промпт…', 'Writing the prompt…')}</div>}
      </div>

      {err && <div className="text-xs text-red-400">⚠️ {err}</div>}
      <div className="flex gap-2 items-end">
        <textarea
          className="input h-16 text-sm flex-1 nf-chat-input"
          placeholder={chat.length ? L('Что поменять или что нарисовать дальше…', 'What to change or draw next…') : L('Что нарисовать…', 'What to draw…')}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        {thinking || drawing ? (
          <button className="btn-ghost text-sm" onClick={stop}>
            ✕ {L('Стоп', 'Stop')}
          </button>
        ) : (
          <button className="btn-primary text-sm nf-chat-send" disabled={!text.trim()} onClick={() => void send()}>
            {L('Отправить', 'Send')}
          </button>
        )}
      </div>
    </div>
  );
}

function ChatAnswer({
  m,
  provider,
  busy,
  locked,
  refs,
  onPrompt,
  onDraw,
  onGallery,
  onDownload,
  onRemove,
  inGallery,
  L,
}: {
  m: ImageChatMsg;
  provider: ImageGenConfig['providerKind'];
  busy: boolean;
  locked: boolean;
  refs?: RefReport;
  onPrompt: (p: string) => void;
  onDraw: () => void;
  onGallery: (blobKey: string) => void;
  onDownload: (blobKey: string) => void;
  onRemove: (blobKey: string) => void;
  inGallery: (blobKey: string) => boolean;
  L: L;
}) {
  // Правка промпта — локально, в историю — по уходу с поля (не на каждую букву).
  const [draft, setDraft] = useState(m.prompt || '');
  useEffect(() => setDraft(m.prompt || ''), [m.prompt]);
  const foreign = !!m.prompt && !!m.provider && m.provider !== provider;
  return (
    <div className="nf-chat-answer max-w-[95%] rounded-xl border border-white/10 bg-black/25 px-3 py-2 space-y-1.5">
      {m.text && <div className="text-sm whitespace-pre-wrap">{m.text}</div>}
      {m.prompt !== undefined && m.prompt !== '' && (
        <>
          <textarea
            className="input h-24 text-[12px] font-mono nf-chat-prompt"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => draft !== m.prompt && onPrompt(draft)}
          />
          {provider === 'novelai' && (
            <p className="text-[10px] text-gray-500">
              {L('Синтаксис: сцена | персонаж | персонаж. Стиль, качество и «нежелательное» добавятся из настроек студии.', 'Syntax: scene | character | character. Style, quality and undesired content are added from the studio settings.')}
            </p>
          )}
          {foreign && (
            <p className="text-[11px] text-amber-300/90">
              {L(
                `Этот промпт написан для ${PROVIDER_LABEL[m.provider!]}, а сейчас выбран ${PROVIDER_LABEL[provider]} — попросите ассистента переписать его.`,
                `This prompt was written for ${PROVIDER_LABEL[m.provider!]}; ask the assistant to rewrite it.`
              )}
            </p>
          )}
          <div className="flex items-center gap-2 flex-wrap">
            <button
              className="btn-primary !px-3 !py-1 text-xs nf-chat-draw"
              disabled={locked || !draft.trim()}
              onClick={() => {
                if (draft !== m.prompt) onPrompt(draft);
                onDraw();
              }}
            >
              {busy ? L('Рисую…', 'Drawing…') : `🎨 ${m.images?.length ? L('Ещё вариант', 'Another one') : L('Нарисовать', 'Draw')}`}
            </button>
            {!!m.cast?.length && <span className="text-[11px] text-gray-400">{L('В кадре: ', 'In frame: ') + m.cast.join(', ')}</span>}
          </div>
        </>
      )}
      {m.error && <div className="text-[11px] text-red-400">⚠️ {m.error}</div>}
      {refs && (refs.sent.length > 0 || refs.note || refs.tagged?.length) && (
        <div className="text-[11px] space-y-0.5 nf-chat-refs">
          {refs.sent.length > 0 && <div className="text-emerald-300/90">{L('Рефы ушли: ', 'References sent: ') + refs.sent.join('; ')}</div>}
          {refs.note && <div className="text-amber-300/90">{L('Рефы не ушли: ', 'References not sent: ') + refs.note}</div>}
          {!!refs.tagged?.length && <div className="text-emerald-300/90">{L('Теги внешности ушли: ', 'Appearance tags sent: ') + refs.tagged.join(', ')}</div>}
        </div>
      )}
      {!!m.images?.length && (
        <div className="grid grid-cols-2 gap-2">
          {m.images.map((k) => (
            <div key={k} className="relative rounded-lg overflow-hidden border border-white/10 nf-chat-image">
              <AssetImage blobKey={k} className="w-full object-contain max-h-[40vh] bg-black/40" />
              <div className="flex justify-end gap-1 p-1 bg-black/50">
                <button className="btn-ghost !px-2 !py-0.5 text-xs" title={L('Скачать', 'Download')} onClick={() => onDownload(k)}>
                  ⬇
                </button>
                <button
                  className="btn-ghost !px-2 !py-0.5 text-xs nf-chat-gallery"
                  disabled={inGallery(k)}
                  title={inGallery(k) ? L('Уже в галерее', 'In the gallery') : L('В галерею', 'Save to gallery')}
                  onClick={() => onGallery(k)}
                >
                  {inGallery(k) ? '✓' : '⭐'}
                </button>
                <button className="btn-ghost !px-2 !py-0.5 text-xs text-red-300" title={L('Удалить', 'Delete')} onClick={() => onRemove(k)}>
                  🗑
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

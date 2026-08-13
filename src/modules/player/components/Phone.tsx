import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { usePlayerStore, type AvatarSubject } from '../playerStore';
import { describePerson } from '../../../ai/phonePhoto';
import { AssetImage } from '../../../shared/ui';
import { defaultPhoneConfig, defaultFinanceConfig, contactDisplayName, PHONE_BALANCE_STAT, type PhoneConfig, type PhoneChat, type RecurringEntry } from '../../../shared/types';
import { resolveSprite } from '../../../shared/outfits';
import { getApiKey } from '../../../ai/keys';
import { scanContacts } from '../../../ai/gmScan';
import { pushToast } from '../../../shared/toast';

// Расширение «Телефон» (Batch 7). ФАЗА 1 — каркас: перетаскиваемая иконка + окно
// (рабочий стол с сеткой приложений) + читаемые экраны Банк/Сообщения/Магазин +
// заглушки действий. Мессенджер-ИИ, покупки, камера и связь с контекстом — следующие фазы.
// Иконки нарисованы свои (НЕ копии фирменных Apple).

type App = 'home' | 'messages' | 'bank' | 'camera';

function useCfg(): { cfg: PhoneConfig; patch: (p: Partial<PhoneConfig>) => void } {
  const s = usePlayerStore();
  const cfg = s.project?.phone ?? defaultPhoneConfig();
  const patch = (p: Partial<PhoneConfig>) =>
    s.patchProject((proj) => {
      proj.phone = { ...(proj.phone ?? defaultPhoneConfig()), ...p };
    });
  return { cfg, patch };
}

function money(n: number, currency: string): string {
  return currency === '$' ? `$${n}` : `${n} ${currency}`;
}

// Время сообщения ЧЧ:ММ из timestamp.
function fmtTime(at: number): string {
  try {
    const d = new Date(at);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  } catch {
    return '';
  }
}

// ---- SVG-иконки приложений (оригинальные) ----
const AppIcon = ({ kind }: { kind: App | 'settings' }) => {
  const p: Record<string, ReactNode> = {
    messages: <path d="M4 5h16v10H9l-4 4v-4H4z" fill="#fff" opacity="0.95" />,
    bank: (
      <>
        <path d="M4 9 12 4l8 5H4Z" fill="#fff" />
        <path d="M5 10h2v6H5zM11 10h2v6h-2zM17 10h2v6h-2zM4 17h16v2H4z" fill="#fff" />
      </>
    ),
    camera: (
      <>
        <rect x="4" y="7" width="16" height="12" rx="2.5" fill="none" stroke="#fff" strokeWidth="1.6" />
        <circle cx="12" cy="13" r="3.2" fill="none" stroke="#fff" strokeWidth="1.6" />
        <path d="M9 7l1.5-2h3L15 7" fill="none" stroke="#fff" strokeWidth="1.6" />
      </>
    ),
    settings: (
      <>
        <circle cx="12" cy="12" r="3" fill="none" stroke="#fff" strokeWidth="1.6" />
        <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2 2M16.4 16.4l2 2M18.4 5.6l-2 2M7.6 16.4l-2 2" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" />
      </>
    ),
  };
  const grad: Record<string, string> = {
    messages: 'from-emerald-400 to-green-600',
    bank: 'from-sky-400 to-indigo-600',
    camera: 'from-fuchsia-400 to-purple-600',
    settings: 'from-slate-400 to-slate-600',
  };
  return (
    <div className={`w-14 h-14 rounded-[16px] bg-gradient-to-br ${grad[kind]} flex items-center justify-center shadow-lg`}>
      <svg width="26" height="26" viewBox="0 0 24 24">{p[kind]}</svg>
    </div>
  );
};

// ---- Плавающая иконка (перетаскиваемая) ----
export function PhoneFloatingIcon({ onOpen }: { onOpen: () => void }) {
  const { cfg, patch } = useCfg();
  const s = usePlayerStore();
  const [pos, setPos] = useState(cfg.iconPosition);
  // Порог движения: тап с микро-дрожанием (частый на тач/мыши) НЕ считается
  // перетаскиванием — иначе onUp уходил в ветку drag и телефон не открывался.
  const drag = useRef<{ moved: boolean; sx: number; sy: number } | null>(null);
  // Непрочитанное считается по чатам: чат — единица переписки и для лички, и для групп.
  const unread = (s.state?.phone?.chats || []).filter((c) => !c.archived && c.unread).length;
  const DRAG_THRESHOLD = 6; // px

  if (!cfg.enabled || !cfg.showFloatingIcon) return null;

  function onDown(e: React.PointerEvent) {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { moved: false, sx: e.clientX, sy: e.clientY };
  }
  function onMove(e: React.PointerEvent) {
    if (!drag.current) return;
    if (!drag.current.moved) {
      const dist = Math.hypot(e.clientX - drag.current.sx, e.clientY - drag.current.sy);
      if (dist < DRAG_THRESHOLD) return; // ещё считается тапом
      drag.current.moved = true;
    }
    const x = Math.max(4, Math.min(96, (e.clientX / window.innerWidth) * 100));
    const y = Math.max(8, Math.min(94, (e.clientY / window.innerHeight) * 100));
    setPos({ x, y });
  }
  function onUp() {
    if (!drag.current) return;
    if (drag.current.moved) patch({ iconPosition: pos });
    else onOpen();
    drag.current = null;
  }

  return (
    <button
      className="fixed z-40 w-12 h-12 -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-gradient-to-br from-[#2a2540] to-[#0b0913] border border-[rgba(180,150,255,0.3)] shadow-[0_6px_20px_rgba(0,0,0,0.5)] flex items-center justify-center touch-none select-none"
      style={{ left: `${pos.x}%`, top: `${pos.y}%` }}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      title="Телефон"
    >
      <svg width="20" height="20" viewBox="0 0 24 24">
        <rect x="6" y="2.5" width="12" height="19" rx="3" fill="none" stroke="#d6cdf0" strokeWidth="1.6" />
        <circle cx="12" cy="18.5" r="1" fill="#d6cdf0" />
      </svg>
      {unread > 0 && (
        <span className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full bg-red-500 text-white text-[10px] leading-4 text-center">
          {unread > 9 ? '9+' : unread}
        </span>
      )}
    </button>
  );
}

// ---- Окно телефона ----
export function PhoneWindow({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { cfg } = useCfg();
  const s = usePlayerStore();
  const [app, setApp] = useState<App>('home');
  const [chatId, setChatId] = useState<string | null>(null);
  if (!open || !cfg.enabled || !s.project || !s.state) return null;
  const project = s.project;
  const phone = s.state.phone;
  const balance = s.state.statValues[PHONE_BALANCE_STAT] ?? 0;
  const wallpaperKey = project.assets.find((a) => a.id === cfg.wallpaperAssetId)?.blobKey;

  const openChat = (id: string) => {
    setChatId(id);
    s.markChatRead(id);
  };

  const Screen = ({ title, children }: { title: string; children: ReactNode }) => (
    <div className="absolute inset-0 flex flex-col">
      <div className="flex items-center gap-2 px-3 py-3 bg-black/30 backdrop-blur-md">
        <button className="text-white/90 text-xl leading-none" onClick={() => setApp('home')}>‹</button>
        <div className="font-semibold text-white">{title}</div>
      </div>
      <div className="flex-1 overflow-y-auto scrollbar-thin p-3 text-white">{children}</div>
    </div>
  );

  return createPortal(
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-3" onClick={onClose}>
      <div
        className="relative w-full max-w-[380px] h-[min(78vh,760px)] rounded-[36px] overflow-hidden border-[6px] border-black bg-[#0b0913] shadow-[0_30px_80px_rgba(0,0,0,0.7)]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Обои */}
        {wallpaperKey ? (
          <AssetImage blobKey={wallpaperKey} className="absolute inset-0 w-full h-full object-cover" />
        ) : (
          <div className="absolute inset-0 bg-gradient-to-b from-[#3a2f66] via-[#241b40] to-[#0b0913]" />
        )}
        <div className="absolute inset-0 bg-black/20" />

        {/* Статус-бар */}
        <div className="relative flex items-center justify-between px-5 pt-2.5 pb-1 text-white text-xs font-medium">
          <span>{money(balance, cfg.currencyName)}</span>
          <div className="flex items-center gap-1">
            <span>▮▮▮</span>
            <span>📶</span>
          </div>
        </div>

        {/* Контент */}
        {app === 'home' && (
          <div className="relative h-full pt-6">
            <div className="grid grid-cols-4 gap-4 px-6">
              {([
                ['messages', 'Сообщения'],
                ['bank', 'Банк'],
                ['camera', 'Камера'],
              ] as [App, string][]).map(([id, label]) => (
                <button key={id} className="flex flex-col items-center gap-1" onClick={() => { setChatId(null); setApp(id); }}>
                  <AppIcon kind={id} />
                  <span className="text-[11px] text-white/90">{label}</span>
                </button>
              ))}
            </div>
            <button
              className="absolute bottom-4 left-1/2 -translate-x-1/2 w-32 h-1.5 rounded-full bg-white/60"
              onClick={onClose}
              title="Закрыть"
            />
          </div>
        )}

        {app === 'bank' && <BankScreen onBack={() => setApp('home')} />}

        {app === 'messages' && !chatId && (
          <ChatListScreen onBack={() => setApp('home')} onOpenChat={openChat} />
        )}

        {app === 'messages' && chatId && (
          <ChatThread chatId={chatId} onBack={() => setChatId(null)} />
        )}

        {app === 'camera' && <CameraScreen onBack={() => setApp('home')} />}
      </div>
    </div>,
    document.body
  );
}

// ---- Общие помощники мессенджера (Телефон 2.0) ----
// Имя и аватар контакта резолвятся из трёх источников: своё поле → персонаж
// проекта → запись реестра Game Master. Одно место на весь мессенджер.
function useMessenger() {
  const s = usePlayerStore();
  const project = s.project;
  const phone = s.state?.phone;
  const contacts = phone?.contacts || [];

  const contactOf = (id: string) => contacts.find((c) => c.id === id) || contacts.find((c) => c.characterId === id);
  const nameOf = (id: string): string => {
    const c = contactOf(id);
    if (!c) return project?.characters.find((x) => x.id === id)?.name || 'Без имени';
    return contactDisplayName(c, {
      characterName: (cid) => project?.characters.find((x) => x.id === cid)?.name,
      registryName: (rid) => s.state?.gm.registry?.find((r) => r.id === rid)?.canonicalName,
    });
  };
  const blobOf = (assetId?: string) => (assetId ? project?.assets.find((a) => a.id === assetId)?.blobKey : undefined);
  // Аватар контакта: своя картинка → нейтральный спрайт привязанного персонажа.
  const avatarOf = (id: string): string | undefined => {
    const c = contactOf(id);
    if (c?.avatarAssetId) return blobOf(c.avatarAssetId);
    const charId = c?.characterId || id;
    const char = project?.characters.find((x) => x.id === charId);
    return char ? blobOf(resolveSprite(char, undefined, 'neutral')) : undefined;
  };
  const chatTitle = (chat: PhoneChat): string =>
    chat.kind === 'group' ? chat.title || 'Группа' : nameOf(chat.participantIds[0] || '');
  const chatAvatar = (chat: PhoneChat): string | undefined =>
    chat.kind === 'group' ? blobOf(chat.avatarAssetId) : avatarOf(chat.participantIds[0] || '');
  const heroId = project?.characters.find((c) => c.role === 'protagonist')?.id;
  const heroName = s.state?.protagonistName || project?.characters.find((c) => c.role === 'protagonist')?.name || 'Я';
  const heroAvatar = blobOf(project?.phone?.heroAvatarAssetId);

  return { s, project, phone, contacts, contactOf, nameOf, blobOf, avatarOf, chatTitle, chatAvatar, heroId, heroName, heroAvatar };
}

// Кружок-аватар: картинка или буква имени (цвет стабилен для одного имени).
function Avatar({
  blobKey,
  name,
  size = 40,
  ring,
}: {
  blobKey?: string;
  name: string;
  size?: number;
  ring?: boolean;
}) {
  const letter = name.trim()[0]?.toUpperCase() || '?';
  const hues = ['from-emerald-400 to-teal-600', 'from-sky-400 to-indigo-600', 'from-fuchsia-400 to-purple-600', 'from-amber-400 to-orange-600', 'from-rose-400 to-pink-600'];
  let h = 0;
  for (const ch of name) h = (h + ch.charCodeAt(0)) % hues.length;
  return (
    <div
      className={`rounded-full overflow-hidden shrink-0 flex items-center justify-center text-white font-semibold bg-gradient-to-br ${hues[h]} ${
        ring ? 'ring-2 ring-white/20' : ''
      }`}
      style={{ width: size, height: size, fontSize: Math.round(size / 2.4) }}
    >
      {blobKey ? <AssetImage blobKey={blobKey} className="w-full h-full object-cover" /> : letter}
    </div>
  );
}

// Диалог подтверждения удаления (решение пользователя: «спрашивать при удалении»).
// Для чатов и контактов есть второй вопрос — забыть ли переписку самим ботам.
function ConfirmSheet({
  title,
  text,
  confirmLabel = 'Удалить',
  forgetLabel,
  onCancel,
  onConfirm,
}: {
  title: string;
  text: string;
  confirmLabel?: string;
  forgetLabel?: string;
  onCancel: () => void;
  onConfirm: (forget: boolean) => void;
}) {
  const [forget, setForget] = useState(false);
  return (
    <div className="absolute inset-0 z-30 bg-black/70 flex items-center justify-center p-4" onClick={onCancel}>
      <div className="w-full rounded-2xl bg-[#17212b] border border-white/10 p-4" onClick={(e) => e.stopPropagation()}>
        <div className="text-[15px] font-semibold text-white mb-1">{title}</div>
        <div className="text-xs text-white/60 mb-3">{text}</div>
        {forgetLabel && (
          <label className="flex items-start gap-2 text-xs text-white/80 mb-3 cursor-pointer">
            <input type="checkbox" className="mt-0.5" checked={forget} onChange={(e) => setForget(e.target.checked)} />
            <span>{forgetLabel}</span>
          </label>
        )}
        <div className="flex gap-2 justify-end">
          <button className="text-sm px-3 py-1.5 rounded-lg bg-white/10 text-white/80" onClick={onCancel}>
            Отмена
          </button>
          <button className="text-sm px-3 py-1.5 rounded-lg bg-red-500 text-white" onClick={() => onConfirm(forget)}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// Поле ввода, растущее под текст (просьба пользователя): высота считается по
// scrollHeight на каждое изменение, с потолком в 6 строк.
function GrowingInput({
  value,
  onChange,
  onSend,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  placeholder: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
  }, [value]);
  return (
    <textarea
      ref={ref}
      rows={1}
      className="flex-1 resize-none overflow-y-auto rounded-2xl bg-[#2a3942] px-4 py-2.5 text-sm text-white placeholder-white/40 outline-none scrollbar-thin"
      placeholder={placeholder}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          onSend();
        }
      }}
    />
  );
}

// ---- Тред переписки (личный или групповой) ----
function ChatThread({ chatId, onBack }: { chatId: string; onBack: () => void }) {
  const { s, project, phone, nameOf, avatarOf, chatTitle, chatAvatar, heroName, heroAvatar } = useMessenger();
  const [draft, setDraft] = useState('');
  // Прикреплённое фото ждёт отправки вместе с текстом (как в обычном мессенджере).
  const [attach, setAttach] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const chat = phone?.chats.find((c) => c.id === chatId);
  const msgs = chat?.messages || [];
  const typing = s.phoneTypingFrom === chatId;
  const attachKey = attach ? project?.assets.find((a) => a.id === attach)?.blobKey : undefined;

  // Автопрокрутка вниз при новых сообщениях / индикаторе печати.
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [msgs.length, typing]);

  if (!chat) {
    onBack();
    return null;
  }
  const isGroup = chat.kind === 'group';
  const title = chatTitle(chat);

  const send = () => {
    if (typing) return;
    const t = draft.trim();
    if (!t && !attach) return;
    setDraft('');
    const a = attach;
    setAttach(null);
    void s.sendChatMessage(chatId, t, a || undefined);
  };

  return (
    <div className="absolute inset-0 flex flex-col bg-[#0b141a]">
      {/* Шапка чата — аватар, имя, статус «печатает…» / состав группы */}
      <div className="flex items-center gap-2.5 px-2.5 py-2 bg-[#1f2c34] border-b border-black/30 shadow-sm z-10">
        <button className="text-white/90 text-2xl leading-none px-1 -mr-1" onClick={onBack}>‹</button>
        <button className="flex items-center gap-2.5 min-w-0 flex-1 text-left" onClick={() => setEditOpen(true)}>
          <Avatar blobKey={chatAvatar(chat)} name={title} size={36} />
          <div className="min-w-0 flex-1 leading-tight">
            <div className="font-semibold text-white text-[15px] truncate">{title}</div>
            <div className="text-[11px] h-3.5">
              {typing ? (
                <span className="text-emerald-400 flex items-center gap-1">
                  печата{isGroup ? 'ют' : 'ет'}
                  <span className="inline-flex gap-0.5">
                    <span className="w-1 h-1 rounded-full bg-emerald-400 animate-bounce [animation-delay:-0.3s]" />
                    <span className="w-1 h-1 rounded-full bg-emerald-400 animate-bounce [animation-delay:-0.15s]" />
                    <span className="w-1 h-1 rounded-full bg-emerald-400 animate-bounce" />
                  </span>
                </span>
              ) : isGroup ? (
                <span className="text-white/45 truncate block">
                  {chat.participantIds.length + 1} участник{chat.participantIds.length + 1 === 1 ? '' : 'а'}
                </span>
              ) : (
                <span className="text-white/45">в сети</span>
              )}
            </div>
          </div>
        </button>
      </div>

      {/* Лента сообщений на «обоях» мессенджера */}
      <div
        className="flex-1 overflow-y-auto scrollbar-thin px-2.5 py-3 space-y-1"
        style={{
          background:
            'radial-gradient(1200px 600px at 50% -10%, rgba(60,90,80,0.18), transparent), linear-gradient(180deg,#0b141a,#0d171e)',
        }}
      >
        {!msgs.length && !typing && (
          <div className="text-center text-white/40 text-sm py-8">
            {isGroup ? 'Пока тихо. Напишите первым.' : `Напишите первым — ${title} ответит.`}
          </div>
        )}
        {msgs.map((m, i) => {
          const mine = m.from === 'protagonist';
          const photoKey = m.attachedAssetId
            ? project?.assets.find((a) => a.id === m.attachedAssetId)?.blobKey
            : undefined;
          // Хвостик пузыря только у последнего в серии от одного отправителя.
          const next = msgs[i + 1];
          const nextSame = next?.from === m.from && next?.senderId === m.senderId;
          const prev = msgs[i - 1];
          const prevSame = prev?.from === m.from && prev?.senderId === m.senderId;
          const senderName = mine ? heroName : m.senderId ? nameOf(m.senderId) : title;
          const showSender = isGroup && !mine && !prevSame;
          const showAvatar = isGroup && !mine && !nextSame;
          const msgId = m.id;
          return (
            <div key={msgId || i} className={`flex items-end gap-1.5 ${mine ? 'justify-end' : 'justify-start'}`}>
              {isGroup && !mine && (
                <div className="w-7 shrink-0">
                  {showAvatar && <Avatar blobKey={m.senderId ? avatarOf(m.senderId) : undefined} name={senderName} size={28} />}
                </div>
              )}
              <div
                className={`relative max-w-[80%] text-[14px] leading-snug whitespace-pre-wrap break-words overflow-hidden shadow-sm ${
                  mine ? 'bg-[#005c4b] text-white' : 'bg-[#202c33] text-white'
                } ${
                  mine
                    ? nextSame ? 'rounded-2xl rounded-tr-md' : 'rounded-2xl rounded-br-md'
                    : nextSame ? 'rounded-2xl rounded-tl-md' : 'rounded-2xl rounded-bl-md'
                }`}
                onContextMenu={(e) => {
                  if (!msgId) return;
                  e.preventDefault();
                  setMenuFor(msgId);
                }}
                onDoubleClick={() => msgId && setMenuFor(msgId)}
              >
                {showSender && (
                  <div className="px-2.5 pt-1.5 text-[12px] font-semibold text-emerald-300">{senderName}</div>
                )}
                {photoKey && <AssetImage blobKey={photoKey} className="w-52 max-w-full object-cover block" />}
                {m.pendingPhoto && !photoKey && (
                  <div className="w-52 max-w-full aspect-[4/3] bg-black/40 flex flex-col items-center justify-center gap-1 text-white/60 text-xs">
                    <span className="w-5 h-5 rounded-full border-2 border-white/30 border-t-white/80 animate-spin" />
                    фото загружается…
                  </div>
                )}
                {m.photoFailed && !photoKey && (
                  <div className="w-52 max-w-full aspect-[4/3] bg-black/40 flex items-center justify-center text-white/40 text-xs px-3 text-center">
                    фото не загрузилось
                  </div>
                )}
                <div className="px-2.5 py-1.5">
                  {m.text && <span>{m.text}</span>}
                  <span className={`float-right ml-2 mt-1.5 text-[10px] leading-none ${mine ? 'text-white/60' : 'text-white/40'}`}>
                    {fmtTime(m.at)}
                    {mine && <span className="ml-0.5 text-[#53bdeb]">✓✓</span>}
                  </span>
                </div>
              </div>
              {mine && (
                <div className="w-7 shrink-0">
                  {!nextSame && <Avatar blobKey={heroAvatar} name={heroName} size={28} />}
                </div>
              )}
            </div>
          );
        })}
        {typing && (
          <div className="flex justify-start">
            <div className="px-3 py-2.5 rounded-2xl rounded-bl-md bg-[#202c33]">
              <span className="flex gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-white/60 animate-bounce [animation-delay:-0.3s]" />
                <span className="w-1.5 h-1.5 rounded-full bg-white/60 animate-bounce [animation-delay:-0.15s]" />
                <span className="w-1.5 h-1.5 rounded-full bg-white/60 animate-bounce" />
              </span>
            </div>
          </div>
        )}
        <div ref={endRef} />
      </div>

      {/* Прикреплённое фото — превью над строкой ввода */}
      {attach && (
        <div className="flex items-center gap-2 px-2 pt-2 bg-[#1f2c34]">
          <AssetImage blobKey={attachKey} className="w-12 h-12 rounded-lg object-cover" />
          <div className="text-xs text-white/60 flex-1">Фото прикреплено — добавьте подпись или отправьте так.</div>
          <button className="text-white/60 text-lg px-2" onClick={() => setAttach(null)} title="Убрать">
            ✕
          </button>
        </div>
      )}

      {/* Панель ввода */}
      <div className="flex items-end gap-2 p-2 bg-[#1f2c34]">
        <button
          className="w-11 h-11 rounded-full flex items-center justify-center shrink-0 text-white/70 hover:text-white hover:bg-white/10 active:scale-95 transition"
          onClick={() => setPickerOpen(true)}
          title="Прикрепить фото"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21.44 11.05 12.25 20.24a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
          </svg>
        </button>
        <GrowingInput
          value={draft}
          onChange={setDraft}
          onSend={send}
          placeholder={attach ? 'Подпись к фото (можно пусто)' : 'Сообщение'}
        />
        <button
          className="w-11 h-11 rounded-full bg-[#00a884] flex items-center justify-center shrink-0 disabled:opacity-40 active:scale-95 transition-transform"
          onClick={send}
          disabled={(!draft.trim() && !attach) || typing}
          title="Отправить"
        >
          <svg width="20" height="20" viewBox="0 0 24 24"><path d="M3 11.5 21 3l-8.5 18-2.2-7.3L3 11.5Z" fill="#fff" /></svg>
        </button>
      </div>

      {pickerOpen && (
        <PhotoPicker
          onClose={() => setPickerOpen(false)}
          onPick={(assetId) => {
            setAttach(assetId);
            setPickerOpen(false);
          }}
        />
      )}

      {menuFor && (
        <ConfirmSheet
          title="Удалить сообщение?"
          text="Сообщение исчезнет из переписки и из памяти истории."
          onCancel={() => setMenuFor(null)}
          onConfirm={() => {
            s.deleteMessage(chatId, menuFor);
            setMenuFor(null);
          }}
        />
      )}

      {editOpen && (
        isGroup ? (
          <GroupEditor chatId={chatId} onClose={() => setEditOpen(false)} onDeleted={onBack} />
        ) : (
          <ContactEditor
            contactId={chat.participantIds[0]}
            onClose={() => setEditOpen(false)}
            onDeleted={onBack}
          />
        )
      )}
    </div>
  );
}

// Выбор фото для отправки: из галереи телефона (всё, что снято камерой или
// загружено раньше) или с устройства — на телефоне системный диалог сам предложит
// и камеру, и галерею.
function PhotoPicker({ onClose, onPick }: { onClose: () => void; onPick: (assetId: string) => void }) {
  const s = usePlayerStore();
  const [busy, setBusy] = useState(false);
  const gallery = [...(s.state?.phone?.gallery || [])].reverse();

  async function upload(file: File) {
    setBusy(true);
    const id = await s.uploadPhonePhoto(file);
    setBusy(false);
    if (id) onPick(id);
    else onClose();
  }

  return (
    <div className="absolute inset-0 z-20 bg-black/70 flex items-end" onClick={onClose}>
      <div
        className="w-full rounded-t-2xl bg-[#141019] border-t border-white/10 p-3 max-h-[75%] overflow-y-auto scrollbar-thin"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-2">
          <div className="text-sm font-semibold text-white">Прикрепить фото</div>
          <button className="text-white/50 text-lg px-1" onClick={onClose}>✕</button>
        </div>

        <label className="w-full flex items-center gap-3 rounded-xl bg-white/5 hover:bg-white/10 px-3 py-2.5 text-left text-white cursor-pointer mb-3">
          <span className="text-lg">{busy ? '…' : '📷'}</span>
          <span className="text-sm">{busy ? 'Загружаю…' : 'Снять или выбрать на устройстве'}</span>
          <input
            type="file"
            accept="image/*"
            hidden
            disabled={busy}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void upload(f);
            }}
          />
        </label>

        <div className="text-xs uppercase tracking-wide text-white/50 mb-2">Галерея телефона · {gallery.length}</div>
        {gallery.length === 0 ? (
          <div className="text-sm text-white/40">Пока пусто — снимите фото камерой или загрузите своё.</div>
        ) : (
          <div className="grid grid-cols-3 gap-2">
            {gallery.map((assetId) => {
              const blobKey = s.project?.assets.find((a) => a.id === assetId)?.blobKey;
              return (
                <button
                  key={assetId}
                  className="rounded-xl overflow-hidden border border-white/10 bg-black/40 active:scale-95 transition-transform"
                  onClick={() => onPick(assetId)}
                >
                  <AssetImage blobKey={blobKey} className="w-full aspect-square object-cover" />
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ---- Приложение «Камера» (Batch 7 §5): генерация селфи протагониста ----
function CameraScreen({ onBack }: { onBack: () => void }) {
  const s = usePlayerStore();
  const project = s.project;
  const [prompt, setPrompt] = useState('');
  const [pickFor, setPickFor] = useState<string | null>(null); // assetId, который отправляем
  const [caption, setCaption] = useState(''); // подпись к отправляемому фото
  const [mode, setMode] = useState<'front' | 'rear'>('front');
  const busy = s.cameraBusy;
  const gallery = s.state?.phone?.gallery || [];
  const chats = (s.state?.phone?.chats || []).filter((c) => !c.archived && (c.kind === 'group' || c.participantIds.length > 0));

  // Fallback: нет спрайта протагониста или не настроено image-API → камера отключена.
  const protagonist = project?.characters.find((c) => c.role === 'protagonist');
  const hasSprite = !!protagonist && !!resolveSprite(protagonist, undefined, 'neutral');
  const hasKey = !!getApiKey('image');
  // Основной камере спрайт не нужен: она снимает не героя, а то, что вокруг.
  const ready = hasKey && (mode === 'rear' || hasSprite);

  const shoot = () => {
    if (!ready || busy) return;
    void s.takeSelfie(prompt, mode);
    setPrompt('');
  };

  return (
    <div className="absolute inset-0 flex flex-col">
      <div className="flex items-center gap-2 px-3 py-3 bg-black/30 backdrop-blur-md">
        <button className="text-white/90 text-xl leading-none" onClick={onBack}>‹</button>
        <div className="font-semibold text-white">Камера</div>
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-thin p-3 text-white">
        {/* Переключатель камер — как на настоящем телефоне */}
        <div className="flex gap-1 p-1 rounded-xl bg-white/5 border border-white/10 mb-2">
          {(
            [
              { id: 'front', label: '🤳 Фронталка', hint: 'селфи героя' },
              { id: 'rear', label: '📷 Основная', hint: 'что вокруг' },
            ] as const
          ).map((m) => (
            <button
              key={m.id}
              className={`flex-1 py-2 rounded-lg text-sm transition-colors ${
                mode === m.id ? 'bg-white/15 text-white' : 'text-white/60 hover:bg-white/5'
              }`}
              onClick={() => setMode(m.id)}
            >
              {m.label}
              <span className="block text-[10px] text-white/40">{m.hint}</span>
            </button>
          ))}
        </div>

        {!ready ? (
          <div className="rounded-xl bg-amber-500/12 border border-amber-400/30 px-3 py-3 text-sm text-amber-100">
            {hasKey
              ? 'Загрузите нейтральный спрайт протагониста — тогда фронталка заработает. Основная камера работает и без него.'
              : 'Настройте генерацию изображений (🎬 CG-студия → подключение) — тогда камера заработает.'}
          </div>
        ) : (
          <div className="space-y-2">
            <textarea
              className="w-full rounded-xl bg-white/10 border border-white/15 px-3 py-2 text-sm text-white placeholder-white/40 outline-none focus:border-fuchsia-400/50 h-16"
              placeholder={
                mode === 'front'
                  ? 'Что на фото? напр.: на фоне заката, улыбаюсь, в кафе'
                  : 'Что снимаем? напр.: кофе на столике, вечерняя улица под дождём, вид из окна'
              }
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
            />
            <button
              className="w-full py-2.5 rounded-xl bg-gradient-to-br from-fuchsia-500 to-purple-600 text-white font-medium disabled:opacity-50 flex items-center justify-center gap-2"
              onClick={shoot}
              disabled={busy}
            >
              {busy ? (
                <>
                  <span className="inline-block w-4 h-4 border-2 border-white/70 border-t-transparent rounded-full animate-spin" />
                  Снимаю…
                </>
              ) : mode === 'front' ? (
                '📸 Сделать селфи'
              ) : (
                '📸 Снять фото'
              )}
            </button>
            {mode === 'rear' && (
              <p className="text-[11px] text-white/40">
                Основная камера снимает то, что перед героем: локация и время подставляются из сцены, герой в кадр не попадает.
              </p>
            )}
          </div>
        )}

        <div className="mt-4 text-xs uppercase tracking-wide text-white/50 mb-2">Галерея · {gallery.length}</div>
        {gallery.length === 0 ? (
          <div className="text-sm text-white/40">Пока нет фото.</div>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {[...gallery].reverse().map((assetId) => {
              const blobKey = project?.assets.find((a) => a.id === assetId)?.blobKey;
              return (
                <div key={assetId} className="rounded-xl overflow-hidden border border-white/10 bg-black/40 relative group">
                  <AssetImage blobKey={blobKey} className="w-full aspect-square object-cover" />
                  {chats.length > 0 && (
                    <button
                      className="absolute bottom-1.5 right-1.5 text-[11px] px-2 py-1 rounded-lg bg-black/60 text-white opacity-0 group-hover:opacity-100 transition-opacity"
                      onClick={() => setPickFor(assetId)}
                    >
                      Отправить
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Выбор контакта для отправки фото */}
      {pickFor && (
        <div
          className="absolute inset-0 z-10 bg-black/70 flex items-end"
          onClick={() => {
            setPickFor(null);
            setCaption('');
          }}
        >
          <div
            className="w-full rounded-t-2xl bg-[#141019] border-t border-white/10 p-3 max-h-[70%] overflow-y-auto scrollbar-thin"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-sm font-semibold text-white mb-2">Кому отправить фото?</div>
            {/* Подпись к фото — уходит текстом того же сообщения. */}
            <textarea
              className="w-full rounded-xl bg-white/10 border border-white/15 px-3 py-2 text-sm text-white placeholder-white/40 outline-none focus:border-fuchsia-400/50 h-14 mb-2"
              placeholder="Подпись к фото (необязательно): смотри что у меня тут…"
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
            />
            <div className="space-y-1.5">
              {!chats.length && <div className="text-sm text-white/40">Чатов пока нет.</div>}
              {chats.map((c) => (
                <ChatPickRow
                  key={c.id}
                  chat={c}
                  onPick={() => {
                    void s.sendChatMessage(c.id, caption, pickFor);
                    setPickFor(null);
                    setCaption('');
                  }}
                />
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Строка выбора чата (отправка фото из камеры).
function ChatPickRow({ chat, onPick }: { chat: PhoneChat; onPick: () => void }) {
  const { chatTitle, chatAvatar } = useMessenger();
  const title = chatTitle(chat);
  return (
    <button
      className="w-full flex items-center gap-3 rounded-xl bg-white/5 hover:bg-white/10 px-3 py-2.5 text-left text-white"
      onClick={onPick}
    >
      <Avatar blobKey={chatAvatar(chat)} name={title} size={32} />
      <span className="text-sm truncate">
        {chat.kind === 'group' && <span className="text-white/40 mr-1">👥</span>}
        {title}
      </span>
    </button>
  );
}

// ---- Экран «Сообщения»: список чатов как в мессенджере (Телефон 2.0) ----
function ChatListScreen({ onBack, onOpenChat }: { onBack: () => void; onOpenChat: (chatId: string) => void }) {
  const { s, phone, contacts, nameOf, chatTitle, chatAvatar, heroId, heroName, heroAvatar } = useMessenger();
  const [scan, setScan] = useState<null | 'busy' | { names: string[]; checked: Record<string, boolean> }>(null);
  const [sheet, setSheet] = useState<null | 'new' | 'contacts' | 'group'>(null);
  const [editContact, setEditContact] = useState<string | null>(null);
  const [confirmChat, setConfirmChat] = useState<string | null>(null);
  const [heroAvatarOpen, setHeroAvatarOpen] = useState(false);

  const chats = [...(phone?.chats || [])]
    .filter((c) => !c.archived && (c.kind === 'group' || c.participantIds.length > 0))
    .sort((a, b) => (b.messages[b.messages.length - 1]?.at ?? 0) - (a.messages[a.messages.length - 1]?.at ?? 0));

  const runScan = async () => {
    if (!s.state) return;
    setScan('busy');
    try {
      const known = [
        ...contacts.map((c) => nameOf(c.id)),
        ...(s.project?.characters || []).map((c) => c.name),
      ];
      const names = await scanContacts(s.state, known, s.project ?? undefined);
      if (!names.length) {
        setScan(null);
        pushToast('info', 'Новых знакомых в контексте не нашлось.');
      } else {
        setScan({ names, checked: Object.fromEntries(names.map((n) => [n, true])) });
      }
    } catch (e) {
      setScan(null);
      pushToast('error', 'Не удалось просканировать: ' + (e instanceof Error ? e.message : String(e)));
    }
  };

  const confirmScan = () => {
    if (!scan || scan === 'busy') return;
    const chosen = scan.names.filter((n) => scan.checked[n]);
    if (chosen.length) s.addScannedContacts(chosen);
    setScan(null);
  };

  return (
    <div className="absolute inset-0 flex flex-col bg-[#17212b]">
      <div className="flex items-center gap-2 px-2.5 py-2.5 bg-[#1f2c34] border-b border-black/30">
        <button className="text-white/90 text-2xl leading-none px-1" onClick={onBack}>‹</button>
        <div className="font-semibold text-white flex-1">Сообщения</div>
        <button
          className="text-xs px-2.5 py-1 rounded-lg bg-white/10 hover:bg-white/15 text-white/90 disabled:opacity-50"
          onClick={runScan}
          disabled={scan === 'busy'}
          title="Найти знакомых в сюжете"
        >
          {scan === 'busy' ? '⏳' : '🔍'}
        </button>
        <button
          className="text-xs px-2.5 py-1 rounded-lg bg-emerald-500/80 hover:bg-emerald-500 text-white"
          onClick={() => setSheet('new')}
          title="Новый чат"
        >
          ✎
        </button>
      </div>

      {/* Свой профиль: аватарку героя можно поставить самому (просьба пользователя) */}
      <button
        className="flex items-center gap-3 px-3 py-2 bg-white/[0.03] hover:bg-white/[0.06] border-b border-white/5 text-left"
        onClick={() => setHeroAvatarOpen(true)}
      >
        <Avatar blobKey={heroAvatar} name={heroName} size={34} ring />
        <div className="min-w-0 flex-1">
          <div className="text-sm text-white truncate">{heroName}</div>
          <div className="text-[11px] text-white/45">это вы — нажмите, чтобы сменить аватарку</div>
        </div>
      </button>

      <div className="flex-1 overflow-y-auto scrollbar-thin">
        {!chats.length ? (
          <div className="text-sm text-white/50 p-4">
            Чатов пока нет. Они появятся сами, когда встретите персонажей, или создайте чат кнопкой ✎.
          </div>
        ) : (
          chats.map((chat) => {
            const last = chat.messages[chat.messages.length - 1];
            const unread = !!chat.unread;
            const title = chatTitle(chat);
            const prefix =
              chat.kind === 'group' && last
                ? `${last.from === 'protagonist' ? heroName : last.senderId ? nameOf(last.senderId) : '?'}: `
                : '';
            const preview = last ? `${prefix}${last.text || (last.attachedAssetId || last.pendingPhoto ? '📷 Фото' : '')}` : 'Нет сообщений';
            return (
              <div key={chat.id} className="flex items-stretch border-b border-white/5">
                <button
                  className="flex items-center gap-3 flex-1 min-w-0 px-3 py-2.5 text-left hover:bg-white/5"
                  onClick={() => onOpenChat(chat.id)}
                >
                  <Avatar blobKey={chatAvatar(chat)} name={title} size={46} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <div className="text-[15px] text-white truncate flex-1">
                        {chat.kind === 'group' && <span className="text-white/40 mr-1">👥</span>}
                        {title}
                      </div>
                      {last && <div className="text-[11px] text-white/40 shrink-0">{fmtTime(last.at)}</div>}
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="text-[13px] text-white/50 truncate flex-1">{preview}</div>
                      {unread && <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 shrink-0" />}
                    </div>
                  </div>
                </button>
                <button
                  className="px-2 text-white/30 hover:text-white/70 text-lg"
                  onClick={() => setConfirmChat(chat.id)}
                  title="Удалить чат"
                >
                  🗑
                </button>
              </div>
            );
          })
        )}
      </div>

      {/* Меню «новый чат» */}
      {sheet === 'new' && (
        <Sheet title="Новый чат" onClose={() => setSheet(null)}>
          <button
            className="w-full flex items-center gap-3 rounded-xl bg-white/5 hover:bg-white/10 px-3 py-2.5 text-left text-white mb-2"
            onClick={() => setSheet('group')}
          >
            <span className="text-lg">👥</span>
            <span className="text-sm">Создать группу</span>
          </button>
          <button
            className="w-full flex items-center gap-3 rounded-xl bg-white/5 hover:bg-white/10 px-3 py-2.5 text-left text-white mb-3"
            onClick={() => {
              const id = s.createContact({ name: 'Новый контакт' });
              setSheet(null);
              setEditContact(id);
            }}
          >
            <span className="text-lg">➕</span>
            <span className="text-sm">Новый контакт</span>
          </button>
          <div className="text-xs uppercase tracking-wide text-white/40 mb-2">Контакты</div>
          {!contacts.length && <div className="text-sm text-white/40">Контактов пока нет.</div>}
          <div className="space-y-1">
            {contacts
              .filter((c) => !c.hidden)
              .map((c) => (
                <div key={c.id} className="flex items-center gap-2">
                  <button
                    className="flex items-center gap-3 flex-1 min-w-0 rounded-xl bg-white/5 hover:bg-white/10 px-3 py-2 text-left text-white"
                    onClick={() => {
                      const chatId = s.openDirectChat(c.id);
                      setSheet(null);
                      onOpenChat(chatId);
                    }}
                  >
                    <Avatar blobKey={undefined} name={nameOf(c.id)} size={32} />
                    <span className="text-sm truncate">{nameOf(c.id)}</span>
                  </button>
                  <button
                    className="px-2 text-white/40 hover:text-white"
                    onClick={() => {
                      setSheet(null);
                      setEditContact(c.id);
                    }}
                    title="Изменить контакт"
                  >
                    ✎
                  </button>
                </div>
              ))}
          </div>
        </Sheet>
      )}

      {sheet === 'group' && (
        <GroupEditor
          onClose={() => setSheet(null)}
          onCreated={(chatId) => {
            setSheet(null);
            onOpenChat(chatId);
          }}
        />
      )}

      {editContact && (
        <ContactEditor
          contactId={editContact}
          onClose={() => setEditContact(null)}
          onOpenChat={(chatId) => {
            setEditContact(null);
            onOpenChat(chatId);
          }}
        />
      )}

      {heroAvatarOpen && (
        <AvatarPicker
          title="Ваша аватарка"
          subject={{ kind: 'person', name: heroName, personId: heroId }}
          onClose={() => setHeroAvatarOpen(false)}
          onPick={(assetId) => {
            void s.patchProject((p) => {
              p.phone = { ...(p.phone ?? defaultPhoneConfig()), heroAvatarAssetId: assetId };
            });
            setHeroAvatarOpen(false);
          }}
        />
      )}

      {confirmChat && (
        <ConfirmSheet
          title="Удалить чат?"
          text="Чат исчезнет из мессенджера."
          forgetLabel="Ещё и стереть переписку из памяти — тогда боты забудут, о чём вы говорили. Без галочки они всё помнят."
          onCancel={() => setConfirmChat(null)}
          onConfirm={(forget) => {
            s.deleteChat(confirmChat, { forget });
            setConfirmChat(null);
          }}
        />
      )}

      {/* Чек-лист найденных при сканировании — ничего не добавляем без подтверждения. */}
      {scan && scan !== 'busy' && (
        <Sheet title="Найденные знакомые" onClose={() => setScan(null)}>
          <div className="text-[11px] text-white/50 mb-2">Отметьте, кого добавить в контакты.</div>
          <div className="space-y-1">
            {scan.names.map((n) => (
              <label key={n} className="flex items-center gap-2 rounded-lg bg-white/5 px-3 py-2 text-sm text-white">
                <input
                  type="checkbox"
                  checked={scan.checked[n]}
                  onChange={(e) => setScan({ ...scan, checked: { ...scan.checked, [n]: e.target.checked } })}
                />
                {n}
              </label>
            ))}
          </div>
          <div className="flex gap-2 justify-end mt-3">
            <button className="text-sm px-3 py-1.5 rounded-lg bg-white/10 text-white/80" onClick={() => setScan(null)}>
              Отмена
            </button>
            <button className="text-sm px-3 py-1.5 rounded-lg bg-emerald-500 text-white" onClick={confirmScan}>
              Добавить
            </button>
          </div>
        </Sheet>
      )}
    </div>
  );
}

// Нижняя шторка — общий контейнер для меню/редакторов телефона.
function Sheet({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  return (
    <div className="absolute inset-0 z-20 bg-black/70 flex items-end" onClick={onClose}>
      <div
        className="w-full rounded-t-2xl bg-[#141019] border-t border-white/10 p-3 max-h-[85%] overflow-y-auto scrollbar-thin"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-2">
          <div className="text-sm font-semibold text-white">{title}</div>
          <button className="text-white/50 text-lg px-1" onClick={onClose}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

// Выбор аватарки: из галереи телефона, с устройства или генерация через image-API
// (решение пользователя: «настройка руками + возможность сгенерировать»).
function AvatarPicker({
  title,
  subject,
  onClose,
  onPick,
}: {
  title: string;
  // Кого рисуем: имя + id для референса из CG-студии. Описание внешности
  // подтягивается из карточки/досье — поле ниже нужно только чтобы уточнить.
  subject: AvatarSubject;
  onClose: () => void;
  onPick: (assetId: string | undefined) => void;
}) {
  const s = usePlayerStore();
  const [extra, setExtra] = useState(subject.description || '');
  const [busy, setBusy] = useState(false);
  const gallery = [...(s.state?.phone?.gallery || [])].reverse();
  // Что движок знает о внешности этого человека без нас (показываем, чтобы было
  // видно: аватарка рисуется не «по имени», а по карточке + рефу).
  const known =
    subject.kind === 'person' && s.project && s.state
      ? describePerson(s.project, s.state, { name: subject.name, personId: subject.personId })
      : '';
  const refAsset =
    subject.kind === 'person' && subject.personId && s.project
      ? s.project.imageGen?.references?.[subject.personId] ||
        s.project.characters.find((c) => c.id === subject.personId)?.sprites?.neutral
      : undefined;

  async function upload(file: File) {
    setBusy(true);
    const id = await s.uploadPhonePhoto(file);
    setBusy(false);
    if (id) onPick(id);
  }

  async function generate() {
    setBusy(true);
    const id = await s.generateAvatar({ ...subject, description: extra.trim() || subject.description });
    setBusy(false);
    if (id) onPick(id);
  }

  return (
    <Sheet title={title} onClose={onClose}>
      <label className="w-full flex items-center gap-3 rounded-xl bg-white/5 hover:bg-white/10 px-3 py-2.5 text-left text-white cursor-pointer mb-2">
        <span className="text-lg">{busy ? '…' : '🖼'}</span>
        <span className="text-sm">Загрузить своё изображение</span>
        <input
          type="file"
          accept="image/*"
          hidden
          disabled={busy}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void upload(f);
          }}
        />
      </label>

      <div className="rounded-xl bg-white/5 p-2.5 mb-3">
        <div className="text-[11px] text-white/50 mb-1.5">
          {subject.kind === 'group' ? 'Или сгенерировать иконку группы:' : 'Или сгенерировать в стиле проекта:'}
        </div>
        {subject.kind === 'person' && (
          <div className="text-[11px] text-white/40 mb-1.5 leading-snug">
            {refAsset ? '✓ реф из CG-студии' : '⚠ рефа нет — задайте его в 🎬 CG-студии'}
            {known ? ` · внешность из карточки: ${known.slice(0, 90)}${known.length > 90 ? '…' : ''}` : ' · описания внешности нет'}
          </div>
        )}
        <div className="flex gap-2">
          <input
            className="flex-1 rounded-lg bg-black/40 px-2.5 py-1.5 text-sm text-white outline-none"
            placeholder={subject.kind === 'group' ? 'о чём чат (необязательно)' : 'уточнение (необязательно)'}
            value={extra}
            onChange={(e) => setExtra(e.target.value)}
          />
          <button
            className="text-sm px-3 py-1.5 rounded-lg bg-fuchsia-500/80 hover:bg-fuchsia-500 text-white disabled:opacity-40"
            onClick={generate}
            disabled={busy || (subject.kind === 'group' && !subject.name.trim())}
          >
            {busy ? '…' : '✨'}
          </button>
        </div>
      </div>

      <div className="flex items-center justify-between mb-2">
        <div className="text-xs uppercase tracking-wide text-white/50">Галерея · {gallery.length}</div>
        <button className="text-xs text-white/50 hover:text-white/80" onClick={() => onPick(undefined)}>
          Убрать аватарку
        </button>
      </div>
      {gallery.length === 0 ? (
        <div className="text-sm text-white/40">Пока пусто.</div>
      ) : (
        <div className="grid grid-cols-3 gap-2">
          {gallery.map((assetId) => {
            const blobKey = s.project?.assets.find((a) => a.id === assetId)?.blobKey;
            return (
              <button
                key={assetId}
                className="rounded-xl overflow-hidden border border-white/10 bg-black/40 active:scale-95 transition-transform"
                onClick={() => onPick(assetId)}
              >
                <AssetImage blobKey={blobKey} className="w-full aspect-square object-cover" />
              </button>
            );
          })}
        </div>
      )}
    </Sheet>
  );
}

// ---- Редактор контакта: имя, привязка к персонажу/реестру, аватар, болтливость ----
function ContactEditor({
  contactId,
  onClose,
  onDeleted,
  onOpenChat,
}: {
  contactId: string;
  onClose: () => void;
  onDeleted?: () => void;
  // Есть — показываем кнопку «Написать» (заводит личный чат и открывает его).
  onOpenChat?: (chatId: string) => void;
}) {
  const { s, project, contacts, nameOf, avatarOf } = useMessenger();
  const contact = contacts.find((c) => c.id === contactId);
  const [avatarOpen, setAvatarOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  if (!contact) return null;

  const registry = s.state?.gm.registry || [];
  // Привязка: персонажи проекта + записи реестра Game Master, у которых нет карточки.
  const bindValue = contact.characterId ? `char:${contact.characterId}` : contact.registryId ? `reg:${contact.registryId}` : '';
  const setBind = (v: string) => {
    if (v.startsWith('char:')) s.updateContact(contactId, { characterId: v.slice(5), registryId: undefined });
    else if (v.startsWith('reg:')) s.updateContact(contactId, { registryId: v.slice(4), characterId: undefined });
    else s.updateContact(contactId, { characterId: undefined, registryId: undefined });
  };

  return (
    <Sheet title="Контакт" onClose={onClose}>
      <div className="flex items-center gap-3 mb-3">
        <button onClick={() => setAvatarOpen(true)} title="Сменить аватарку">
          <Avatar blobKey={avatarOf(contactId)} name={nameOf(contactId)} size={56} ring />
        </button>
        <div className="flex-1">
          <label className="block text-[11px] text-white/50 mb-1">Имя в телефоне</label>
          <input
            className="w-full rounded-lg bg-black/40 px-2.5 py-1.5 text-sm text-white outline-none"
            placeholder={nameOf(contactId)}
            value={contact.name || ''}
            onChange={(e) => s.updateContact(contactId, { name: e.target.value })}
          />
        </div>
      </div>

      <label className="block text-[11px] text-white/50 mb-1">Кто это в истории</label>
      <select
        className="w-full rounded-lg bg-black/40 px-2.5 py-2 text-sm text-white outline-none mb-1"
        value={bindValue}
        onChange={(e) => setBind(e.target.value)}
      >
        <option value="">Не привязан (просто контакт)</option>
        <optgroup label="Персонажи проекта">
          {(project?.characters || []).map((c) => (
            <option key={c.id} value={`char:${c.id}`}>
              {c.name}
            </option>
          ))}
        </optgroup>
        <optgroup label="Найдены Game Master'ом">
          {registry
            .filter((r) => !project?.characters.some((c) => c.id === r.id))
            .map((r) => (
              <option key={r.id} value={`reg:${r.id}`}>
                {r.canonicalName}
              </option>
            ))}
        </optgroup>
      </select>
      <div className="text-[11px] text-white/40 mb-3">
        Привязка даёт боту характер и память о персонаже. Если карточки нет (мама, папа, коллега) —
        опишите его ниже, этого достаточно.
      </div>

      <label className="block text-[11px] text-white/50 mb-1">Кто это и как себя ведёт</label>
      <textarea
        className="w-full rounded-lg bg-black/40 px-2.5 py-2 text-sm text-white outline-none resize-y min-h-[64px] mb-1"
        placeholder="Например: мама героя, 52 года, заботливая и тревожная, шлёт голосовые и открытки, зовёт домой на выходные"
        value={contact.note || ''}
        onChange={(e) => s.updateContact(contactId, { note: e.target.value })}
      />
      <div className="text-[11px] text-white/40 mb-3">
        Уходит боту в промпт — из этого он и берёт характер, если карточки персонажа нет.
      </div>

      <label className="block text-[11px] text-white/50 mb-1">
        Болтливость · {contact.chattiness ?? 50}
      </label>
      <input
        type="range"
        min={0}
        max={100}
        value={contact.chattiness ?? 50}
        onChange={(e) => s.updateContact(contactId, { chattiness: Number(e.target.value) })}
        className="w-full mb-1"
      />
      <div className="text-[11px] text-white/40 mb-4">
        Насколько охотно встревает в групповых чатах и пишет первым.
      </div>

      <div className="flex gap-2">
        {onOpenChat && (
          <button
            className="flex-1 py-2 rounded-xl bg-emerald-500 text-white text-sm"
            onClick={() => {
              const chatId = s.openDirectChat(contactId);
              onClose();
              onOpenChat(chatId);
            }}
          >
            Написать
          </button>
        )}
        <button
          className={`${onOpenChat ? 'px-3' : 'flex-1'} py-2 rounded-xl bg-red-500/20 border border-red-400/40 text-sm text-red-200`}
          onClick={() => setConfirm(true)}
        >
          {onOpenChat ? '🗑' : 'Удалить контакт'}
        </button>
      </div>

      {avatarOpen && (
        <AvatarPicker
          title="Аватарка контакта"
          subject={{
            kind: 'person',
            name: nameOf(contactId),
            personId: contact.characterId || contact.registryId || contact.id,
          }}
          onClose={() => setAvatarOpen(false)}
          onPick={(assetId) => {
            s.updateContact(contactId, { avatarAssetId: assetId });
            setAvatarOpen(false);
          }}
        />
      )}
      {confirm && (
        <ConfirmSheet
          title="Удалить контакт?"
          text="Контакт исчезнет из телефона."
          forgetLabel="Ещё и стереть переписку из памяти — тогда бот забудет, о чём вы говорили."
          onCancel={() => setConfirm(false)}
          onConfirm={(forget) => {
            s.deleteContact(contactId, { forget });
            setConfirm(false);
            onClose();
            onDeleted?.();
          }}
        />
      )}
    </Sheet>
  );
}

// ---- Редактор группы: название, фото, состав, оживлённость, логика ----
function GroupEditor({
  chatId,
  onClose,
  onCreated,
  onDeleted,
}: {
  chatId?: string;
  onClose: () => void;
  onCreated?: (chatId: string) => void;
  onDeleted?: () => void;
}) {
  const { s, phone, contacts, nameOf, blobOf } = useMessenger();
  const existing = chatId ? phone?.chats.find((c) => c.id === chatId) : undefined;
  const [title, setTitle] = useState(existing?.title || '');
  const [members, setMembers] = useState<string[]>(existing?.participantIds || []);
  const [activity, setActivity] = useState(existing?.groupActivity ?? 50);
  const [topic, setTopic] = useState(existing?.topic || '');
  const [avatar, setAvatar] = useState<string | undefined>(existing?.avatarAssetId);
  const [avatarOpen, setAvatarOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);

  const toggle = (id: string) =>
    setMembers((m) => (m.includes(id) ? m.filter((x) => x !== id) : [...m, id]));

  const save = () => {
    if (existing) {
      s.updateChat(existing.id, {
        title: title.trim() || 'Группа',
        participantIds: members,
        groupActivity: activity,
        topic: topic.trim() || undefined,
        avatarAssetId: avatar,
      });
      onClose();
    } else {
      const id = s.createGroupChat({
        title: title.trim() || 'Новая группа',
        participantIds: members,
        groupActivity: activity,
        topic: topic.trim() || undefined,
        avatarAssetId: avatar,
      });
      onCreated?.(id);
    }
  };

  return (
    <Sheet title={existing ? 'Настройки группы' : 'Новая группа'} onClose={onClose}>
      <div className="flex items-center gap-3 mb-3">
        <button onClick={() => setAvatarOpen(true)} title="Фото группы">
          <Avatar blobKey={blobOf(avatar)} name={title || 'Группа'} size={56} ring />
        </button>
        <div className="flex-1">
          <label className="block text-[11px] text-white/50 mb-1">Название</label>
          <input
            className="w-full rounded-lg bg-black/40 px-2.5 py-1.5 text-sm text-white outline-none"
            placeholder="Например: Одногруппники"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>
      </div>

      <label className="block text-[11px] text-white/50 mb-1">Участники · {members.length}</label>
      {!contacts.length && <div className="text-sm text-white/40 mb-3">Сначала заведите контакты.</div>}
      <div className="space-y-1 mb-3 max-h-44 overflow-y-auto scrollbar-thin">
        {contacts
          .filter((c) => !c.hidden)
          .map((c) => (
            <label key={c.id} className="flex items-center gap-2.5 rounded-lg bg-white/5 px-2.5 py-2 text-sm text-white cursor-pointer">
              <input type="checkbox" checked={members.includes(c.id)} onChange={() => toggle(c.id)} />
              <Avatar blobKey={undefined} name={nameOf(c.id)} size={26} />
              <span className="truncate flex-1">{nameOf(c.id)}</span>
            </label>
          ))}
      </div>

      <label className="block text-[11px] text-white/50 mb-1">Оживлённость чата · {activity}</label>
      <input type="range" min={0} max={100} value={activity} onChange={(e) => setActivity(Number(e.target.value))} className="w-full mb-1" />
      <div className="text-[11px] text-white/40 mb-3">
        Как часто участники пишут сами, без вас. Кто именно ответит — решает ИИ по контексту и болтливости контакта.
      </div>

      <label className="block text-[11px] text-white/50 mb-1">О чём этот чат / логика</label>
      <textarea
        className="w-full rounded-lg bg-black/40 px-2.5 py-2 text-sm text-white outline-none resize-y min-h-[64px] mb-3"
        placeholder="Например: рабочий чат смены, тут обсуждают графики и сплетничают о начальнике"
        value={topic}
        onChange={(e) => setTopic(e.target.value)}
      />

      <div className="flex gap-2">
        <button
          className="flex-1 py-2 rounded-xl bg-emerald-500 text-white text-sm disabled:opacity-40"
          onClick={save}
          disabled={!members.length}
        >
          {existing ? 'Сохранить' : 'Создать группу'}
        </button>
        {existing && (
          <button className="px-3 py-2 rounded-xl bg-red-500/20 border border-red-400/40 text-sm text-red-200" onClick={() => setConfirm(true)}>
            🗑
          </button>
        )}
      </div>

      {avatarOpen && (
        <AvatarPicker
          title="Фото группы"
          subject={{ kind: 'group', name: title, description: topic }}
          onClose={() => setAvatarOpen(false)}
          onPick={(assetId) => {
            setAvatar(assetId);
            setAvatarOpen(false);
          }}
        />
      )}
      {confirm && existing && (
        <ConfirmSheet
          title="Удалить группу?"
          text="Групповой чат исчезнет из мессенджера."
          forgetLabel="Ещё и стереть переписку из памяти — тогда боты забудут, о чём там говорили."
          onCancel={() => setConfirm(false)}
          onConfirm={(forget) => {
            s.deleteChat(existing.id, { forget });
            setConfirm(false);
            onClose();
            onDeleted?.();
          }}
        />
      )}
    </Sheet>
  );
}

// ---- Приложение «Банк» (Batch 8 §III): баланс, ручная правка, регулярные статьи, выписка ----
function BankScreen({ onBack }: { onBack: () => void }) {
  const s = usePlayerStore();
  const { cfg } = useCfg();
  const project = s.project;
  const balance = s.state?.statValues[PHONE_BALANCE_STAT] ?? 0;
  const phone = s.state?.phone;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  const fin = project?.finance ?? defaultFinanceConfig();
  const patchFin = (mut: (f: { startingBalance: number; startDate?: string; recurringEntries: RecurringEntry[] }) => void) =>
    s.patchProject((p) => {
      const f = p.finance ?? defaultFinanceConfig();
      mut(f);
      p.finance = f;
    });
  const addRecurring = () =>
    patchFin((f) => {
      f.recurringEntries.push({
        id: `rec_${Math.random().toString(36).slice(2, 8)}`,
        name: 'Новая статья',
        amount: 0,
        kind: 'expense',
        periodDays: 30,
        nextChargeDate: s.state?.gm.clock.date || '',
        enabled: true,
      });
    });

  const commitBalance = () => {
    const n = Number(draft.replace(',', '.'));
    if (Number.isFinite(n)) s.setBalance(n);
    setEditing(false);
  };

  return (
    <div className="absolute inset-0 flex flex-col">
      <div className="flex items-center gap-2 px-3 py-3 bg-black/30 backdrop-blur-md">
        <button className="text-white/90 text-xl leading-none" onClick={onBack}>‹</button>
        <div className="font-semibold text-white">Банк</div>
      </div>
      <div className="flex-1 overflow-y-auto scrollbar-thin p-3 text-white">
        <div className={`rounded-2xl border p-4 mb-4 ${balance < 0 ? 'bg-red-600/20 border-red-500/40' : 'bg-gradient-to-br from-sky-500/30 to-indigo-600/30 border-white/10'}`}>
          <div className="text-xs text-white/70 flex items-center justify-between">
            <span>Баланс {balance < 0 && '· долг'}</span>
            <button className="text-[11px] underline text-white/70" onClick={() => { setDraft(String(balance)); setEditing((v) => !v); }}>
              изменить
            </button>
          </div>
          {editing ? (
            <div className="flex items-center gap-2 mt-1">
              <input
                className="flex-1 rounded-lg bg-black/30 border border-white/20 px-3 py-1.5 text-lg text-white outline-none"
                type="number"
                value={draft}
                autoFocus
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && commitBalance()}
              />
              <button className="px-3 py-1.5 rounded-lg bg-sky-500 text-white text-sm" onClick={commitBalance}>OK</button>
            </div>
          ) : (
            <div className="text-3xl font-bold">{money(balance, cfg.currencyName)}</div>
          )}
        </div>

        {/* Регулярные статьи */}
        <div className="flex items-center justify-between mb-1.5">
          <div className="text-xs uppercase tracking-wide text-white/50">Регулярные статьи</div>
          <button className="text-[11px] text-sky-300" onClick={addRecurring}>+ добавить</button>
        </div>
        {fin.recurringEntries.length === 0 ? (
          <div className="text-sm text-white/40 mb-4">Нет статей. Зарплата/аренда начисляются по внутриигровым датам.</div>
        ) : (
          <div className="space-y-2 mb-4">
            {fin.recurringEntries.map((e, i) => (
              <div key={e.id} className="rounded-xl bg-white/5 border border-white/10 p-2.5 space-y-1.5">
                <div className="flex items-center gap-2">
                  <input
                    className="flex-1 bg-transparent border-b border-white/15 text-sm outline-none"
                    value={e.name}
                    onChange={(ev) => patchFin((f) => { f.recurringEntries[i].name = ev.target.value; })}
                  />
                  <label className="flex items-center gap-1 text-[11px] text-white/60">
                    <input type="checkbox" checked={e.enabled} onChange={(ev) => patchFin((f) => { f.recurringEntries[i].enabled = ev.target.checked; })} />
                    вкл
                  </label>
                  <button className="text-red-300 text-xs" onClick={() => patchFin((f) => { f.recurringEntries.splice(i, 1); })}>🗑</button>
                </div>
                <div className="flex items-center gap-2 text-xs">
                  <select
                    className="bg-black/30 border border-white/15 rounded px-1.5 py-1"
                    value={e.kind}
                    onChange={(ev) => patchFin((f) => { f.recurringEntries[i].kind = ev.target.value as 'income' | 'expense'; })}
                  >
                    <option value="income">доход</option>
                    <option value="expense">расход</option>
                  </select>
                  <input
                    className="w-20 bg-black/30 border border-white/15 rounded px-1.5 py-1"
                    type="number"
                    value={e.amount}
                    onChange={(ev) => patchFin((f) => { f.recurringEntries[i].amount = Math.abs(Math.round(Number(ev.target.value) || 0)); })}
                    placeholder="сумма"
                  />
                  <span className="text-white/40">кажд.</span>
                  <input
                    className="w-14 bg-black/30 border border-white/15 rounded px-1.5 py-1"
                    type="number"
                    value={e.periodDays}
                    onChange={(ev) => patchFin((f) => { f.recurringEntries[i].periodDays = Math.max(1, Math.round(Number(ev.target.value) || 30)); })}
                  />
                  <span className="text-white/40">дн.</span>
                </div>
                <input
                  className="w-full bg-black/30 border border-white/15 rounded px-1.5 py-1 text-xs"
                  value={e.nextChargeDate}
                  onChange={(ev) => patchFin((f) => { f.recurringEntries[i].nextChargeDate = ev.target.value; })}
                  placeholder="Следующее начисление ДД/ММ/ГГГГ"
                />
              </div>
            ))}
          </div>
        )}

        {/* Выписка */}
        <div className="text-xs uppercase tracking-wide text-white/50 mb-2">Выписка</div>
        {!phone?.transactions.length ? (
          <div className="text-sm text-white/50">Транзакций пока нет.</div>
        ) : (
          <div className="space-y-1.5">
            {[...phone.transactions].reverse().map((t, i) => {
              const title = t.vendor || t.reason || '—';
              const sub = [t.item && t.item !== t.vendor ? t.item : '', t.date, t.time].filter(Boolean).join(' · ');
              return (
                <div key={i} className="flex justify-between items-start gap-2 rounded-lg bg-white/5 px-3 py-2 text-sm">
                  <div className="min-w-0 flex-1">
                    <div className="text-white/85 truncate">{title}</div>
                    {sub && <div className="text-[11px] text-white/45 truncate">{sub}</div>}
                  </div>
                  <span className={`shrink-0 ${t.amount >= 0 ? 'text-green-400' : 'text-red-300'}`}>
                    {t.amount >= 0 ? '+' : ''}
                    {money(t.amount, cfg.currencyName)}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

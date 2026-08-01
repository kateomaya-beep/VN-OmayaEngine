import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { usePlayerStore } from '../playerStore';
import { AssetImage } from '../../../shared/ui';
import { defaultPhoneConfig, defaultFinanceConfig, PHONE_BALANCE_STAT, type PhoneConfig, type RecurringEntry } from '../../../shared/types';
import { resolveSprite } from '../../../shared/outfits';
import { getApiKey } from '../../../ai/keys';
import { scanContacts } from '../../../ai/gmScan';
import { pushToast } from '../../../shared/toast';

// Расширение «Телефон» (Batch 7). ФАЗА 1 — каркас: перетаскиваемая иконка + окно
// (рабочий стол с сеткой приложений) + читаемые экраны Банк/Сообщения/Магазин +
// заглушки действий. Мессенджер-ИИ, покупки, камера и связь с контекстом — следующие фазы.
// Иконки нарисованы свои (НЕ копии фирменных Apple).

type App = 'home' | 'messages' | 'bank' | 'delivery' | 'camera';

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
    delivery: (
      <>
        <path d="M3 8h11v7H3z" fill="none" stroke="#fff" strokeWidth="1.6" />
        <path d="M14 10h4l3 3v2h-7z" fill="none" stroke="#fff" strokeWidth="1.6" />
        <circle cx="7" cy="17" r="1.8" fill="none" stroke="#fff" strokeWidth="1.6" />
        <circle cx="17.5" cy="17" r="1.8" fill="none" stroke="#fff" strokeWidth="1.6" />
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
    delivery: 'from-amber-400 to-orange-600',
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
  const unread = s.state?.phone?.unreadFrom?.length ?? 0;
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
  const [chatWith, setChatWith] = useState<string | null>(null);
  if (!open || !cfg.enabled || !s.project || !s.state) return null;
  const project = s.project;
  const phone = s.state.phone;
  const balance = s.state.statValues[PHONE_BALANCE_STAT] ?? 0;
  const wallpaperKey = project.assets.find((a) => a.id === cfg.wallpaperAssetId)?.blobKey;

  const contactName = (id: string) => project.characters.find((c) => c.id === id)?.name || id;
  const openChat = (id: string) => {
    setChatWith(id);
    s.markPhoneRead(id);
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
                ['delivery', 'Доставка'],
                ['camera', 'Камера'],
              ] as [App, string][]).map(([id, label]) => (
                <button key={id} className="flex flex-col items-center gap-1" onClick={() => { setChatWith(null); setApp(id); }}>
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

        {app === 'messages' && !chatWith && (
          <ContactsScreen onBack={() => setApp('home')} onOpenChat={openChat} contactName={contactName} />
        )}

        {app === 'messages' && chatWith && (
          <ChatThread
            characterId={chatWith}
            name={contactName(chatWith)}
            onBack={() => setChatWith(null)}
          />
        )}

        {app === 'delivery' && (
          <DeliveryScreen onBack={() => setApp('home')} />
        )}

        {app === 'camera' && <CameraScreen onBack={() => setApp('home')} />}
      </div>
    </div>,
    document.body
  );
}

// ---- Тред переписки с персонажем (мессенджер + ответы ИИ) ----
function ChatThread({ characterId, name, onBack }: { characterId: string; name: string; onBack: () => void }) {
  const s = usePlayerStore();
  const [draft, setDraft] = useState('');
  // Прикреплённое фото ждёт отправки вместе с текстом (как в обычном мессенджере).
  const [attach, setAttach] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const msgs = s.state?.phone?.conversations[characterId] || [];
  const typing = s.phoneTypingFrom === characterId;
  const attachKey = attach ? s.project?.assets.find((a) => a.id === attach)?.blobKey : undefined;

  // Автопрокрутка вниз при новых сообщениях / индикаторе печати.
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [msgs.length, typing]);

  const send = () => {
    if (typing) return;
    const t = draft.trim();
    if (attach) {
      // Фото + подпись одним сообщением.
      setDraft('');
      setAttach(null);
      void s.sendPhoto(characterId, attach, t);
      return;
    }
    if (!t) return;
    setDraft('');
    void s.sendPhoneMessage(characterId, t);
  };

  // Инициалы для аватара.
  const initial = name.trim()[0]?.toUpperCase() || '?';

  return (
    <div className="absolute inset-0 flex flex-col bg-[#0b141a]">
      {/* Шапка чата — аватар, имя, статус «печатает…» / «в сети» */}
      <div className="flex items-center gap-2.5 px-2.5 py-2 bg-[#1f2c34] border-b border-black/30 shadow-sm z-10">
        <button className="text-white/90 text-2xl leading-none px-1 -mr-1" onClick={onBack}>‹</button>
        <div className="w-9 h-9 rounded-full bg-gradient-to-br from-emerald-400 to-teal-600 flex items-center justify-center text-sm font-semibold text-white shrink-0">
          {initial}
        </div>
        <div className="min-w-0 flex-1 leading-tight">
          <div className="font-semibold text-white text-[15px] truncate">{name}</div>
          <div className="text-[11px] h-3.5">
            {typing ? (
              <span className="text-emerald-400 flex items-center gap-1">
                печатает
                <span className="inline-flex gap-0.5">
                  <span className="w-1 h-1 rounded-full bg-emerald-400 animate-bounce [animation-delay:-0.3s]" />
                  <span className="w-1 h-1 rounded-full bg-emerald-400 animate-bounce [animation-delay:-0.15s]" />
                  <span className="w-1 h-1 rounded-full bg-emerald-400 animate-bounce" />
                </span>
              </span>
            ) : (
              <span className="text-white/45">в сети</span>
            )}
          </div>
        </div>
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
          <div className="text-center text-white/40 text-sm py-8">Напишите первым — {name} ответит.</div>
        )}
        {msgs.map((m, i) => {
          const mine = m.from === 'protagonist';
          const photoKey = m.attachedAssetId
            ? s.project?.assets.find((a) => a.id === m.attachedAssetId)?.blobKey
            : undefined;
          // Хвостик пузыря только у последнего в серии от одного отправителя.
          const nextSame = msgs[i + 1]?.from === m.from;
          return (
            <div key={i} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
              <div
                className={`relative max-w-[80%] text-[14px] leading-snug whitespace-pre-wrap break-words overflow-hidden shadow-sm ${
                  mine ? 'bg-[#005c4b] text-white' : 'bg-[#202c33] text-white'
                } ${
                  mine
                    ? nextSame ? 'rounded-2xl rounded-tr-md' : 'rounded-2xl rounded-br-md'
                    : nextSame ? 'rounded-2xl rounded-tl-md' : 'rounded-2xl rounded-bl-md'
                }`}
              >
                {photoKey && <AssetImage blobKey={photoKey} className="w-52 max-w-full object-cover block" />}
                <div className="px-2.5 py-1.5">
                  {m.text && <span>{m.text}</span>}
                  <span className={`float-right ml-2 mt-1.5 text-[10px] leading-none ${mine ? 'text-white/60' : 'text-white/40'}`}>
                    {fmtTime(m.at)}
                    {mine && <span className="ml-0.5 text-[#53bdeb]">✓✓</span>}
                  </span>
                </div>
              </div>
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
        <textarea
          rows={1}
          className="flex-1 resize-none max-h-24 rounded-2xl bg-[#2a3942] px-4 py-2.5 text-sm text-white placeholder-white/40 outline-none scrollbar-thin"
          placeholder={attach ? 'Подпись к фото (можно пусто)' : 'Сообщение'}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
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

// ---- Приложение «Доставка» (ревизия блока 6 §3) ----
function DeliveryScreen({ onBack }: { onBack: () => void }) {
  const s = usePlayerStore();
  const { cfg } = useCfg();
  const [cat, setCat] = useState<string>(cfg.deliveryCategories[0]?.name || '');
  const phone = s.state?.phone;
  const balance = s.state?.statValues[PHONE_BALANCE_STAT] ?? 0;
  const loading = s.deliveryLoadingCat === cat;
  const orders = phone?.activeOrders || [];

  const items = [...cfg.baseCatalog, ...(phone?.deliveryCache || [])].filter((it) => it.category === cat);

  return (
    <div className="absolute inset-0 flex flex-col">
      <div className="flex items-center gap-2 px-3 py-3 bg-black/30 backdrop-blur-md">
        <button className="text-white/90 text-xl leading-none" onClick={onBack}>‹</button>
        <div className="font-semibold text-white">Доставка</div>
        <div className="ml-auto text-sm text-white/70">{money(balance, cfg.currencyName)}</div>
      </div>

      {/* Табы категорий */}
      <div className="flex gap-1.5 overflow-x-auto scrollbar-thin px-3 py-2">
        {cfg.deliveryCategories.map((c) => (
          <button
            key={c.id}
            onClick={() => setCat(c.name)}
            className={`shrink-0 px-3 py-1.5 rounded-full text-xs border transition-colors ${
              cat === c.name
                ? 'bg-amber-500/25 border-amber-400/60 text-amber-100'
                : 'bg-white/5 border-white/10 text-white/70'
            }`}
          >
            {c.name}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-thin px-3 pb-3 text-white">
        {orders.length > 0 && (
          <div className="mb-3 rounded-xl bg-emerald-500/15 border border-emerald-400/30 px-3 py-2 text-xs text-emerald-100">
            В пути: {orders.map((o) => o.name).join(', ')}
          </div>
        )}
        {items.length === 0 ? (
          <div className="text-sm text-white/40 py-4 text-center">
            В этой категории пока пусто. Нажмите «Показать ещё», чтобы ИИ подобрал ассортимент под сеттинг.
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {items.map((it) => {
              const price = Math.max(0, Math.round(it.price));
              const affordable = balance >= price;
              return (
                <div key={it.id} className="rounded-xl bg-white/5 border border-white/10 p-2.5 flex flex-col">
                  <div className="text-sm font-medium truncate">{it.name}</div>
                  {it.description && <div className="text-[11px] text-white/50 line-clamp-2 flex-1">{it.description}</div>}
                  <div className="mt-1.5 flex items-center justify-between gap-1">
                    <span className="text-sm text-amber-300">{money(price, cfg.currencyName)}</span>
                    <button
                      className="text-[11px] px-2 py-1 rounded-lg bg-gradient-to-br from-amber-400 to-orange-600 text-white disabled:opacity-40 disabled:cursor-not-allowed"
                      onClick={() => s.orderDelivery(it)}
                      disabled={!affordable}
                      title={affordable ? 'Заказать' : 'Недостаточно средств'}
                    >
                      {affordable ? 'Заказать' : 'Нет денег'}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <button
          className="mt-3 w-full py-2 rounded-xl bg-white/8 border border-white/15 text-sm text-white/80 hover:bg-white/12 disabled:opacity-50 flex items-center justify-center gap-2"
          onClick={() => s.generateDelivery(cat)}
          disabled={loading || !cat}
        >
          {loading ? (
            <>
              <span className="inline-block w-3.5 h-3.5 border-2 border-white/70 border-t-transparent rounded-full animate-spin" />
              Подбираем…
            </>
          ) : (
            'Показать ещё'
          )}
        </button>
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
  const contacts = (s.state?.phone?.contacts || []).filter((c) => !c.hidden);

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
                  {contacts.length > 0 && (
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
              {contacts.map((c) => {
                const nm = project?.characters.find((x) => x.id === c.characterId)?.name || c.characterId;
                return (
                  <button
                    key={c.characterId}
                    className="w-full flex items-center gap-3 rounded-xl bg-white/5 hover:bg-white/10 px-3 py-2.5 text-left text-white"
                    onClick={() => {
                      void s.sendPhoto(c.characterId, pickFor, caption);
                      setPickFor(null);
                      setCaption('');
                    }}
                  >
                    <div className="w-8 h-8 rounded-full bg-white/10 flex items-center justify-center text-sm">{nm[0]}</div>
                    <span className="text-sm">{nm}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---- Экран «Сообщения»: список контактов + сканирование (Batch 8 §V) ----
function ContactsScreen({
  onBack,
  onOpenChat,
  contactName,
}: {
  onBack: () => void;
  onOpenChat: (id: string) => void;
  contactName: (id: string) => string;
}) {
  const s = usePlayerStore();
  const phone = s.state?.phone;
  const contacts = (phone?.contacts || []).filter((c) => !c.hidden);
  const [scan, setScan] = useState<null | 'busy' | { names: string[]; checked: Record<string, boolean> }>(null);

  const runScan = async () => {
    if (!s.state) return;
    setScan('busy');
    try {
      const known = [
        ...contacts.map((c) => contactName(c.characterId)),
        ...(s.project?.characters || []).map((c) => c.name),
      ];
      const names = await scanContacts(s.state, known);
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
    <div className="absolute inset-0 flex flex-col">
      <div className="flex items-center gap-2 px-3 py-3 bg-black/30 backdrop-blur-md">
        <button className="text-white/90 text-xl leading-none" onClick={onBack}>‹</button>
        <div className="font-semibold text-white">Сообщения</div>
        <button
          className="ml-auto text-xs px-2.5 py-1 rounded-lg bg-white/10 hover:bg-white/15 text-white/90 disabled:opacity-50"
          onClick={runScan}
          disabled={scan === 'busy'}
        >
          {scan === 'busy' ? '⏳' : '🔍 Сканировать'}
        </button>
      </div>
      <div className="flex-1 overflow-y-auto scrollbar-thin p-3 text-white">
        {!contacts.length ? (
          <div className="text-sm text-white/50">Контактов пока нет — они появятся, когда встретишь персонажей, или нажми «Сканировать».</div>
        ) : (
          <div className="space-y-1.5">
            {contacts.map((c) => {
              const msgs = phone?.conversations[c.characterId] || [];
              const last = msgs[msgs.length - 1];
              const unread = phone?.unreadFrom.includes(c.characterId);
              return (
                <button
                  key={c.characterId}
                  className="w-full flex items-center gap-3 rounded-xl bg-white/5 hover:bg-white/10 px-3 py-2.5 text-left"
                  onClick={() => onOpenChat(c.characterId)}
                >
                  <div className="w-9 h-9 rounded-full bg-white/10 flex items-center justify-center text-sm shrink-0">
                    {contactName(c.characterId)[0]}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium flex items-center gap-2">
                      {contactName(c.characterId)}
                      {unread && <span className="w-2 h-2 rounded-full bg-emerald-400" />}
                    </div>
                    <div className="text-xs text-white/60 truncate">{last ? last.text : 'Нет сообщений'}</div>
                  </div>
                  <span className="text-white/30 text-lg">›</span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Чек-лист найденных при сканировании — ничего не добавляем без подтверждения. */}
      {scan && scan !== 'busy' && (
        <div className="absolute inset-0 z-10 bg-black/70 flex items-end" onClick={() => setScan(null)}>
          <div className="w-full rounded-t-2xl bg-[#141019] border-t border-white/10 p-3 max-h-[75%] overflow-y-auto scrollbar-thin" onClick={(e) => e.stopPropagation()}>
            <div className="text-sm font-semibold text-white mb-1">Найденные знакомые</div>
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
              <button className="text-sm px-3 py-1.5 rounded-lg bg-white/10 text-white/80" onClick={() => setScan(null)}>Отмена</button>
              <button className="text-sm px-3 py-1.5 rounded-lg bg-emerald-500 text-white" onClick={confirmScan}>Добавить</button>
            </div>
          </div>
        </div>
      )}
    </div>
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

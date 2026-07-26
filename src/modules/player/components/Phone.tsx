import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { usePlayerStore } from '../playerStore';
import { AssetImage } from '../../../shared/ui';
import { defaultPhoneConfig, PHONE_BALANCE_STAT, type PhoneConfig } from '../../../shared/types';

// Расширение «Телефон» (Batch 7). ФАЗА 1 — каркас: перетаскиваемая иконка + окно
// (рабочий стол с сеткой приложений) + читаемые экраны Банк/Сообщения/Магазин +
// заглушки действий. Мессенджер-ИИ, покупки, камера и связь с контекстом — следующие фазы.
// Иконки нарисованы свои (НЕ копии фирменных Apple).

type App = 'home' | 'messages' | 'bank' | 'shop' | 'camera';

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
    shop: (
      <>
        <path d="M6 7h12l-1 12H7L6 7Z" fill="none" stroke="#fff" strokeWidth="1.6" />
        <path d="M9 7a3 3 0 0 1 6 0" fill="none" stroke="#fff" strokeWidth="1.6" />
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
    shop: 'from-amber-400 to-orange-600',
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
  const drag = useRef<{ moved: boolean } | null>(null);
  const unread = s.state?.phone?.unreadFrom?.length ?? 0;

  if (!cfg.enabled || !cfg.showFloatingIcon) return null;

  function onDown(e: React.PointerEvent) {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { moved: false };
  }
  function onMove(e: React.PointerEvent) {
    if (!drag.current) return;
    drag.current.moved = true;
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
export function PhoneWindow({ open, onClose, onSettings }: { open: boolean; onClose: () => void; onSettings: () => void }) {
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
  const soon = (
    <div className="text-center text-white/60 text-sm py-8">Появится в следующем обновлении телефона.</div>
  );

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
                ['shop', 'Магазин'],
                ['camera', 'Камера'],
              ] as [App, string][]).map(([id, label]) => (
                <button key={id} className="flex flex-col items-center gap-1" onClick={() => { setChatWith(null); setApp(id); }}>
                  <AppIcon kind={id} />
                  <span className="text-[11px] text-white/90">{label}</span>
                </button>
              ))}
              <button className="flex flex-col items-center gap-1" onClick={onSettings}>
                <AppIcon kind="settings" />
                <span className="text-[11px] text-white/90">Настройки</span>
              </button>
            </div>
            <button
              className="absolute bottom-4 left-1/2 -translate-x-1/2 w-32 h-1.5 rounded-full bg-white/60"
              onClick={onClose}
              title="Закрыть"
            />
          </div>
        )}

        {app === 'bank' && (
          <Screen title="Банк">
            <div className="rounded-2xl bg-gradient-to-br from-sky-500/30 to-indigo-600/30 border border-white/10 p-4 mb-4">
              <div className="text-xs text-white/70">Баланс</div>
              <div className="text-3xl font-bold">{money(balance, cfg.currencyName)}</div>
            </div>
            <div className="text-xs uppercase tracking-wide text-white/50 mb-2">История</div>
            {!phone?.transactions.length ? (
              <div className="text-sm text-white/50">Транзакций пока нет.</div>
            ) : (
              <div className="space-y-1.5">
                {[...phone.transactions].reverse().map((t, i) => (
                  <div key={i} className="flex justify-between items-center rounded-lg bg-white/5 px-3 py-2 text-sm">
                    <span className="text-white/80 truncate">{t.reason || '—'}</span>
                    <span className={t.amount >= 0 ? 'text-green-400' : 'text-red-300'}>
                      {t.amount >= 0 ? '+' : ''}
                      {money(t.amount, cfg.currencyName)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Screen>
        )}

        {app === 'messages' && !chatWith && (
          <Screen title="Сообщения">
            {!phone?.contacts.filter((c) => !c.hidden).length ? (
              <div className="text-sm text-white/50">Контактов пока нет — они появятся, когда встретишь персонажей.</div>
            ) : (
              <div className="space-y-1.5">
                {phone.contacts
                  .filter((c) => !c.hidden)
                  .map((c) => {
                    const msgs = phone.conversations[c.characterId] || [];
                    const last = msgs[msgs.length - 1];
                    const unread = phone.unreadFrom.includes(c.characterId);
                    return (
                      <button
                        key={c.characterId}
                        className="w-full flex items-center gap-3 rounded-xl bg-white/5 hover:bg-white/10 px-3 py-2.5 text-left"
                        onClick={() => openChat(c.characterId)}
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
          </Screen>
        )}

        {app === 'messages' && chatWith && (
          <ChatThread
            characterId={chatWith}
            name={contactName(chatWith)}
            onBack={() => setChatWith(null)}
          />
        )}

        {app === 'shop' && (
          <Screen title="Магазин">
            {cfg.shopCategories.map((cat) => {
              const items = [...cfg.baseCatalog, ...(phone?.shopCache || [])].filter((it) => it.category === cat);
              return (
                <div key={cat} className="mb-4">
                  <div className="text-xs uppercase tracking-wide text-white/50 mb-1.5">{cat}</div>
                  {items.length === 0 ? (
                    <div className="text-sm text-white/40">Пусто.</div>
                  ) : (
                    <div className="grid grid-cols-2 gap-2">
                      {items.map((it) => (
                        <div key={it.id} className="rounded-xl bg-white/5 border border-white/10 p-2.5">
                          <div className="text-sm font-medium truncate">{it.name}</div>
                          {it.description && <div className="text-[11px] text-white/50 line-clamp-2">{it.description}</div>}
                          <div className="mt-1 text-sm text-amber-300">{money(it.price, cfg.currencyName)}</div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
            <div>{soon}</div>
          </Screen>
        )}

        {app === 'camera' && (
          <Screen title="Камера">{soon}</Screen>
        )}
      </div>
    </div>,
    document.body
  );
}

// ---- Тред переписки с персонажем (мессенджер + ответы ИИ) ----
function ChatThread({ characterId, name, onBack }: { characterId: string; name: string; onBack: () => void }) {
  const s = usePlayerStore();
  const [draft, setDraft] = useState('');
  const endRef = useRef<HTMLDivElement>(null);
  const msgs = s.state?.phone?.conversations[characterId] || [];
  const typing = s.phoneTypingFrom === characterId;

  // Автопрокрутка вниз при новых сообщениях / индикаторе печати.
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [msgs.length, typing]);

  const send = () => {
    const t = draft.trim();
    if (!t || typing) return;
    setDraft('');
    void s.sendPhoneMessage(characterId, t);
  };

  return (
    <div className="absolute inset-0 flex flex-col">
      <div className="flex items-center gap-2 px-3 py-3 bg-black/40 backdrop-blur-md">
        <button className="text-white/90 text-xl leading-none" onClick={onBack}>‹</button>
        <div className="w-8 h-8 rounded-full bg-white/10 flex items-center justify-center text-sm">{name[0]}</div>
        <div className="font-semibold text-white">{name}</div>
      </div>
      <div className="flex-1 overflow-y-auto scrollbar-thin p-3 space-y-2">
        {!msgs.length && (
          <div className="text-center text-white/40 text-sm py-6">Напишите первым — {name} ответит.</div>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={`flex ${m.from === 'protagonist' ? 'justify-end' : 'justify-start'}`}>
            <div
              className={`max-w-[78%] px-3 py-2 rounded-2xl text-sm whitespace-pre-wrap break-words ${
                m.from === 'protagonist'
                  ? 'bg-gradient-to-br from-emerald-500 to-green-600 text-white rounded-br-md'
                  : 'bg-white/12 text-white rounded-bl-md'
              }`}
            >
              {m.text}
            </div>
          </div>
        ))}
        {typing && (
          <div className="flex justify-start">
            <div className="px-3 py-2.5 rounded-2xl rounded-bl-md bg-white/12">
              <span className="flex gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-white/70 animate-bounce [animation-delay:-0.3s]" />
                <span className="w-1.5 h-1.5 rounded-full bg-white/70 animate-bounce [animation-delay:-0.15s]" />
                <span className="w-1.5 h-1.5 rounded-full bg-white/70 animate-bounce" />
              </span>
            </div>
          </div>
        )}
        <div ref={endRef} />
      </div>
      <div className="flex items-center gap-2 p-2.5 bg-black/40 backdrop-blur-md">
        <input
          className="flex-1 rounded-full bg-white/10 border border-white/15 px-4 py-2 text-sm text-white placeholder-white/40 outline-none focus:border-emerald-400/50"
          placeholder="Сообщение…"
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
          className="w-9 h-9 rounded-full bg-gradient-to-br from-emerald-400 to-green-600 flex items-center justify-center disabled:opacity-40"
          onClick={send}
          disabled={!draft.trim() || typing}
          title="Отправить"
        >
          <svg width="18" height="18" viewBox="0 0 24 24"><path d="M4 12l16-8-6 8 6 8-16-8Z" fill="#fff" /></svg>
        </button>
      </div>
    </div>
  );
}

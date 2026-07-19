import { Modal } from '../../../shared/ui';
import { useLang } from '../../../shared/i18n';
import { usePlayerTheme, themeVars, DEFAULT_THEME } from '../playerTheme';

// Мини-мастерская оформления плеера: акцент, шрифт (ссылкой), размер текста.
// Влияет ТОЛЬКО на экран игры (CSS-переменные корня плеера), не на конструктор.

const ACCENT_PRESETS = ['#b18cff', '#e0578b', '#5cc9ff', '#4ade80', '#f5a623', '#ff6b6b', '#ffffff'];

// Готовые шрифты (Google Fonts) — ссылка + имя семейства. Пустой = системный по умолчанию.
const FONT_PRESETS: { label: string; family: string; url: string }[] = [
  { label: 'По умолчанию', family: '', url: '' },
  {
    label: 'Lora',
    family: 'Lora',
    url: 'https://fonts.googleapis.com/css2?family=Lora:ital,wght@0,400;0,600;1,400&display=swap',
  },
  {
    label: 'Roboto Slab',
    family: 'Roboto Slab',
    url: 'https://fonts.googleapis.com/css2?family=Roboto+Slab:wght@400;600;700&display=swap',
  },
  {
    label: 'Merriweather',
    family: 'Merriweather',
    url: 'https://fonts.googleapis.com/css2?family=Merriweather:ital,wght@0,400;0,700;1,400&display=swap',
  },
  {
    label: 'Comfortaa',
    family: 'Comfortaa',
    url: 'https://fonts.googleapis.com/css2?family=Comfortaa:wght@400;500;700&display=swap',
  },
  {
    label: 'PT Serif',
    family: 'PT Serif',
    url: 'https://fonts.googleapis.com/css2?family=PT+Serif:ital,wght@0,400;0,700;1,400&display=swap',
  },
];

export function WorkshopPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { lang } = useLang();
  const L = (ru: string, en: string) => (lang === 'en' ? en : ru);
  const { theme, set, reset } = usePlayerTheme();

  const activeFont = FONT_PRESETS.find((f) => f.family === theme.fontFamily);

  return (
    <Modal open={open} onClose={onClose} title={L('Мастерская оформления', 'Appearance workshop')}>
      <div style={themeVars(theme)}>
      <p className="text-xs text-gray-400 mb-4">
        {L(
          'Настройки касаются только экрана игры (плеера).',
          'These settings only affect the game screen (player).'
        )}
      </p>

      {/* Акцентный цвет */}
      <label className="label">{L('Акцентный цвет', 'Accent color')}</label>
      <div className="flex items-center gap-2 mb-1 flex-wrap">
        {ACCENT_PRESETS.map((c) => (
          <button
            key={c}
            onClick={() => set({ accent: c })}
            title={c}
            className={`w-7 h-7 rounded-full border-2 transition-transform hover:scale-110 ${
              theme.accent.toLowerCase() === c.toLowerCase()
                ? 'border-white'
                : 'border-white/20'
            }`}
            style={{ background: c }}
          />
        ))}
        <label
          className="w-7 h-7 rounded-full border-2 border-white/20 overflow-hidden relative cursor-pointer"
          title={L('Свой цвет', 'Custom color')}
          style={{ background: theme.accent }}
        >
          <input
            type="color"
            value={theme.accent}
            onChange={(e) => set({ accent: e.target.value })}
            className="absolute inset-0 opacity-0 cursor-pointer"
          />
          <span className="absolute inset-0 flex items-center justify-center text-[10px] text-white/70">
            +
          </span>
        </label>
        <input
          className="input !w-24 !py-1 text-xs"
          value={theme.accent}
          onChange={(e) => set({ accent: e.target.value })}
          spellCheck={false}
        />
      </div>

      {/* Шрифт */}
      <label className="label mt-5">{L('Шрифт', 'Font')}</label>
      <div className="flex flex-wrap gap-1.5 mb-2">
        {FONT_PRESETS.map((f) => (
          <button
            key={f.label}
            onClick={() => set({ fontFamily: f.family, fontUrl: f.url })}
            className={`chip cursor-pointer ${
              (activeFont?.family ?? '') === f.family && theme.fontUrl === f.url
                ? '!bg-[var(--pl-accent-soft)] !border-[var(--pl-accent)]'
                : ''
            }`}
            style={f.family ? { fontFamily: `'${f.family}', sans-serif` } : undefined}
          >
            {f.label}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <div>
          <input
            className="input text-sm"
            placeholder={L('Название семейства, напр. Roboto Slab', 'Family name, e.g. Roboto Slab')}
            value={theme.fontFamily}
            onChange={(e) => set({ fontFamily: e.target.value })}
            spellCheck={false}
          />
        </div>
        <div>
          <input
            className="input text-sm"
            placeholder="https://fonts.googleapis.com/css2?family=…"
            value={theme.fontUrl}
            onChange={(e) => set({ fontUrl: e.target.value })}
            spellCheck={false}
          />
        </div>
      </div>
      <p className="text-[11px] text-gray-500 mt-1">
        {L(
          'Вставьте ссылку на таблицу стилей шрифта (Google Fonts → «@import/link») и укажите имя семейства.',
          'Paste a font stylesheet URL (Google Fonts → "@import/link") and enter the family name.'
        )}
      </p>

      {/* Размер текста */}
      <label className="label mt-5">
        {L('Размер текста', 'Text size')}: {Math.round(theme.fontScale * 100)}%
      </label>
      <input
        type="range"
        min={0.8}
        max={1.6}
        step={0.05}
        value={theme.fontScale}
        onChange={(e) => set({ fontScale: Number(e.target.value) })}
        className="w-full accent-[var(--pl-accent,#b18cff)]"
      />

      {/* Живой предпросмотр реплики (с применёнными переменными темы). */}
      <div className="label mt-5">{L('Предпросмотр', 'Preview')}</div>
      <div style={themeVars(theme)} className="rounded-xl overflow-hidden border border-white/10">
        <div className="p-4 bg-[rgba(10,9,18,0.9)]">
          <div className="inline-block px-4 py-1.5 rounded-t-[10px] font-bold text-[12px] tracking-[0.3px] text-[#1c1526] bg-[var(--pl-accent)] shadow-[0_0_16px_var(--pl-accent-glow)]">
            {L('Ноэль', 'Noel')}
          </div>
          <div className="rounded-[4px_18px_18px_18px] p-4 bg-[rgba(16,13,24,0.72)] border border-[rgba(180,150,255,0.18)]">
            <p
              className="m-0 leading-[1.6] text-[#f0ecfa]"
              style={{ fontSize: 'calc(15px * var(--pl-font-scale, 1))' }}
            >
              {L(
                '— Держи нитки для твоего зайца. И постарайся больше не терять их в отсеке.',
                '— Here are the threads for your rabbit. Try not to lose them in the bay again.'
              )}
            </p>
          </div>
        </div>
      </div>

      <div className="flex justify-between items-center mt-5">
        <button className="btn-ghost text-sm" onClick={reset}>
          {L('Сбросить', 'Reset')}
        </button>
        <button className="btn-primary text-sm" onClick={onClose}>
          {L('Готово', 'Done')}
        </button>
      </div>
      </div>
    </Modal>
  );
}

export { DEFAULT_THEME };

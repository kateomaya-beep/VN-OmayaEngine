import { useState } from 'react';
import { Modal, AssetImage } from '../../../shared/ui';
import { useLang } from '../../../shared/i18n';
import { themeVars } from '../playerTheme';
import {
  DEFAULT_PLAYER_THEME,
  spriteDisplayOf,
  isDefaultSpriteDisplay,
  normalizeNarrativeMode,
  type PlayerTheme,
  type Project,
  type SpriteDisplay,
} from '../../../shared/types';
import { resolveSprite } from '../../../shared/outfits';

// Мини-мастерская оформления плеера: акцент, поверхности (окна/панели, кнопки выбора,
// премиум-выборы) с цветом и плотностью, шрифт (ссылкой), размер текста. Пер-проектная
// (тема хранится в project.playerTheme). Влияет ТОЛЬКО на экран игры (CSS-переменные
// корня плеера), не на конструктор/библиотеку.

const ACCENT_PRESETS = ['#b18cff', '#e0578b', '#5cc9ff', '#4ade80', '#f5a623', '#ff6b6b', '#ffffff'];
const DARK_PRESETS = ['#100d18', '#000000', '#1a1226', '#241a2e', '#0d1a1e', '#201018', '#14161e'];
const PREMIUM_PRESETS = ['#f59e0b', '#e0578b', '#b18cff', '#4ade80', '#5cc9ff', '#ff6b6b'];

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

const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function Swatch({ color, active, onClick }: { color: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title={color}
      className={`w-7 h-7 rounded-full border-2 transition-transform hover:scale-110 ${
        active ? 'border-white' : 'border-white/20'
      }`}
      style={{ background: color }}
    />
  );
}

// Один цвет текста: подпись + пипетка + hex.
function ColorField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (c: string) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-gray-300 flex-1">{label}</span>
      <label
        className="w-7 h-7 rounded-md border border-white/20 overflow-hidden relative cursor-pointer shrink-0"
        style={{ background: value }}
      >
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="absolute inset-0 opacity-0 cursor-pointer"
        />
      </label>
      <input
        className="input !w-24 !py-1 text-xs shrink-0"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
      />
    </div>
  );
}

// Одна поверхность: цвет (пресеты + пипетка + hex) + плотность (прозрачность).
function SurfaceControl({
  label,
  color,
  opacity,
  presets,
  customLabel,
  densityLabel,
  onColor,
  onOpacity,
}: {
  label: string;
  color: string;
  opacity: number;
  presets: string[];
  customLabel: string;
  densityLabel: string;
  onColor: (c: string) => void;
  onOpacity: (o: number) => void;
}) {
  return (
    <div className="mt-5">
      <label className="label">{label}</label>
      <div className="flex items-center gap-2 mb-2 flex-wrap">
        {presets.map((c) => (
          <Swatch key={c} color={c} active={eq(color, c)} onClick={() => onColor(c)} />
        ))}
        <label
          className="w-7 h-7 rounded-full border-2 border-white/20 overflow-hidden relative cursor-pointer"
          title={customLabel}
          style={{ background: color }}
        >
          <input
            type="color"
            value={color}
            onChange={(e) => onColor(e.target.value)}
            className="absolute inset-0 opacity-0 cursor-pointer"
          />
          <span className="absolute inset-0 flex items-center justify-center text-[10px] text-white/70">
            +
          </span>
        </label>
        <input
          className="input !w-24 !py-1 text-xs"
          value={color}
          onChange={(e) => onColor(e.target.value)}
          spellCheck={false}
        />
      </div>
      <div className="flex items-center gap-3">
        <span className="text-xs text-gray-400 w-28 shrink-0">
          {densityLabel}: {Math.round(opacity * 100)}%
        </span>
        <input
          type="range"
          min={0.05}
          max={1}
          step={0.02}
          value={opacity}
          onChange={(e) => onOpacity(Number(e.target.value))}
          className="flex-1 accent-[var(--pl-accent,#b18cff)]"
        />
      </div>
    </div>
  );
}

export function WorkshopPanel({
  open,
  onClose,
  theme,
  onChange,
  project,
  onPatchCharacter,
}: {
  open: boolean;
  onClose: () => void;
  theme: PlayerTheme;
  onChange: (patch: Partial<PlayerTheme>) => void;
  /** Нужен для личной подгонки спрайтов: список персонажей и их картинки. */
  project?: Project | null;
  onPatchCharacter?: (characterId: string, display: SpriteDisplay) => void;
}) {
  const { lang } = useLang();
  const L = (ru: string, en: string) => (lang === 'en' ? en : ru);
  const set = onChange;
  // РП — лента переписки без спрайтов и выборов: там свои поверхности (баблы
  // рассказчика/игрока, фон чата) и «читалочные» настройки текста вместо них.
  const isRp = normalizeNarrativeMode(project?.mode) === 'rp';

  const activeFont = FONT_PRESETS.find((f) => f.family === theme.fontFamily);
  const custom = L('Свой цвет', 'Custom color');
  const density = L('Плотность', 'Density');

  return (
    <Modal open={open} onClose={onClose} title={L('Мастерская оформления', 'Appearance workshop')}>
      <div style={themeVars(theme)}>
        <p className="text-xs text-gray-400 mb-4">
          {L(
            'Оформление сохраняется в проекте — у каждой игры своя тема.',
            'The theme is stored in the project — each game has its own.'
          )}
        </p>

        {/* Акцентный цвет */}
        <label className="label">{L('Акцентный цвет', 'Accent color')}</label>
        <div className="flex items-center gap-2 mb-1 flex-wrap">
          {ACCENT_PRESETS.map((c) => (
            <Swatch key={c} color={c} active={eq(theme.accent, c)} onClick={() => set({ accent: c })} />
          ))}
          <label
            className="w-7 h-7 rounded-full border-2 border-white/20 overflow-hidden relative cursor-pointer"
            title={custom}
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

        {/* Поверхности: в новелле — реплика/ввод/HUD и выборы; в РП выборов нет
            вовсе, зато есть своя лента с фоном и раздельными баблами. */}
        <SurfaceControl
          label={
            isRp
              ? L('Панель ввода и HUD', 'Input bar & HUD')
              : L('Окна и панели (реплика, ввод, HUD)', 'Windows & panels (dialogue, input, HUD)')
          }
          color={theme.bubbleColor}
          opacity={theme.bubbleOpacity}
          presets={DARK_PRESETS}
          customLabel={custom}
          densityLabel={density}
          onColor={(bubbleColor) => set({ bubbleColor })}
          onOpacity={(bubbleOpacity) => set({ bubbleOpacity })}
        />
        {isRp ? (
          <>
            <div className="mt-5">
              <label className="label">{L('Фон ленты чата', 'Chat feed background')}</label>
              <ColorField
                label={L('Цвет фона', 'Background color')}
                value={theme.chatBgColor}
                onChange={(chatBgColor) => set({ chatBgColor })}
              />
            </div>
            <SurfaceControl
              label={L('Бабл рассказчика', 'Narrator bubble')}
              color={theme.narratorBubbleColor}
              opacity={theme.narratorBubbleOpacity}
              presets={DARK_PRESETS}
              customLabel={custom}
              densityLabel={density}
              onColor={(narratorBubbleColor) => set({ narratorBubbleColor })}
              onOpacity={(narratorBubbleOpacity) => set({ narratorBubbleOpacity })}
            />
            <SurfaceControl
              label={L('Бабл игрока', 'Player bubble')}
              color={theme.userBubbleColor}
              opacity={theme.userBubbleOpacity}
              presets={ACCENT_PRESETS}
              customLabel={custom}
              densityLabel={density}
              onColor={(userBubbleColor) => set({ userBubbleColor })}
              onOpacity={(userBubbleOpacity) => set({ userBubbleOpacity })}
            />
          </>
        ) : (
          <>
            <SurfaceControl
              label={L('Кнопки выбора', 'Choice buttons')}
              color={theme.choiceColor}
              opacity={theme.choiceOpacity}
              presets={DARK_PRESETS}
              customLabel={custom}
              densityLabel={density}
              onColor={(choiceColor) => set({ choiceColor })}
              onOpacity={(choiceOpacity) => set({ choiceOpacity })}
            />
            <SurfaceControl
              label={L('Премиум-выборы (за очки)', 'Premium choices (cost points)')}
              color={theme.premiumColor}
              opacity={theme.premiumOpacity}
              presets={PREMIUM_PRESETS}
              customLabel={custom}
              densityLabel={density}
              onColor={(premiumColor) => set({ premiumColor })}
              onOpacity={(premiumOpacity) => set({ premiumOpacity })}
            />
          </>
        )}

        {/* Цвета текста */}
        <label className="label mt-5">{L('Цвета текста', 'Text colors')}</label>
        <div className="space-y-2">
          <ColorField
            label={L('Основной текст', 'Body text')}
            value={theme.textColor}
            onChange={(textColor) => set({ textColor })}
          />
          <ColorField
            label={L('Имя говорящего', 'Speaker name')}
            value={theme.nameColor}
            onChange={(nameColor) => set({ nameColor })}
          />
          <ColorField
            label={L('Прямая речь (кавычки)', 'Direct speech (quotes)')}
            value={theme.quoteColor}
            onChange={(quoteColor) => set({ quoteColor })}
          />
          <ColorField
            label={L('Курсив (действия/мысли)', 'Italic (actions/thoughts)')}
            value={theme.italicColor}
            onChange={(italicColor) => set({ italicColor })}
          />
          <ColorField
            label={L('Календарь', 'Calendar')}
            value={theme.calendarColor}
            onChange={(calendarColor) => set({ calendarColor })}
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
          <input
            className="input text-sm"
            placeholder={L('Название семейства, напр. Roboto Slab', 'Family name, e.g. Roboto Slab')}
            value={theme.fontFamily}
            onChange={(e) => set({ fontFamily: e.target.value })}
            spellCheck={false}
          />
          <input
            className="input text-sm"
            placeholder="https://fonts.googleapis.com/css2?family=…"
            value={theme.fontUrl}
            onChange={(e) => set({ fontUrl: e.target.value })}
            spellCheck={false}
          />
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

        {/* Размер имени */}
        <label className="label mt-4">
          {L('Размер имени', 'Name size')}: {Math.round(theme.nameScale * 100)}%
        </label>
        <input
          type="range"
          min={0.8}
          max={1.6}
          step={0.05}
          value={theme.nameScale}
          onChange={(e) => set({ nameScale: Number(e.target.value) })}
          className="w-full accent-[var(--pl-accent,#b18cff)]"
        />

        {isRp && (
          <>
            {/* Разное */}
            <label className="label mt-5">{L('Разное', 'Misc')}</label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={theme.showMessageNumbers}
                onChange={(e) => set({ showMessageNumbers: e.target.checked })}
              />
              {L('Счётчик сообщений', 'Message counter')}
            </label>
            <p className="text-[11px] text-gray-500 mt-1 mb-1">
              {L(
                'Номер сообщения рядом с именем в ленте переписки — как в Таверне.',
                'A message number next to the name in the chat feed — like in Tavern.'
              )}
            </p>

            {/* Настройки чтения: интервалы — как в хорошей читалке */}
            <label className="label mt-5">{L('Настройки чтения', 'Reading settings')}</label>
            <div className="space-y-3">
              <div>
                <div className="text-xs text-gray-400 mb-1">
                  {L('Межстрочный интервал', 'Line height')}: {theme.lineHeight.toFixed(2)}
                </div>
                <input
                  type="range"
                  min={1.2}
                  max={2.4}
                  step={0.05}
                  value={theme.lineHeight}
                  onChange={(e) => set({ lineHeight: Number(e.target.value) })}
                  className="w-full accent-[var(--pl-accent,#b18cff)]"
                />
              </div>
              <div>
                <div className="text-xs text-gray-400 mb-1">
                  {L('Расстояние между сообщениями', 'Spacing between messages')}:{' '}
                  {theme.messageSpacing.toFixed(2)}
                </div>
                <input
                  type="range"
                  min={0.4}
                  max={3}
                  step={0.1}
                  value={theme.messageSpacing}
                  onChange={(e) => set({ messageSpacing: Number(e.target.value) })}
                  className="w-full accent-[var(--pl-accent,#b18cff)]"
                />
              </div>
              <div>
                <div className="text-xs text-gray-400 mb-1">
                  {L('Отступ между абзацами', 'Spacing between paragraphs')}:{' '}
                  {theme.paragraphSpacing.toFixed(2)}
                </div>
                <input
                  type="range"
                  min={0}
                  max={3}
                  step={0.1}
                  value={theme.paragraphSpacing}
                  onChange={(e) => set({ paragraphSpacing: Number(e.target.value) })}
                  className="w-full accent-[var(--pl-accent,#b18cff)]"
                />
              </div>
            </div>
          </>
        )}

        {!isRp && (
          <>
            {/* Спрайты персонажей: размер + положение */}
            <label className="label mt-5">{L('Спрайты персонажей', 'Character sprites')}</label>
            <div className="space-y-2">
              <div>
                <div className="text-xs text-gray-400 mb-1">
                  {L('Размер', 'Size')}: {Math.round(theme.spriteScale * 100)}%
                </div>
                <input
                  type="range"
                  min={0.5}
                  max={1.6}
                  step={0.02}
                  value={theme.spriteScale}
                  onChange={(e) => set({ spriteScale: Number(e.target.value) })}
                  className="w-full accent-[var(--pl-accent,#b18cff)]"
                />
              </div>
              <div>
                <div className="text-xs text-gray-400 mb-1">
                  {L('По горизонтали', 'Horizontal')}: {theme.spriteOffsetX > 0 ? '+' : ''}
                  {theme.spriteOffsetX}%
                </div>
                <input
                  type="range"
                  min={-50}
                  max={50}
                  step={1}
                  value={theme.spriteOffsetX}
                  onChange={(e) => set({ spriteOffsetX: Number(e.target.value) })}
                  className="w-full accent-[var(--pl-accent,#b18cff)]"
                />
              </div>
              <div>
                <div className="text-xs text-gray-400 mb-1">
                  {L('По вертикали (выше +)', 'Vertical (up +)')}: {theme.spriteOffsetY > 0 ? '+' : ''}
                  {theme.spriteOffsetY}%
                </div>
                <input
                  type="range"
                  min={-50}
                  max={50}
                  step={1}
                  value={theme.spriteOffsetY}
                  onChange={(e) => set({ spriteOffsetY: Number(e.target.value) })}
                  className="w-full accent-[var(--pl-accent,#b18cff)]"
                />
              </div>
            </div>

            {project && onPatchCharacter && (
              <PerCharacterSprites project={project} onPatch={onPatchCharacter} L={L} />
            )}
          </>
        )}

        {/* Живой предпросмотр */}
        <div className="label mt-5">{L('Предпросмотр', 'Preview')}</div>
        {isRp ? (
          <RpPreview theme={theme} L={L} />
        ) : (
        <div className="rounded-xl overflow-hidden border border-white/10">
          <div className="p-4 bg-gradient-to-b from-[#241d33] to-[#0a0912]">
            <div
              className="inline-block px-4 py-1.5 rounded-t-[10px] font-bold tracking-[0.3px] text-[var(--pl-name)] bg-[var(--pl-accent)] shadow-[0_0_16px_var(--pl-accent-glow)]"
              style={{ fontSize: 'calc(12px * var(--pl-name-scale, 1))' }}
            >
              {L('Ноэль', 'Noel')}
            </div>
            <div className="rounded-[4px_18px_18px_18px] p-4 border border-[rgba(180,150,255,0.18)] bg-[var(--pl-bubble-bg)] backdrop-blur-lg">
              <p
                className="m-0 leading-[1.6] text-[var(--pl-text)] md-content"
                style={{ fontSize: 'calc(15px * var(--pl-font-scale, 1))' }}
              >
                {L('Держи нитки для зайца. ', 'Here are the threads. ')}
                <span className="md-quote">
                  {L('«Не потеряй их снова»', '"Don’t lose them again"')}
                </span>
                {L('. ', '. ')}
                <em>{L('Он украдкой улыбается.', 'He smiles faintly.')}</em>
              </p>
            </div>
            <div className="mt-2 flex flex-col gap-1.5">
              <div className="px-4 py-2 rounded-[12px] border border-[rgba(180,150,255,0.22)] bg-[var(--pl-choice-bg)] text-[#f0ecfa] text-sm">
                {L('Поблагодарить его', 'Thank him')}
              </div>
              <div className="px-4 py-2 rounded-[12px] border border-amber-400/40 bg-[var(--pl-premium-bg)] text-[#f0ecfa] text-sm flex justify-between">
                <span>{L('Обнять Ноэля', 'Hug Noel')}</span>
                <span className="text-amber-300">10 ♥</span>
              </div>
            </div>
          </div>
        </div>
        )}

        <div className="flex justify-between items-center mt-5">
          <button className="btn-ghost text-sm" onClick={() => set({ ...DEFAULT_PLAYER_THEME })}>
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

// Предпросмотр ленты РП: бабл рассказчика + бабл игрока с текущими цветом/
// прозрачностью/интервалами — те самые переменные, что и в самой игре (см.
// themeVars), поэтому подкрутка ползунка сразу видна здесь без захода в игру.
function RpPreview({
  theme,
  L,
}: {
  theme: PlayerTheme;
  L: (ru: string, en: string) => string;
}) {
  return (
    <div
      className="rounded-xl overflow-hidden border border-white/10 p-4"
      style={{ background: theme.chatBgColor || '#000000' }}
    >
      <div className="flex flex-col" style={{ gap: `${theme.messageSpacing}rem` }}>
        <div
          className="relative rounded-2xl px-4 pt-8 pb-3 border border-[rgba(180,150,255,0.14)]"
          style={{ background: 'var(--pl-narrator-bg)' }}
        >
          <div className="absolute top-2 inset-x-0 flex items-center justify-center gap-1.5">
            <span
              className="text-xs font-semibold tracking-wide opacity-70"
              style={{ color: 'var(--pl-text)', fontSize: 'calc(0.75rem * var(--pl-name-scale, 1))' }}
            >
              {L('Название проекта', 'Project title')}
            </span>
          </div>
          <p
            className="m-0 text-[var(--pl-text)] md-content"
            style={{
              fontSize: 'calc(15px * var(--pl-font-scale, 1))',
              lineHeight: theme.lineHeight,
            }}
          >
            {L('Держи нитки для зайца. ', 'Here are the threads. ')}
            <span className="md-quote">{L('«Не потеряй их снова»', '"Don’t lose them again"')}</span>
            {L('. ', '. ')}
            <em>{L('Он украдкой улыбается.', 'He smiles faintly.')}</em>
          </p>
        </div>
        <div
          className="relative rounded-2xl px-4 pt-8 pb-3 border border-[rgba(180,150,255,0.28)]"
          style={{ background: 'var(--pl-user-bg)' }}
        >
          <div className="absolute top-2 inset-x-0 flex items-center justify-center gap-1.5">
            <span
              className="text-xs font-semibold tracking-wide"
              style={{ color: 'var(--pl-accent-bright)', fontSize: 'calc(0.75rem * var(--pl-name-scale, 1))' }}
            >
              {L('Игрок', 'Player')}
            </span>
          </div>
          <p
            className="m-0 text-[var(--pl-text)] md-content"
            style={{
              fontSize: 'calc(15px * var(--pl-font-scale, 1))',
              lineHeight: theme.lineHeight,
            }}
          >
            {L('«Спасибо, не потеряю».', '"Thanks, I won’t lose them."')}
          </p>
        </div>
      </div>
    </div>
  );
}

// ЛИЧНАЯ подгонка спрайтов. Общие ползунки выше двигают всех разом, но рисовки
// приходят в разном масштабе и с разным полем вокруг фигуры: подогнал одного —
// разъехались остальные. Здесь только те, у кого спрайт есть: настраивать
// нечего у персонажа без картинок.
function PerCharacterSprites({
  project,
  onPatch,
  L,
}: {
  project: Project;
  onPatch: (characterId: string, display: SpriteDisplay) => void;
  L: (ru: string, en: string) => string;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const withSprites = project.characters
    .map((c) => ({ c, assetId: resolveSprite(c, undefined, 'neutral') }))
    .filter((x) => !!x.assetId);
  if (!withSprites.length) return null;

  return (
    <div className="mt-5">
      <label className="label">{L('Отдельные персонажи', 'Individual characters')}</label>
      <p className="text-[11px] text-gray-500 mb-2">
        {L(
          'Подгонка поверх общей: итог = общая настройка × личная. «Как у всех» — значит личная не задана.',
          'Applied on top of the shared settings: result = shared × individual. "Same as everyone" means unset.'
        )}
      </p>
      <div className="space-y-1.5">
        {withSprites.map(({ c, assetId }) => {
          const d = spriteDisplayOf(c);
          const isDefault = isDefaultSpriteDisplay(d);
          const openHere = openId === c.id;
          const blobKey = project.assets.find((a) => a.id === assetId)?.blobKey;
          const set = (patch: Partial<SpriteDisplay>) => onPatch(c.id, { ...d, ...patch });
          return (
            <div key={c.id} className="rounded-lg border border-white/10 bg-panel2 overflow-hidden">
              <button
                className="w-full flex items-center gap-2.5 px-2.5 py-2 text-left hover:bg-white/5"
                onClick={() => setOpenId(openHere ? null : c.id)}
              >
                <span className="w-8 h-8 rounded-md overflow-hidden bg-black/30 shrink-0 flex items-center justify-center">
                  {blobKey ? <AssetImage blobKey={blobKey} className="w-full h-full object-cover" /> : '🙂'}
                </span>
                <span className="flex-1 truncate text-sm">{c.name}</span>
                <span className="text-[11px] text-gray-500">
                  {isDefault
                    ? L('как у всех', 'same as everyone')
                    : `${Math.round(d.scale * 100)}%${d.offsetX ? `, x${d.offsetX > 0 ? '+' : ''}${d.offsetX}` : ''}${
                        d.offsetY ? `, y${d.offsetY > 0 ? '+' : ''}${d.offsetY}` : ''
                      }`}
                </span>
                <span className="text-xs text-gray-500">{openHere ? '▾' : '▸'}</span>
              </button>
              {openHere && (
                <div className="px-2.5 pb-2.5 space-y-2">
                  <Slider
                    label={`${L('Размер', 'Size')}: ${Math.round(d.scale * 100)}%`}
                    min={0.3} max={2} step={0.02} value={d.scale}
                    onChange={(v) => set({ scale: v })}
                  />
                  <Slider
                    label={`${L('По горизонтали', 'Horizontal')}: ${d.offsetX > 0 ? '+' : ''}${d.offsetX}%`}
                    min={-50} max={50} step={1} value={d.offsetX}
                    onChange={(v) => set({ offsetX: v })}
                  />
                  <Slider
                    label={`${L('По вертикали (выше +)', 'Vertical (up +)')}: ${d.offsetY > 0 ? '+' : ''}${d.offsetY}%`}
                    min={-50} max={50} step={1} value={d.offsetY}
                    onChange={(v) => set({ offsetY: v })}
                  />
                  <button
                    className="btn-ghost !px-3 !py-1 text-xs"
                    disabled={isDefault}
                    onClick={() => onPatch(c.id, { scale: 1, offsetX: 0, offsetY: 0 })}
                  >
                    {L('Сбросить к общим', 'Reset to shared')}
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Slider({
  label,
  min,
  max,
  step,
  value,
  onChange,
}: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <div className="text-xs text-gray-400 mb-1">{label}</div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-[var(--pl-accent,#b18cff)]"
      />
    </div>
  );
}

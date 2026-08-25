import { useAppMode } from './appMode';
import { useLang } from '../shared/i18n';
import type { NarrativeMode } from '../shared/types';

// РАЗВИЛКА НА ВХОДЕ. Показывается один раз — пока режим не выбран; дальше он
// помнится и меняется значком в верхней панели.
//
// Это не «настройка по вкусу», а выбор из двух разных приложений: у них разные
// проекты, разные конструкторы, разные пресеты и разный экран игры. Поэтому здесь
// написано не «что включить», а что за работа предстоит в каждом.

interface Card {
  id: NarrativeMode;
  icon: string;
  name: string;
  tagline: string;
  bullets: string[];
}

export function ModePicker() {
  const setMode = useAppMode((s) => s.setMode);
  const lang = useLang((s) => s.lang);
  const L = (ru: string, en: string) => (lang === 'en' ? en : ru);

  const cards: Card[] = [
    {
      id: 'vn',
      icon: '🎭',
      name: L('Визуальная новелла', 'Visual novel'),
      tagline: L('Сцена, спрайты, выборы', 'Stage, sprites, choices'),
      bullets: [
        L('Персонажи на фоне, эмоции и наряды', 'Characters on a background, emotions and outfits'),
        L('Музыка по настроению сцены, CG-моменты', 'Music by scene mood, CG moments'),
        L('Каждый ход заканчивается выбором', 'Every turn ends with a choice'),
        L('Телефон, инвентарь, деньги, время', 'Phone, inventory, money, time'),
        L('Нужны ассеты: фоны и спрайты', 'Needs assets: backgrounds and sprites'),
      ],
    },
    {
      id: 'rp',
      icon: '💬',
      name: L('Классический РП', 'Classic RP'),
      tagline: L('Лента переписки, только текст', 'A chat feed, text only'),
      bullets: [
        L('Модель пишет прозу, вы отвечаете своими словами', 'The model writes prose, you answer in your own words'),
        L('За героя не пишут — это правило движка', 'Nobody writes for your hero — the engine enforces it'),
        L('Стриминг, свайпы, правка любого сообщения', 'Streaming, swipes, edit any message'),
        L('Инфобокс состояния мира под каждым ответом', 'A world-state infobox under every reply'),
        L('Ассеты не нужны — только текст и аватарки', 'No assets needed — text and avatars only'),
      ],
    },
  ];

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#0a0912] p-4">
      <div className="w-full max-w-3xl">
        <div className="text-center mb-7">
          <h1 className="font-brand font-extrabold text-2xl text-[#f5f2fc] mb-1.5">
            {L('С чем работаем?', 'What are we making?')}
          </h1>
          <p className="text-sm text-[#8a84a3]">
            {L(
              'Два режима — по сути два приложения на одном движке. Выбор запомнится; сменить его можно в любой момент значком в верхней панели.',
              'Two modes — effectively two apps on one engine. The choice is remembered; switch it any time from the top bar.'
            )}
          </p>
        </div>

        <div className="grid sm:grid-cols-2 gap-4">
          {cards.map((c) => (
            <button
              key={c.id}
              className="text-left rounded-[20px] p-5 bg-white/[0.04] border border-[rgba(180,150,255,0.16)] hover:bg-[rgba(160,110,255,0.12)] hover:border-[rgba(190,150,255,0.5)] hover:shadow-[0_0_28px_rgba(170,120,255,0.18)] transition-colors"
              onClick={() => setMode(c.id)}
            >
              <div className="text-3xl mb-2">{c.icon}</div>
              <div className="font-brand font-bold text-lg text-[#f0ecfa]">{c.name}</div>
              <div className="text-xs text-[#b18cff] mb-3">{c.tagline}</div>
              <ul className="space-y-1.5">
                {c.bullets.map((b, i) => (
                  <li key={i} className="text-[13px] text-[#a8a2c0] leading-snug flex gap-2">
                    <span className="text-[#6d6688]">•</span>
                    <span>{b}</span>
                  </li>
                ))}
              </ul>
            </button>
          ))}
        </div>

        <p className="text-center text-[11px] text-[#6d6688] mt-5">
          {L(
            'Проекты у режимов раздельные. Готовый сеттинг можно перенести в другой режим кнопкой «Адаптировать» — она делает копию, оригинал остаётся как был.',
            'Projects are separate per mode. An existing setting can be moved with "Adapt" — it makes a copy and leaves the original untouched.'
          )}
        </p>
      </div>
    </div>
  );
}

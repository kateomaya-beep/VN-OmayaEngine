import { useState } from 'react';
import type { ImageGenConfig, NaiImageConfig, Project, RuntimeState } from '../../../shared/types';
import { defaultNaiConfig } from '../../../shared/types';
import { effectiveImageModel } from '../../../ai/imageProvider';
import { naiMaxCharacters, naiModel, naiQualitySuffix, naiSupportsRefs, naiUcPresetText } from '../../../ai/novelai';
import { generateAppearanceTags, naiWorkerDefault, naiWorkerPrompt } from '../../../ai/novelaiPrompt';
import { resolvePerson } from '../../../ai/characterRegistry';
import { pushToast } from '../../../shared/toast';

type L = (ru: string, en: string) => string;

// НАСТРОЙКИ NOVELAI В СТУДИИ. Свои, а не общие «стиль» и «чего быть не должно»:
// там фразы для моделей-художников, здесь теги Danbooru, пресеты модели и рефы V4.5.
export function NovelAiSettings({
  ig,
  patchNai,
  L,
}: {
  ig: ImageGenConfig;
  patchNai: (p: Partial<NaiImageConfig>) => void;
  L: L;
}) {
  const nai = ig.nai ?? defaultNaiConfig();
  const model = naiModel(effectiveImageModel(ig));
  const refsOk = naiSupportsRefs(model);
  const custom = !!nai.workerPrompt?.trim();
  return (
    <div className="nf-nai-settings space-y-3 rounded-xl border border-fuchsia-400/20 bg-fuchsia-500/[0.04] p-3">
      <div className="text-sm font-semibold">NovelAI · {model.label}</div>
      <p className="text-[11px] text-gray-400">
        {L(
          `Воркер пишет теги Danbooru: сцену отдельно, каждого персонажа отдельно (до ${naiMaxCharacters(model) || 0}), взаимодействия — тегами source#/target#/mutual#. Сцена описывается как есть, включая NSFW, если он в сюжете${model.curated ? ' — но Curated-модель NSFW не рисует, для него выберите Full' : ''}.`,
          `The worker writes Danbooru tags: the scene and each character separately, interactions via source#/target#/mutual#. The scene is described as it is, NSFW included if the story has it.`
        )}
      </p>

      <div>
        <label className="label">{L('Теги стиля', 'Style tags')}</label>
        <p className="text-[11px] text-gray-500 mb-1">
          {L(
            'Вписываются в промпт сцены как есть: художники (artist:имя), год (year 2014), сложность (high complexity — V5), техника, палитра. Веса: {тег} сильнее, [тег] слабее, 1.5::тег:: — числом.',
            'Inserted into the scene prompt as is: artists (artist:name), year, complexity (V5), medium, palette. Weights: {tag}, [tag], 1.5::tag::.'
          )}
        </p>
        <textarea
          className="input h-16 text-sm font-mono nf-nai-style"
          placeholder="например: artist:имя, year 2023, high complexity, cinematic lighting"
          value={nai.styleTags}
          onChange={(e) => patchNai({ styleTags: e.target.value })}
        />
      </div>

      <div className="grid sm:grid-cols-2 gap-3">
        <div>
          <label className="label">{L('Пресет «нежелательного»', 'Undesired content preset')}</label>
          <select
            className="input nf-nai-uc"
            value={nai.ucPreset}
            onChange={(e) => patchNai({ ucPreset: e.target.value as NaiImageConfig['ucPreset'] })}
          >
            <option value="heavy">Heavy</option>
            <option value="light">Light</option>
            <option value="human">Human Focus</option>
            <option value="none">{L('Без пресета', 'None')}</option>
          </select>
          <p className="text-[10px] text-gray-500 mt-1 line-clamp-3" title={naiUcPresetText(model, nai.ucPreset)}>
            {naiUcPresetText(model, nai.ucPreset) || '—'}
          </p>
        </div>
        <div className="space-y-1.5 text-sm">
          <label className="flex items-start gap-2">
            <input type="checkbox" checked={nai.quality} onChange={(e) => patchNai({ quality: e.target.checked })} />
            <span>
              {L('Теги качества', 'Quality tags')}
              <span className="block text-[10px] text-gray-500">{naiQualitySuffix(model)}</span>
            </span>
          </label>
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              className="nf-nai-free"
              checked={nai.freeOnly}
              onChange={(e) => patchNai({ freeOnly: e.target.checked })}
            />
            <span>
              {L('Не тратить Anlas', 'Do not spend Anlas')}
              <span className="block text-[10px] text-gray-500">
                {L(
                  'До 1 Мп, до 28 шагов, по одной картинке — бесплатно на Opus.' +
                    (model.family === 'v5' ? ' У V5 у бесплатных генераций есть лимит — проверьте его кнопкой «Подписка и Anlas».' : ''),
                  'Up to 1 MP, 28 steps, one image — free on Opus.'
                )}
              </span>
            </span>
          </label>
        </div>
      </div>

      <div>
        <label className="label">{L('Свои теги «нежелательного»', 'Own undesired tags')}</label>
        <textarea
          className="input h-14 text-sm font-mono"
          placeholder="например: bad hands, extra fingers, -1::text::"
          value={nai.negativeTags}
          onChange={(e) => patchNai({ negativeTags: e.target.value })}
        />
      </div>

      <div className="rounded-lg border border-white/10 p-2.5">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="nf-nai-refs"
            checked={nai.refs}
            disabled={!refsOk}
            onChange={(e) => patchNai({ refs: e.target.checked })}
          />
          {L('Реф персонажа (Precise Reference)', 'Character reference (Precise Reference)')}
        </label>
        <p className="text-[11px] text-gray-500 mt-1">
          {refsOk
            ? L(
                '+5 Anlas за картинку даже на Opus. Берётся картинка «Внешность» первого персонажа в кадре, у кого она есть: несколько рефов модель сливает в одного. Лучший реф — в полный рост, нейтральная поза, простой фон.',
                '+5 Anlas per image even on Opus. Uses the Appearance image of the first person in frame who has one.'
              )
            : L(
                `У ${model.label} рефов нет (только V4.5). Дизайн держат теги внешности ниже, в «Референсах».`,
                `${model.label} has no references (V4.5 only). Appearance tags keep the design.`
              )}
        </p>
        {refsOk && nai.refs && (
          <div className="grid sm:grid-cols-3 gap-2 mt-2 text-xs">
            <label className="block">
              {L('Что брать', 'Take')}
              <select
                className="input !py-1 mt-1"
                value={nai.refType}
                onChange={(e) => patchNai({ refType: e.target.value as NaiImageConfig['refType'] })}
              >
                <option value="character">{L('Персонажа', 'Character')}</option>
                <option value="character&style">{L('Персонажа и стиль', 'Character & style')}</option>
              </select>
            </label>
            <label className="block">
              {L(`Сила: ${nai.refStrength.toFixed(2)}`, `Strength: ${nai.refStrength.toFixed(2)}`)}
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                className="w-full"
                value={nai.refStrength}
                onChange={(e) => patchNai({ refStrength: Number(e.target.value) })}
              />
            </label>
            <label className="block">
              {L(`Точность: ${nai.refFidelity.toFixed(2)}`, `Fidelity: ${nai.refFidelity.toFixed(2)}`)}
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                className="w-full"
                value={nai.refFidelity}
                onChange={(e) => patchNai({ refFidelity: Number(e.target.value) })}
              />
            </label>
            <p className="sm:col-span-3 text-[10px] text-gray-500">
              {L(
                'Высокая сила копирует с рефа и позу с ракурсом — для живых композиций держите её около 0.6–0.8.',
                'High strength copies pose and angle from the reference too — keep it around 0.6–0.8 for dynamic compositions.'
              )}
            </p>
          </div>
        )}
      </div>

      <div>
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <label className="label !mb-0">{L('Промпт воркера', 'Worker prompt')}</label>
          <div className="flex gap-1.5">
            {(['illustration', 'manhwa'] as const).map((p) => (
              <button
                key={p}
                className={`chip !px-2.5 !py-1 text-xs nf-nai-preset-${p} ${nai.workerPreset === p && !custom ? 'bg-accent2 text-white' : ''}`}
                onClick={() => patchNai({ workerPreset: p, workerPrompt: undefined })}
                title={L('Взять текст этого варианта (своя правка сбросится)', 'Use this preset (your edit is reset)')}
              >
                {p === 'illustration' ? L('Иллюстрация', 'Illustration') : L('Страница манхвы', 'Manhwa page')}
              </button>
            ))}
          </div>
        </div>
        <p className="text-[11px] text-gray-500 my-1">
          {custom
            ? L('Свой текст — правка поверх варианта. Кнопка варианта вернёт его исходный текст.', 'Your own text. A preset button restores its original text.')
            : nai.workerPreset === 'manhwa'
              ? L(
                  'Страница манхвы: несколько панелей в одной картинке, реплики в облачках через «Text:». Лучше всего работает на V5.',
                  'Manhwa page: several panels in one image, dialogue via "Text:". Works best on V5.'
                )
              : L(
                  'Иллюстрация к моменту: сцена как есть, главное — персонажи и их взаимодействие, затем композиция и окружение.',
                  'An illustration of the moment: the scene as it is, characters and their interaction first.'
                )}
        </p>
        <textarea
          className="input h-40 font-mono text-[11px] nf-nai-worker"
          value={naiWorkerPrompt(nai)}
          onChange={(e) =>
            patchNai({ workerPrompt: e.target.value.trim() === naiWorkerDefault(nai.workerPreset).trim() ? undefined : e.target.value })
          }
        />
      </div>
    </div>
  );
}

/** Поле «Теги внешности» у человека в «Референсах» + генерация из анкеты. */
export function NaiAppearanceTags({
  project,
  state,
  personId,
  nai,
  patchNai,
  L,
}: {
  project: Project;
  state: RuntimeState;
  personId: string;
  nai: NaiImageConfig;
  patchNai: (p: Partial<NaiImageConfig>) => void;
  L: L;
}) {
  const [busy, setBusy] = useState(false);
  const value = nai.appearanceTags[personId] || '';
  const set = (v: string) => {
    const next = { ...nai.appearanceTags };
    if (v.trim()) next[personId] = v;
    else delete next[personId];
    patchNai({ appearanceTags: next });
  };
  async function fromCard() {
    const person = resolvePerson(project, state, { id: personId });
    if (!person) return;
    setBusy(true);
    try {
      const tags = await generateAppearanceTags(project, state, person);
      if (tags) set(tags);
      else pushToast('error', L('Модель не вернула теги — попробуйте ещё раз.', 'The model returned no tags.'));
    } catch (e) {
      pushToast('error', (e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="mt-2 nf-nai-tags">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-gray-400">{L('Теги внешности (NovelAI)', 'Appearance tags (NovelAI)')}</span>
        <button className="btn-ghost !px-2 !py-0.5 text-[11px]" disabled={busy} onClick={() => void fromCard()}>
          {busy ? '…' : L('✨ из анкеты', '✨ from the sheet')}
        </button>
      </div>
      <textarea
        className="input h-16 text-[11px] font-mono mt-1"
        placeholder={L(
          'Пусто — нажмите «✨ из анкеты» или впишите сами: girl, long hair, black hair, red eyes, … (теги через запятую)',
          'Empty — press «✨ from the sheet» or type tags: girl, long hair, …'
        )}
        value={value}
        onChange={(e) => set(e.target.value)}
      />
    </div>
  );
}

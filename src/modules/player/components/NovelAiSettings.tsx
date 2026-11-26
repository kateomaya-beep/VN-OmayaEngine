import { useState } from 'react';
import type { ImageGenConfig, NaiImageConfig, Project, RuntimeState } from '../../../shared/types';
import { defaultNaiConfig } from '../../../shared/types';
import { effectiveImageModel } from '../../../ai/imageProvider';
import { naiDefaults, naiMaxCharacters, naiModel, naiQualitySuffix, naiSupportsRefs, naiUcPresetText, type NaiModel } from '../../../ai/novelai';
import { NAI_NOISE_SCHEDULES, NAI_SAMPLERS } from '../../../shared/types';
import { generateAppearanceTags } from '../../../ai/novelaiPrompt';
import { resolvePerson } from '../../../ai/characterRegistry';
import { pushToast } from '../../../shared/toast';
import { StylePresetBar } from './StylePresetBar';
import { NaiTagsAssist } from './NaiTagsAssist';

type L = (ru: string, en: string) => string;

// НАСТРОЙКИ NOVELAI В СТУДИИ. Свои, а не общие «стиль» и «чего быть не должно»:
// там фразы для моделей-художников, здесь теги Danbooru, пресеты модели и рефы V4.5.
export function NovelAiSettings({
  project,
  ig,
  patchNai,
  L,
}: {
  project: Project;
  ig: ImageGenConfig;
  patchNai: (p: Partial<NaiImageConfig>) => void;
  L: L;
}) {
  const nai = ig.nai ?? defaultNaiConfig();
  const model = naiModel(effectiveImageModel(ig));
  const refsOk = naiSupportsRefs(model);
  return (
    <div className="nf-nai-settings space-y-3 rounded-xl border border-fuchsia-400/20 bg-fuchsia-500/[0.04] p-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="text-sm font-semibold">NovelAI · {model.label}</div>
        <StylePresetBar
          kind="nai"
          L={L}
          current={() => ({
            kind: 'nai',
            nai: { styleTags: nai.styleTags, negativeTags: nai.negativeTags, ucPreset: nai.ucPreset, quality: nai.quality },
          })}
          onApply={(p) => p.nai && patchNai({ ...p.nai })}
        />
      </div>
      <p className="text-[11px] text-gray-400">
        {L(
          `Режим картинки пишет теги Danbooru: сцену отдельно, каждого персонажа отдельно (до ${naiMaxCharacters(model) || 0}), взаимодействия — тегами source#/target#/mutual#. Сцена описывается как есть, включая NSFW, если он в сюжете${model.curated ? ' — но Curated-модель NSFW не рисует, для него выберите Full' : ''}.`,
          `The worker writes Danbooru tags: the scene and each character separately, interactions via source#/target#/mutual#. The scene is described as it is, NSFW included if the story has it.`
        )}
      </p>

      <div>
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <label className="label !mb-0">{L('Теги стиля', 'Style tags')}</label>
          <NaiTagsAssist project={project} field="style" value={nai.styleTags} onApply={(t) => patchNai({ styleTags: t })} L={L} />
        </div>
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
          <div className="mt-2 nf-nai-nsfw">
            <div className="text-[11px] text-gray-400 mb-1">NSFW</div>
            <div className="flex gap-1.5 flex-wrap">
              {(['story', 'never'] as const).map((m) => (
                <button
                  key={m}
                  className={`chip !px-2.5 !py-1 text-xs nf-nai-nsfw-${m} ${(nai.nsfw ?? 'story') === m ? 'bg-accent2 text-white' : ''}`}
                  onClick={() => patchNai({ nsfw: m === 'story' ? undefined : 'never' })}
                >
                  {m === 'story' ? L('Как в сюжете', 'As in the story') : L('Не рисовать', 'Never')}
                </button>
              ))}
            </div>
            <p className="text-[10px] text-gray-500 mt-1">
              {model.curated
                ? L('Curated-модель NSFW не рисует вовсе — для откровенных сцен выберите Full.', 'Curated models never draw NSFW.')
                : (nai.nsfw ?? 'story') === 'story'
                  ? L(
                      'Как сайт NovelAI: «nsfw» стоит в «нежелательном», пока сцена обычная (модель не «сексуализирует»). Откровенная сцена (nude, nipples, sex…) — «nsfw» уходит в промпт и убирается из «нежелательного»: без этого NovelAI рисует «прилично», например грудь без сосков.',
                      'Like the NovelAI site: nsfw is undesired unless the scene is explicit.'
                    )
                  : L('«nsfw» всегда в «нежелательном» и вычеркнут из промпта.', 'nsfw is always undesired.')}
            </p>
          </div>
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

      <NaiGenParams nai={nai} model={model} patchNai={patchNai} L={L} />

      <div>
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <label className="label !mb-0">{L('Свои теги «нежелательного»', 'Own undesired tags')}</label>
          <NaiTagsAssist project={project} field="negative" value={nai.negativeTags} onApply={(t) => patchNai({ negativeTags: t })} L={L} />
        </div>
        <textarea
          className="input h-14 text-sm font-mono nf-nai-negative"
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

      <p className="text-[11px] text-gray-500">
        {L('Промпт картинки пишет активный режим — «🧩 Режим картинки» (блоки из Таверны).', 'The image prompt is written by the active image mode.')}
      </p>
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

const SAMPLER_LABEL: Record<string, string> = {
  k_euler_ancestral: 'Euler Ancestral (как на сайте)',
  k_euler: 'Euler',
  k_dpmpp_2m: 'DPM++ 2M',
  k_dpmpp_2s_ancestral: 'DPM++ 2S Ancestral',
  k_dpmpp_sde: 'DPM++ SDE',
  k_dpm_fast: 'DPM Fast',
  ddim: 'DDIM',
};

/** Шаги, guidance, сэмплер и прочее — как на сайте NovelAI; пусто — значение модели. */
function NaiGenParams({
  nai,
  model,
  patchNai,
  L,
}: {
  nai: NaiImageConfig;
  model: NaiModel;
  patchNai: (p: Partial<NaiImageConfig>) => void;
  L: L;
}) {
  const d = naiDefaults(model);
  const maxSteps = nai.freeOnly ? 28 : 50;
  const steps = Math.min(maxSteps, nai.steps ?? d.steps);
  const scale = nai.scale ?? d.scale;
  const custom =
    nai.steps !== undefined || nai.scale !== undefined || nai.cfgRescale !== undefined || nai.sampler !== undefined ||
    nai.noiseSchedule !== undefined || nai.varietyBoost !== undefined || nai.seed !== undefined || nai.charMode !== undefined;
  const v5 = model.family === 'v5';
  return (
    <details className="nf-nai-params rounded-lg border border-white/10 p-2.5">
      <summary className="cursor-pointer select-none text-sm">
        ⚙ {L('Параметры генерации', 'Generation parameters')}{' '}
        <span className="text-[11px] text-gray-400">
          · {L('шагов', 'steps')} {steps} · guidance {scale}
          {custom ? L(' · свои', ' · custom') : L(' · как на сайте', ' · site defaults')}
        </span>
      </summary>
      <div className="mt-2 space-y-2.5 text-xs">
        <label className="block">
          {L(`Шаги: ${steps}`, `Steps: ${steps}`)}
          <span className="text-gray-500"> · {L(`у ${model.label} по умолчанию ${d.steps}`, `default ${d.steps}`)}</span>
          <input
            type="range"
            min={1}
            max={maxSteps}
            step={1}
            className="w-full nf-nai-steps"
            value={steps}
            onChange={(e) => patchNai({ steps: Number(e.target.value) })}
          />
          <span className="text-[10px] text-gray-500">
            {nai.freeOnly
              ? L('С «Не тратить Anlas» — до 28 (бесплатный предел Opus). Больше — снимите галочку: каждая картинка будет стоить Anlas.', 'Up to 28 while «Do not spend Anlas» is on.')
              : L('Больше 28 шагов стоит Anlas даже на Opus. Обычно 28 хватает: сверх этого картинка почти не меняется.', 'Over 28 steps costs Anlas even on Opus.')}
          </span>
        </label>
        <div className="grid sm:grid-cols-2 gap-2.5">
          <label className="block">
            {L(`Guidance (следование промпту): ${scale}`, `Guidance: ${scale}`)}
            <input type="range" min={1} max={10} step={0.1} className="w-full nf-nai-scale" value={scale} onChange={(e) => patchNai({ scale: Number(e.target.value) })} />
            <span className="text-[10px] text-gray-500">{L(`По умолчанию ${d.scale}. Выше — чётче и ближе к промпту, но может «пережарить» цвета.`, `Default ${d.scale}.`)}</span>
          </label>
          <label className="block">
            {L(`Rescale: ${nai.cfgRescale ?? 0}`, `Rescale: ${nai.cfgRescale ?? 0}`)}
            <input type="range" min={0} max={1} step={0.02} className="w-full" value={nai.cfgRescale ?? 0} onChange={(e) => patchNai({ cfgRescale: Number(e.target.value) })} />
            <span className="text-[10px] text-gray-500">{L('Против пересвеченных цветов при высоком guidance. По умолчанию 0.', 'Fixes oversaturation at high guidance.')}</span>
          </label>
          <label className="block">
            {L('Сэмплер', 'Sampler')}
            <select className="input !py-1 mt-1 nf-nai-sampler" value={nai.sampler ?? d.sampler} onChange={(e) => patchNai({ sampler: e.target.value as NaiImageConfig['sampler'] })}>
              {NAI_SAMPLERS.map((s) => (
                <option key={s} value={s}>
                  {SAMPLER_LABEL[s] ?? s}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            {L('Расписание шума', 'Noise schedule')}
            <select
              className="input !py-1 mt-1"
              value={nai.noiseSchedule ?? d.noiseSchedule}
              onChange={(e) => patchNai({ noiseSchedule: e.target.value as NaiImageConfig['noiseSchedule'] })}
            >
              {NAI_NOISE_SCHEDULES.filter((n) => n !== 'native' || model.family === 'v3').map((n) => (
                <option key={n} value={n}>
                  {n === 'karras' ? 'karras (как на сайте)' : n}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="flex items-start gap-2">
          <input type="checkbox" disabled={v5} checked={!v5 && !!nai.varietyBoost} onChange={(e) => patchNai({ varietyBoost: e.target.checked })} className="mt-0.5 nf-nai-variety" />
          <span>
            Variety+
            <span className="block text-[10px] text-gray-500">
              {v5
                ? L('У V5 этого параметра нет.', 'Not available on V5.')
                : L('Разнообразнее композиции и позы (на сайте — та же галочка). По умолчанию выключено.', 'More varied compositions. Off by default.')}
            </span>
          </span>
        </label>
        <label className="block">
          {L('Сид', 'Seed')}
          <input
            type="number"
            min={0}
            className="input !py-1 mt-1 nf-nai-seed"
            placeholder={L('пусто — случайный (его видно в «🔍 Что ушло в NovelAI»)', 'empty — random')}
            value={nai.seed ?? ''}
            onChange={(e) => patchNai({ seed: e.target.value === '' ? undefined : Math.max(0, Math.floor(Number(e.target.value) || 0)) })}
          />
        </label>
        <div>
          <div className="mb-1">{L('Персонажи', 'Characters')}</div>
          <div className="flex gap-1.5 flex-wrap">
            {(['separate', 'merged'] as const).map((m) => (
              <button
                key={m}
                className={`chip !px-2.5 !py-1 text-xs nf-nai-charmode-${m} ${(nai.charMode ?? 'separate') === m ? 'bg-accent2 text-white' : ''}`}
                onClick={() => patchNai({ charMode: m === 'separate' ? undefined : 'merged' })}
              >
                {m === 'separate' ? L('Отдельными промптами (как сайт)', 'Separate prompts (like the site)') : L('Одним промптом (как SillyTavern)', 'One prompt (like SillyTavern)')}
              </button>
            ))}
          </div>
          <p className="text-[10px] text-gray-500 mt-1">
            {L(
              'Сайт NovelAI даёт каждому персонажу своё поле — черты не смешиваются. SillyTavern шлёт всё одной строкой. Если у вас в Таверне выходило лучше — попробуйте второй вариант.',
              'The NovelAI site gives each character its own field; SillyTavern sends everything as one prompt.'
            )}
          </p>
        </div>
        {custom && (
          <button
            className="btn-ghost !px-2.5 !py-1 text-xs nf-nai-params-reset"
            onClick={() =>
              patchNai({ steps: undefined, scale: undefined, cfgRescale: undefined, sampler: undefined, noiseSchedule: undefined, varietyBoost: undefined, seed: undefined, charMode: undefined })
            }
          >
            ↺ {L('Как на сайте NovelAI', 'Site defaults')}
          </button>
        )}
      </div>
    </details>
  );
}

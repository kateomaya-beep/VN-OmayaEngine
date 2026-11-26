import type { NaiSentRequest } from '../../../ai/imageProvider';
import { copyToClipboard } from '../../../shared/utils';
import { pushToast } from '../../../shared/toast';

type L = (ru: string, en: string) => string;

/** Текст для сайта NovelAI: вставить по полям и повторить картинку один в один. */
export function naiSentText(r: NaiSentRequest): string {
  return [
    `Prompt:\n${r.base}`,
    ...r.characters.map((c, i) => `Character ${i + 1}:\n${c}`),
    `Undesired Content:\n${r.negative}`,
    `Model: ${r.model} · ${r.width}×${r.height} · Steps ${r.steps} · Guidance ${r.scale} · Rescale ${r.cfgRescale} · ` +
      `Sampler ${r.sampler} · Noise ${r.noiseSchedule} · Variety+ ${r.varietyBoost ? 'on' : 'off'} · Seed ${r.seed}` +
      `\n(Add Quality Tags — OFF, Undesired Content Preset — None: качество и пресет уже вписаны в текст выше)`,
  ].join('\n\n');
}

// «Что ушло в NovelAI»: точный промпт, персонажи, «нежелательное» и параметры.
// Для сравнения с сайтом: тот же текст и сид на сайте — та же картинка; если там
// лучше — дело в параметрах, если так же — в промпте.
export function NaiSentDetails({ r, L }: { r: NaiSentRequest; L: L }) {
  return (
    <details className="nf-nai-sent mt-1.5 rounded-lg border border-white/10 bg-black/20 p-2 text-[11px]">
      <summary className="cursor-pointer select-none text-gray-300">🔍 {L('Что ушло в NovelAI', 'What was sent to NovelAI')}</summary>
      <div className="mt-1.5 space-y-1.5 text-gray-300">
        <div className="text-gray-400">
          {r.model} · {r.width}×{r.height} · {L('шагов', 'steps')} {r.steps} · guidance {r.scale} · rescale {r.cfgRescale} · {r.sampler} · {r.noiseSchedule} ·
          Variety+ {r.varietyBoost ? L('вкл', 'on') : L('выкл', 'off')} · seed {r.seed}
          {r.ref ? L(' · реф персонажа', ' · character ref') : ''}
        </div>
        <div>
          <span className="text-gray-500">{L('Промпт: ', 'Prompt: ')}</span>
          <span className="font-mono break-words nf-nai-sent-base">{r.base}</span>
        </div>
        {r.characters.map((c, i) => (
          <div key={i}>
            <span className="text-gray-500">{L(`Персонаж ${i + 1}: `, `Character ${i + 1}: `)}</span>
            <span className="font-mono break-words">{c}</span>
          </div>
        ))}
        <div>
          <span className="text-gray-500">{L('Нежелательное: ', 'Undesired: ')}</span>
          <span className="font-mono break-words">{r.negative || '—'}</span>
        </div>
        <button
          className="btn-ghost !px-2 !py-0.5 text-[11px] nf-nai-sent-copy"
          onClick={() => {
            copyToClipboard(naiSentText(r));
            pushToast('success', L('Скопировано — вставьте по полям на сайте NovelAI', 'Copied'));
          }}
        >
          ⧉ {L('Скопировать для сайта NovelAI', 'Copy for the NovelAI site')}
        </button>
        <p className="text-[10px] text-gray-500">
          {L(
            'На сайте: тот же текст в те же поля, Add Quality Tags — выключить, Undesired Content Preset — None (качество и пресет уже вписаны в текст), те же шаги, guidance и сид. Выйдет лучше, чем здесь, — разница в параметрах; так же — в промпте.',
            'On the site: same text in the same fields, quality tags off, UC preset None, same steps/guidance/seed.'
          )}
        </p>
      </div>
    </details>
  );
}

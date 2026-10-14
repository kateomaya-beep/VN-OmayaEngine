import { parsePresetJson, type PromptPreset } from './promptPreset';
import { normalizeRegexRules, type RegexRule } from './regexRules';
import { ensureEngineBlocks } from './engineBlocks';

// АЛЬТЕРНАТИВНЫЕ ПРЕСЕТЫ (РП и новелла). Наш пресет остаётся стандартным; рядом можно держать
// чужие — импортированные из SillyTavern (например, Dr. D) — и переключаться между
// ними в панели. Такой пресет живёт целиком: свои блоки в своём порядке, свои
// регулярки (виджеты, чистка старых сообщений) и своя выборка (температура, top_p).
// Выбран — работает он; вернулись на стандартный — всё как было, ничего не
// перезаписано.

export interface AltPresetSampling {
  temperature?: number;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  /** Потолок ответа. У таких пресетов своё размышление и виджеты — нашего расчёта по длине хода мало. */
  maxTokens?: number;
}

export interface AltRpPreset {
  id: string;
  name: string;
  /** Откуда взят: встроенная копия Dr. D или импорт файла. */
  source: 'drd' | 'sillytavern';
  /** Режим, под который собран: в новелле в нём JSON-контракт и блоки спрайтов. */
  mode: 'rp' | 'vn';
  preset: PromptPreset;
  regexRules: RegexRule[];
  sampling: AltPresetSampling;
  /** Префилл ответа из пресета (assistant_prefill). */
  prefill?: string;
  importedAt: number;
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

export function normalizeAltPresets(raw: unknown): AltRpPreset[] {
  if (!Array.isArray(raw)) return [];
  const out: AltRpPreset[] = [];
  for (const r of raw as any[]) {
    if (!r || typeof r.id !== 'string') continue;
    const preset = parsePresetJson(r.preset);
    if (!preset) continue;
    const s = r.sampling && typeof r.sampling === 'object' ? r.sampling : {};
    const mode = r.mode === 'vn' ? 'vn' : 'rp';
    out.push({
      id: r.id,
      name: typeof r.name === 'string' && r.name.trim() ? r.name : preset.name,
      source: r.source === 'drd' ? 'drd' : 'sillytavern',
      mode,
      // Блоки движка — при каждой загрузке: новые доезжают, нетронутые обновляются.
      preset: ensureEngineBlocks({ ...preset, foreign: 'sillytavern' }, mode),
      regexRules: normalizeRegexRules(r.regexRules),
      sampling: {
        temperature: num(s.temperature),
        topP: num(s.topP),
        frequencyPenalty: num(s.frequencyPenalty),
        presencePenalty: num(s.presencePenalty),
        maxTokens: num(s.maxTokens),
      },
      ...(typeof r.prefill === 'string' && r.prefill.trim() ? { prefill: r.prefill } : {}),
      importedAt: num(r.importedAt) ?? 0,
    });
  }
  return out;
}

import type { NarrativeMode } from '../shared/types';
import { DEFAULT_TURN_LENGTH } from '../shared/types';
import { activeAltPreset, settingsForMode, type PresetSettings } from './presetSettings';
import { modelAlwaysThinks } from './providers';

// ПОТОЛОК ОТВЕТА (max_tokens). В него входит не только проза: родное размышление
// модели (у Gemini 3, GLM, Kimi его не выключить совсем), наш план размышления в
// <thinking> и служебная сводка — всё это тратит тот же лимит. Раньше он считался
// по одной прозе (900 слов → ~3 600), и на думающих моделях на текст оставалось
// мало: ответ обрывался на полуслове. Теперь к прозе прибавляем запас на то, что
// реально включено. Свой потолок из пресета («Потолок ответа») важнее авто;
// у альтернативного пресета (Dr. D) — его собственный.
export function turnMaxTokens(
  base: PresetSettings,
  mode: NarrativeMode
): { value: number; auto: number; source: 'alt' | 'manual' | 'auto'; altName?: string } {
  const ps = settingsForMode(base, mode);
  const tl = ps.turnLength || DEFAULT_TURN_LENGTH;
  // Слово русской прозы — около трёх токенов у популярных токенайзеров; к прозе —
  // служебная сводка/JSON-обвязка хода.
  const perWord = ps.narrativeLanguage === 'en' ? 1.8 : 3;
  const sentEffort = ps.guidedThinking ? 'none' : ps.reasoningEffort;
  const nativeThinks = sentEffort !== 'none' || modelAlwaysThinks();
  const auto = Math.min(
    16000,
    Math.max(2000, Math.round(tl.max * perWord) + 900 + (ps.guidedThinking ? 1500 : 0) + (nativeThinks ? 3000 : 0))
  );
  const alt = activeAltPreset(base, mode);
  if (alt?.sampling.maxTokens) return { value: alt.sampling.maxTokens, auto, source: 'alt', altName: alt.name };
  if (base.maxOutputTokens) return { value: base.maxOutputTokens, auto, source: 'manual' };
  return { value: auto, auto, source: 'auto' };
}

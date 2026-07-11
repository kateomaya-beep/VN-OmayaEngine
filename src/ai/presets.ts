import type { AiConfig, PromptLength, PromptPacing, PromptTone, ProseStyleId } from '../shared/types';
import { DEFAULT_STYLE_PRESET } from '../shared/factory';

// Пресет = набор состояний тумблеров + кастомные тексты слоёв (кроме Ядра),
// импортируемый/экспортируемый JSON (см. CR v2 §F2). Omaya-пресет — дефолт из коробки.
export interface PromptPreset {
  id: string;
  name: string;
  toggles: {
    narrativeLanguage: 'ru' | 'en';
    stylePreset: string;
    length: PromptLength;
    pacing: PromptPacing;
    tone: PromptTone;
    proseStyle: ProseStyleId;
  };
  customLayers?: { style?: string; jailbreak?: string; prefill?: string };
  jailbreakEnabled: boolean;
}

export const OMAYA_DEFAULT_PRESET: PromptPreset = {
  id: 'omaya_default',
  name: 'OmayaEngine (по умолчанию)',
  toggles: {
    narrativeLanguage: 'ru',
    stylePreset: DEFAULT_STYLE_PRESET,
    length: 'medium',
    pacing: 'adaptive',
    tone: 'neutral',
    proseStyle: 'clean',
  },
  jailbreakEnabled: false,
};

// Извлекает пресет из текущего aiConfig проекта (для экспорта).
export function exportPreset(cfg: AiConfig, name: string): PromptPreset {
  return {
    id: `preset_${Date.now().toString(36)}`,
    name,
    toggles: {
      narrativeLanguage: cfg.narrativeLanguage,
      stylePreset: cfg.stylePreset,
      length: cfg.length,
      pacing: cfg.pacing,
      tone: cfg.tone,
      proseStyle: cfg.proseStyle,
    },
    customLayers: {
      style: cfg.customStyle,
      jailbreak: cfg.jailbreakPrompt,
      prefill: cfg.prefill,
    },
    jailbreakEnabled: cfg.jailbreakEnabled,
  };
}

// Применяет пресет поверх aiConfig, никогда не трогая Слой 1 (ядро — не в пресете).
export function applyPreset(cfg: AiConfig, preset: PromptPreset): AiConfig {
  return {
    ...cfg,
    narrativeLanguage: preset.toggles.narrativeLanguage,
    stylePreset: preset.toggles.stylePreset,
    length: preset.toggles.length,
    pacing: preset.toggles.pacing,
    tone: preset.toggles.tone,
    proseStyle: preset.toggles.proseStyle,
    customStyle: preset.customLayers?.style,
    jailbreakPrompt: preset.customLayers?.jailbreak,
    prefill: preset.customLayers?.prefill,
    jailbreakEnabled: preset.jailbreakEnabled,
  };
}

const LENGTHS = new Set<PromptLength>(['short', 'medium', 'long']);
const PACINGS = new Set<PromptPacing>(['slow_burn', 'fast', 'adaptive']);
const TONES = new Set<PromptTone>(['neutral', 'anti_negative', 'anti_saccharine']);
const PROSE_STYLES = new Set<ProseStyleId>(['clean', 'anne_rice', 'king', 'gaiman', 'dostoevsky', 'gogol']);

// Разбирает импортированный JSON, мягко откатываясь на дефолты при мусоре/невалидном файле.
export function parsePresetJson(raw: unknown): PromptPreset | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as any;
  const t = r.toggles || {};
  return {
    id: typeof r.id === 'string' ? r.id : `preset_${Date.now().toString(36)}`,
    name: typeof r.name === 'string' ? r.name : 'Импортированный пресет',
    toggles: {
      narrativeLanguage: t.narrativeLanguage === 'en' ? 'en' : 'ru',
      stylePreset: typeof t.stylePreset === 'string' ? t.stylePreset : DEFAULT_STYLE_PRESET,
      length: LENGTHS.has(t.length) ? t.length : 'medium',
      pacing: PACINGS.has(t.pacing) ? t.pacing : 'adaptive',
      tone: TONES.has(t.tone) ? t.tone : 'neutral',
      proseStyle: PROSE_STYLES.has(t.proseStyle) ? t.proseStyle : 'clean',
    },
    customLayers: {
      style: typeof r.customLayers?.style === 'string' ? r.customLayers.style : undefined,
      jailbreak: typeof r.customLayers?.jailbreak === 'string' ? r.customLayers.jailbreak : undefined,
      prefill: typeof r.customLayers?.prefill === 'string' ? r.customLayers.prefill : undefined,
    },
    jailbreakEnabled: typeof r.jailbreakEnabled === 'boolean' ? r.jailbreakEnabled : false,
  };
}

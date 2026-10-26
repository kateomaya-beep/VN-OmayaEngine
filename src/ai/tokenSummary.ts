import type { Character, LorebookEntry, NarrativeMode, Project, RuntimeState } from '../shared/types';
import { presetForMode, type PresetSettings } from './presetSettings';

// ИЗ ЧЕГО СОСТОИТ БАЗА ИСТОРИИ — тексты по разделам, в том виде, в каком они
// уходят в запрос (с подписями полей). Числа считает tokenCount: здесь только
// тексты, чтобы и счётчики у полей, и сводка на странице истории считали одно и
// то же.

/** Анкета персонажа целиком — как в запросе, когда он в фокусе (+ образцы реплик). */
export function characterSheetTexts(c: Character): string[] {
  return [
    `### ${c.name}`,
    `Who they are: ${c.card.personality}`,
    c.card.appearance.trim() ? `Appearance: ${c.card.appearance}` : '',
    c.card.backstory.trim() ? `Backstory: ${c.card.backstory}` : '',
    `Speech: ${c.card.speechStyle}`,
    c.card.relationshipArc ? `Arc: ${c.card.relationshipArc}` : '',
    c.card.speechExamples?.trim() ? `--- ${c.name} ---\n${c.card.speechExamples}` : '',
  ].filter(Boolean);
}

export function lorebookEntryText(e: LorebookEntry): string {
  return `[${e.title}] ${e.content}`;
}

export interface SummaryRow {
  key: string;
  label: string;
  texts: string[];
  /** Пояснение мелким шрифтом: когда это уходит в запрос. */
  note?: string;
  children?: SummaryRow[];
}

export function storyBaseRows(
  project: Project,
  ps: PresetSettings,
  mode: NarrativeMode,
  state?: RuntimeState | null
): SummaryRow[] {
  const rows: SummaryRow[] = [];

  rows.push({
    key: 'characters',
    label: 'Персонажи',
    texts: project.characters.flatMap(characterSheetTexts),
    note: 'Анкета целиком уходит, когда персонаж в фокусе сцены; остальные — одной строкой.',
    children: project.characters.map((c) => ({ key: `char:${c.id}`, label: c.name || '(без имени)', texts: characterSheetTexts(c) })),
  });

  const l = project.lore;
  rows.push({
    key: 'world',
    label: 'Мир и правила',
    texts: [l.worldDescription, l.narrativeRules, l.plotOutline],
    children: [
      { key: 'world:desc', label: 'Описание мира', texts: [l.worldDescription] },
      { key: 'world:rules', label: 'Правила повествования', texts: [l.narrativeRules] },
      { key: 'world:plot', label: 'Сюжетная арка', texts: [l.plotOutline] },
    ],
  });
  if (l.openingScene.trim()) {
    rows.push({ key: 'opening', label: 'Вступительная сцена', texts: [l.openingScene] });
  }

  const always = project.lorebook.filter((e) => e.alwaysActive);
  const keyed = project.lorebook.filter((e) => !e.alwaysActive);
  rows.push({
    key: 'lorebook',
    label: `Лорбук (${project.lorebook.length} зап.)`,
    texts: project.lorebook.map(lorebookEntryText),
    note: 'Постоянные записи — в каждом запросе; записи по ключам — только когда ключ прозвучал.',
    children: [
      { key: 'lb:always', label: `Постоянные (${always.length})`, texts: always.map(lorebookEntryText) },
      { key: 'lb:keyed', label: `По ключам (${keyed.length})`, texts: keyed.map(lorebookEntryText) },
    ],
  });

  const preset = presetForMode(ps, mode);
  const blocks = preset.blocks.filter((b) => b.enabled && !b.dynamic);
  rows.push({
    key: 'preset',
    label: `Пресет «${preset.name}»`,
    texts: blocks.map((b) => b.content),
    note: 'Включённые блоки с текстом. Блоки, которые наполняет движок (мир, персонажи, память), посчитаны в своих разделах.',
  });

  if (state) {
    const m = state.memory;
    const chapters = m.memorybook || [];
    rows.push({
      key: 'memory',
      label: 'Память прохождения',
      texts: [m.storyState || '', m.liveSummary || '', ...chapters.map((c) => `${c.title}\n${c.text}`), ...(m.facts || []).map((f) => f.text)],
      note: 'Снапшот и заметка — целиком; главы меморибука — сколько влезет в бюджет памяти.',
      children: [
        { key: 'mem:snap', label: 'Снапшот состояния', texts: [m.storyState || ''] },
        { key: 'mem:note', label: 'Заметка об арке', texts: [m.liveSummary || ''] },
        { key: 'mem:book', label: `Меморибук (${chapters.length} гл.)`, texts: chapters.map((c) => `${c.title}\n${c.text}`) },
        { key: 'mem:facts', label: `Факты (${(m.facts || []).length})`, texts: (m.facts || []).map((f) => f.text) },
      ],
    });
  }

  return rows;
}

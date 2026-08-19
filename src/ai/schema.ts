import { z } from 'zod';

// Zod schema for the AI turn response. Permissive on ids/emotions/moods;
// the parser resolves/repairs against the manifest (политика fallback).

export const beatSchema = z.union([
  z.object({ type: z.literal('narration'), text: z.string(), bg: z.string().nullish(), mood: z.string().nullish() }),
  z.object({ type: z.literal('thought'), text: z.string(), bg: z.string().nullish(), mood: z.string().nullish() }),
  z.object({
    type: z.literal('dialogue'),
    // characterId для персонажей из списка; name для эпизодических NPC от ИИ.
    characterId: z.string().nullish(),
    name: z.string().nullish(),
    emotion: z.string().default('neutral'),
    outfit: z.string().nullish(), // наряд говорящего (открытый тег); движок валидирует
    position: z.enum(['left', 'center', 'right']).default('center'),
    text: z.string(),
    bg: z.string().nullish(),
    mood: z.string().nullish(),
  }),
  // Управляющие биты (Batch 6 §1): смена визуала в потоке. backgroundId/bg — синонимы.
  z.object({
    type: z.literal('scene_change'),
    backgroundId: z.string().nullish(),
    bg: z.string().nullish(),
    musicMood: z.string().nullish(),
  }),
  z.object({
    type: z.literal('outfit_change'),
    characterId: z.string(),
    outfit: z.string(),
  }),
  // Телефон (Batch 7 §7.2 + ревизия блока 6).
  z.object({
    type: z.literal('transaction'),
    amount: z.number(),
    vendor: z.string().nullish(),
    item: z.string().nullish(),
    time: z.string().nullish(),
  }),
  z.object({ type: z.literal('money_change'), amount: z.number(), reason: z.string().nullish() }),
  z.object({ type: z.literal('sms_incoming'), characterId: z.string(), text: z.string() }),
  z.object({ type: z.literal('sms_outgoing'), characterId: z.string(), text: z.string() }),
  z.object({
    type: z.literal('sms_photo'),
    characterId: z.string(),
    caption: z.string().nullish(),
    photo: z.string(),
  }),
  z.object({ type: z.literal('contact_added'), characterId: z.string() }),
  // Симулятор жизни (Batch 8): время + инвентарь.
  z.object({ type: z.literal('time_advance'), newDate: z.string().nullish(), newTime: z.string().nullish() }),
  z.object({ type: z.literal('location_change'), location: z.string() }),
  z.object({
    type: z.literal('inventory_add'),
    name: z.string(),
    emoji: z.string().nullish(),
    quantity: z.number().nullish(),
    category: z.string().nullish(),
    source: z.string().nullish(),
  }),
  z.object({
    type: z.literal('inventory_remove'),
    name: z.string(),
    quantity: z.number().nullish(),
    reason: z.string().nullish(),
  }),
  // Реестр персонажей (patch character-registry).
  z.object({
    type: z.literal('character_new'),
    id: z.string().nullish(),
    canonicalName: z.string(),
    aliases: z.array(z.string()).nullish(),
    role: z.string().nullish(),
  }),
  z.object({ type: z.literal('character_alias_add'), id: z.string(), alias: z.string() }),
  z.object({
    type: z.literal('character_update'),
    id: z.string(),
    status: z.string().nullish(),
    canonicalName: z.string().nullish(),
    sheetPatch: z.record(z.string()).nullish(),
  }),
]);

export const sceneSchema = z.object({
  backgroundId: z.string().nullable().default(null),
  musicMood: z.string().nullable().default(null),
  sfxId: z.string().nullable().default(null),
  cutsceneCgId: z.string().nullable().default(null),
});

export const statChangeSchema = z.object({
  statId: z.string(),
  delta: z.number(),
  reason: z.string().default(''),
});

export const choiceSchema = z.object({
  id: z.string(),
  text: z.string(),
  cost: z
    .object({ statId: z.string(), amount: z.number() })
    .nullable()
    .default(null),
});

// Game Master delta (все поля опциональны; движок мержит в RuntimeState.gm).
export const worldStateSchema = z
  .object({
    clock: z
      .object({
        day: z.string().nullish(),
        month: z.string().nullish(),
        year: z.string().nullish(),
        time: z.string().nullish(),
        location: z.string().nullish(),
      })
      .partial()
      .nullish(),
    characters: z
      .array(
        z.object({
          name: z.string(),
          charId: z.string().nullish(),
          dossier: z.string().nullish(),
          appearance: z.string().nullish(),
          personality: z.string().nullish(),
          roleToHero: z.string().nullish(),
          outfit: z.string().nullish(),
          mood: z.string().nullish(),
          status: z.string().nullish(),
          location: z.string().nullish(),
          tags: z.array(z.string()).nullish(),
        })
      )
      .nullish(),
    relations: z
      .array(z.object({ from: z.string(), to: z.string(), label: z.string().default('') }))
      .nullish(),
    locations: z
      .array(
        z.object({
          name: z.string(),
          description: z.string().nullish(),
          tags: z.array(z.string()).nullish(),
        })
      )
      .nullish(),
    event: z.string().nullish(),
    // Важность события: key/important никогда не вытесняются из промпта.
    eventLevel: z.enum(['general', 'important', 'key']).nullish(),
    eventChars: z.array(z.string()).nullish(),
    mood: z.string().nullish(),
    agendaAdd: z.array(z.string()).nullish(),
    agendaDone: z.array(z.string()).nullish(),
  })
  .nullish();

export const aiTurnSchema = z.object({
  scene: sceneSchema.default({
    backgroundId: null,
    musicMood: null,
    sfxId: null,
    cutsceneCgId: null,
  }),
  beats: z.array(beatSchema).default([]),
  statChanges: z.array(statChangeSchema).default([]),
  choices: z.array(choiceSchema).default([]),
  chapterEvent: z.enum(['chapter_end', 'cg_moment']).nullable().default(null),
  worldState: worldStateSchema,
});

export type ParsedAiTurn = z.infer<typeof aiTurnSchema>;

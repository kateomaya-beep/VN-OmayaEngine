import { z } from 'zod';

// Zod schema for the AI turn response. Permissive on ids/emotions/moods;
// the parser resolves/repairs against the manifest (политика fallback).

export const beatSchema = z.union([
  z.object({ type: z.literal('narration'), text: z.string(), bg: z.string().nullish() }),
  z.object({ type: z.literal('thought'), text: z.string(), bg: z.string().nullish() }),
  z.object({
    type: z.literal('dialogue'),
    // characterId для персонажей из списка; name для эпизодических NPC от ИИ.
    characterId: z.string().nullish(),
    name: z.string().nullish(),
    emotion: z.string().default('neutral'),
    position: z.enum(['left', 'center', 'right']).default('center'),
    text: z.string(),
    bg: z.string().nullish(),
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

import { z } from 'zod';

// Zod schema for the AI turn response (see ТЗ §7).
// Kept permissive on ids/emotions; the parser resolves/repairs against the manifest.

export const beatSchema = z.union([
  z.object({ type: z.literal('narration'), text: z.string() }),
  z.object({ type: z.literal('thought'), text: z.string() }),
  z.object({
    type: z.literal('dialogue'),
    characterId: z.string(),
    emotion: z.string().default('neutral'),
    position: z.enum(['left', 'center', 'right']).default('center'),
    text: z.string(),
  }),
]);

export const sceneSchema = z.object({
  backgroundId: z.string().nullable().default(null),
  musicId: z.string().nullable().default(null),
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

export const aiTurnSchema = z.object({
  scene: sceneSchema.default({
    backgroundId: null,
    musicId: null,
    sfxId: null,
    cutsceneCgId: null,
  }),
  beats: z.array(beatSchema).default([]),
  statChanges: z.array(statChangeSchema).default([]),
  choices: z.array(choiceSchema).default([]),
  chapterEvent: z.enum(['chapter_end', 'cg_moment']).nullable().default(null),
});

export type ParsedAiTurn = z.infer<typeof aiTurnSchema>;

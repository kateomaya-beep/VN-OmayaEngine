import type { Project, RuntimeState } from '../shared/types';
import { runCompletion } from './providers';

// Собирает короткий промпт для image-API из текущего контекста сцены
// (локация, настроение, последние beats). Отдельный дешёвый вызов LLM.
export async function composeImagePrompt(
  project: Project,
  state: RuntimeState,
  kind: 'background' | 'cg'
): Promise<string> {
  const bgName = project.assets.find((a) => a.id === state.currentBackgroundId)?.name || 'неизвестно';
  const recent = state.history
    .slice(-2)
    .map((m) => m.content)
    .join('\n')
    .slice(0, 1200);

  const what =
    kind === 'background'
      ? 'a background environment (no characters, wide establishing shot)'
      : 'a dramatic CG illustration of the current key moment (may include characters)';

  const system = `You write concise prompts for a text-to-image model. Output ONLY the prompt text,
one line, in English, no quotes, no explanations. Describe ${what} for a visual novel scene.
Include location, time of day, lighting, mood and art style (polished anime/visual-novel illustration).`;

  const user = `Мир: ${project.lore.worldDescription.slice(0, 400)}
Текущий фон: ${bgName}
Настроение музыки: ${state.currentMusicMood ?? 'нет'}
Последние события:\n${recent}`;

  const raw = await runCompletion({
    system,
    messages: [{ role: 'user', content: user }],
    model: project.aiConfig.summarizerModel || undefined,
    temperature: 0.7,
  });
  // На случай, если модель всё же обернула в кавычки/markdown.
  return raw.replace(/^```[a-z]*\n?|```$/gi, '').replace(/^["'\s]+|["'\s]+$/g, '').trim();
}

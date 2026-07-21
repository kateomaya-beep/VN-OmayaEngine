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

// CG-студия: воркер превращает ТЕКУЩУЮ сцену в image-промпт по РЕДАКТИРУЕМОМУ
// шаблону (systemPrompt). Даёт модели имена и внешность присутствующих персонажей,
// их наряд/эмоцию, локацию и суть момента. Возвращает чистый промпт (без стиля —
// стиль добавляется отдельно).
export async function composeCgPrompt(
  project: Project,
  state: RuntimeState,
  systemPrompt: string
): Promise<string> {
  const present = state.onScreen
    .map((os) => ({ os, c: project.characters.find((c) => c.id === os.characterId) }))
    .filter((x) => x.c);
  const charLines = present.map(({ os, c }) => {
    const nm = c!.role === 'protagonist' ? state.protagonistName || c!.name : c!.name;
    const appearance = (c!.card.appearance || '').slice(0, 300);
    const bits = [os.outfit ? `outfit: ${os.outfit}` : '', os.emotion ? `expression: ${os.emotion}` : '']
      .filter(Boolean)
      .join(', ');
    return `- ${nm}: ${appearance}${bits ? ` (${bits})` : ''}`;
  });

  const loc =
    state.gm?.clock?.location ||
    project.assets.find((a) => a.id === state.currentBackgroundId)?.name ||
    '';
  const recent =
    (state.lastTurn?.beats || [])
      .filter((b): b is Extract<typeof b, { text: string }> => 'text' in b && !!b.text)
      .map((b) => b.text)
      .join(' ')
      .slice(0, 1000) ||
    state.history.slice(-1).map((m) => m.content).join(' ').slice(0, 1000);

  const user = `SCENE TO ILLUSTRATE AS A CG:
Location: ${loc || 'unspecified'}
Characters in frame (use these exact names):
${charLines.join('\n') || '(no named characters — an environment/mood CG)'}
What is happening at this exact moment:
${recent || '(quiet beat — infer from location and characters)'}`;

  const raw = await runCompletion({
    system: systemPrompt,
    messages: [{ role: 'user', content: user }],
    model: project.aiConfig.summarizerModel || undefined,
    temperature: 0.7,
  });
  return raw.replace(/^```[a-z]*\n?|```$/gi, '').replace(/^["'\s]+|["'\s]+$/g, '').trim();
}

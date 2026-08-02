import type { Project, RuntimeState, ImageAspectRatio } from '../shared/types';
import { IMAGE_ASPECT_RATIOS } from '../shared/types';
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
  systemPrompt: string,
  opts?: { onlyCharacterIds?: string[] }
): Promise<{ prompt: string; aspectRatio?: ImageAspectRatio; cast?: string[] }> {
  // Кандидаты — те, кто «на сцене» по состоянию движка. ВАЖНО: это не значит,
  // что все они в кадре: персонаж остаётся на сцене и после своей реплики, и на
  // трёх персонажах NPC не выпадал никогда — поэтому лез в каждую кат-сцену.
  // Кто реально попадёт в кадр, решает воркер по тексту момента (строка CAST),
  // либо пользователь, отметив состав руками (onlyCharacterIds).
  const manual = opts?.onlyCharacterIds;
  const present = state.onScreen
    .map((os) => ({ os, c: project.characters.find((c) => c.id === os.characterId) }))
    .filter((x) => x.c && (!manual || manual.includes(x.c!.id)));
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

  const castRule = manual
    ? 'These and ONLY these characters may appear in the image — do not add anyone else.'
    : 'These people are somewhere in the current scene, but NOT all of them are necessarily in this shot. ' +
      'Read the moment below and include ONLY those who are truly part of it — leave the rest out entirely.';
  const user = `SCENE TO ILLUSTRATE AS A CG:
Location: ${loc || 'unspecified'}
Characters available (use these exact names). ${castRule}
${charLines.join('\n') || '(no named characters — an environment/mood CG)'}
What is happening at this exact moment:
${recent || '(quiet beat — infer from location and characters)'}`;

  const raw = await runCompletion({
    system: systemPrompt,
    messages: [{ role: 'user', content: user }],
    model: project.aiConfig.summarizerModel || undefined,
    temperature: 0.7,
  });
  const text = raw.replace(/^```[a-z]*\n?|```$/gi, '').replace(/^["'\s]+|["'\s]+$/g, '').trim();
  return extractTrailingDirectives(text);
}

// Воркер по дефолтному шаблону заканчивает промпт служебными строками:
//   CAST: Кейт, Эрик     — кто РЕАЛЬНО в кадре (решает модель, читая сцену);
//   ASPECT: 16:9         — кадр для режима «авто».
// В текст для художника они попасть не должны, поэтому срезаются с хвоста.
// Своего шаблона это не ломает: нет строк — просто промпт, состав и кадр берутся
// из настроек/движка.
export function extractTrailingDirectives(text: string): {
  prompt: string;
  aspectRatio?: ImageAspectRatio;
  cast?: string[];
} {
  let t = text.trim();
  let aspectRatio: ImageAspectRatio | undefined;
  let cast: string[] | undefined;
  // Директивы идут в любом порядке, поэтому снимаем их с конца по одной.
  for (let i = 0; i < 4; i++) {
    const m = /(^|\n)[ \t]*(ASPECT|CAST)[ \t]*[:=][ \t]*([^\n]*?)[ \t]*\.?[ \t]*$/i.exec(t);
    if (!m) break;
    const key = m[2].toUpperCase();
    const val = m[3].trim();
    if (key === 'ASPECT') {
      const r = val.replace(/\s+/g, '');
      if ((IMAGE_ASPECT_RATIOS as readonly string[]).includes(r)) aspectRatio = r as ImageAspectRatio;
    } else {
      const names = val
        .split(/[,;]/)
        .map((s) => s.trim())
        .filter((s) => s && !/^(none|нет|никого)$/i.test(s));
      // Пустой список — тоже ответ: в кадре людей нет (пейзаж, деталь).
      cast = names;
    }
    t = t.slice(0, m.index).trim();
  }
  return { prompt: t || text.trim(), aspectRatio, cast };
}

import type { Project, RuntimeState, PhoneShopItem } from '../shared/types';
import { runCompletion } from './providers';
import { getPresetSettings } from './presetSettings';
import { extractJson } from './responseParser';
import { uid } from '../shared/utils';

// Генерация ассортимента приложения «Доставка» (ревизия блока 6 §3). Лёгкий вызов
// ИИ: под сеттинг проекта и прайс-гайд выдаёт несколько позиций в одной категории.
// Результат кэшируется в состоянии телефона (deliveryCache), не перегенерируется.

const COUNT = 6;

export async function generateDeliveryItems(
  project: Project,
  state: RuntimeState,
  categoryName: string,
  existingNames: string[]
): Promise<PhoneShopItem[]> {
  const ps = getPresetSettings();
  const narr = ps.narrativeLanguage === 'en' ? 'English' : 'Russian (русский)';
  const cur = project.phone?.currencyName || '$';
  const guide = project.phone?.priceGuide?.trim();

  const system = [
    `You generate items for a fictional in-game delivery app inside a visual novel.`,
    `World / setting:\n${(project.lore.worldDescription || '').slice(0, 600)}`,
    guide ? `Price guide (keep prices in this order of magnitude): ${guide}` : '',
    `Currency symbol/name: ${cur}.`,
    `Return ONLY a JSON array (no prose, no markdown) of exactly ${COUNT} objects for the category "${categoryName}":`,
    `[{"name": string, "price": number, "description": short string}]`,
    `Rules: names and descriptions in ${narr}; prices are plain numbers matching the price guide; items must fit the setting and the category; do NOT repeat any of these existing items: ${
      existingNames.length ? existingNames.join(', ') : '(none)'
    }.`,
  ]
    .filter(Boolean)
    .join('\n');

  const raw = await runCompletion({
    system,
    messages: [{ role: 'user', content: `Generate ${COUNT} delivery items for "${categoryName}".` }],
    temperature: Math.min(ps.temperature ?? 0.8, 1),
    maxTokens: 700,
    reasoningEffort: 'none',
  });

  const js = extractJson(raw);
  if (!js) return [];
  let arr: any;
  try {
    arr = JSON.parse(js);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const seen = new Set(existingNames.map((n) => n.toLowerCase()));
  const out: PhoneShopItem[] = [];
  for (const it of arr) {
    if (!it || typeof it.name !== 'string' || !it.name.trim()) continue;
    const name = it.name.trim();
    if (seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push({
      id: uid('ditem'),
      name,
      category: categoryName,
      price: typeof it.price === 'number' && Number.isFinite(it.price) ? Math.max(0, Math.round(it.price)) : 0,
      description: typeof it.description === 'string' ? it.description.trim().slice(0, 160) : undefined,
      generated: true,
    });
  }
  return out;
}

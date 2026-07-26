// Локальный подбор эмодзи для инвентаря (Batch 8, Часть IV §2). Работает без запроса
// к ИИ — по ключевым словам в названии (ru/en). Первый успешный матч побеждает;
// иначе fallback 📦 (никогда не пусто).

const RULES: { re: RegExp; emoji: string }[] = [
  { re: /плать|dress/i, emoji: '👗' },
  { re: /рубаш|футбол|майк|shirt|tee/i, emoji: '👕' },
  { re: /штан|джинс|брюк|pants|jeans/i, emoji: '👖' },
  { re: /туфл|ботин|обув|кросс|shoe|boot|sneaker/i, emoji: '👟' },
  { re: /куртк|пальто|плащ|jacket|coat/i, emoji: '🧥' },
  { re: /шляп|шапк|кепк|hat|cap/i, emoji: '🎩' },
  { re: /пицц|pizza/i, emoji: '🍕' },
  { re: /салат|salad/i, emoji: '🥗' },
  { re: /бургер|burger/i, emoji: '🍔' },
  { re: /кофе|coffee|латте|эспрессо/i, emoji: '☕' },
  { re: /ча[йя]|tea/i, emoji: '🍵' },
  { re: /вино|wine|шампан/i, emoji: '🍷' },
  { re: /пиво|beer/i, emoji: '🍺' },
  { re: /вод[ак]|whisk|виски|коньяк|alcohol/i, emoji: '🥃' },
  { re: /еда|снек|перекус|food|snack/i, emoji: '🍽️' },
  { re: /тортик|торт|пирож|cake|десерт|dessert/i, emoji: '🍰' },
  { re: /фрукт|яблок|apple|fruit/i, emoji: '🍎' },
  { re: /ключ|key/i, emoji: '🔑' },
  { re: /книг|book|тетрад/i, emoji: '📖' },
  { re: /письм|записк|letter|note/i, emoji: '✉️' },
  { re: /телефон|смартфон|phone/i, emoji: '📱' },
  { re: /ноутбук|компьютер|laptop|computer/i, emoji: '💻' },
  { re: /деньг|наличн|куп[юя]р|cash|money|банкнот/i, emoji: '💵' },
  { re: /карт[аы]|card/i, emoji: '💳' },
  { re: /лекарст|таблет|пилюл|medic|pill|drug/i, emoji: '💊' },
  { re: /цвет|букет|роз|flower|bouquet|rose/i, emoji: '💐' },
  { re: /подар|gift|present/i, emoji: '🎁' },
  { re: /кольц|ring|украшен|jewel/i, emoji: '💍' },
  { re: /сумк|рюкзак|bag|backpack/i, emoji: '👜' },
  { re: /зонт|umbrella/i, emoji: '☂️' },
  { re: /сигарет|cigarette|табак/i, emoji: '🚬' },
  { re: /нож|knife|оруж|weapon|пистолет|gun/i, emoji: '🔪' },
  { re: /посылк|коробк|parcel|package|box/i, emoji: '📦' },
  { re: /кофевар|чайник|прибор|appliance/i, emoji: '🫖' },
  { re: /фото|photo|снимок|картин/i, emoji: '🖼️' },
  { re: /билет|ticket/i, emoji: '🎫' },
  { re: /документ|паспорт|document|passport/i, emoji: '📄' },
];

export function resolveEmoji(name: string, provided?: string): string {
  // 1) ИИ/юзер уже дал эмодзи — уважаем (берём первый символ-графему).
  if (provided && provided.trim()) {
    const g = [...provided.trim()][0];
    if (g) return g;
  }
  // 2) Локальный словарь.
  for (const r of RULES) if (r.re.test(name)) return r.emoji;
  // 3) Fallback.
  return '📦';
}

import { useState } from 'react';
import {
  newRegexRule,
  testRegexRule,
  type RegexRule,
  type RegexScope,
  type RegexTarget,
} from '../../ai/regexRules';

// Редактор правил-регэкспов. Живёт в панели пресета, рядом с остальным, что
// определяет, каким текст доезжает до модели и до экрана.
//
// Каждое правило — одна замена: что найти, чем заменить, к чьему тексту применить
// и где именно (экран / запрос / оба). Пробный прогон прямо в карточке: правило
// доводится до ума здесь, а не методом «сгенерировать ход и посмотреть».

const TARGETS: { id: RegexTarget; label: string; hint: string }[] = [
  { id: 'ai', label: 'Ответ ИИ', hint: 'применять к тому, что пишет модель' },
  { id: 'user', label: 'Ход игрока', hint: 'применять к тому, что пишете вы' },
  { id: 'both', label: 'Оба', hint: 'применять и туда, и туда' },
];

const SCOPES: { id: RegexScope; label: string; hint: string }[] = [
  { id: 'display', label: 'На экране', hint: 'в истории и в контексте останется исходный текст' },
  { id: 'prompt', label: 'В запросе', hint: 'модель увидит изменённый текст, вы — исходный' },
  { id: 'both', label: 'Везде', hint: 'и на экране, и в запросе' },
];

// Заготовки под самые частые случаи. Не «примеры в документации», а рабочие
// правила: жмёшь — и оно уже в списке, останется поправить под себя.
const TEMPLATES: { name: string; rule: Partial<RegexRule> }[] = [
  {
    name: 'Убрать «Имя:» перед репликой',
    rule: { name: 'Убрать имя перед репликой', find: '^\\s*[А-ЯЁA-Z][\\wА-Яа-яЁё -]{0,20}:\\s*', flags: 'gm', replace: '' },
  },
  {
    name: 'Спрятать (OOC: …)',
    rule: { name: 'Спрятать OOC', find: '\\(\\s*OOC:[^)]*\\)', flags: 'gi', replace: '' },
  },
  {
    name: 'Кавычки-лапки → ёлочки',
    rule: { name: 'Ёлочки', find: '"([^"]+)"', flags: 'g', replace: '«$1»' },
  },
  {
    name: 'Схлопнуть пустые строки',
    rule: { name: 'Без тройных переносов', find: '\\n{3,}', flags: 'g', replace: '\n\n' },
  },
];

export function RegexRulesEditor({
  rules,
  onChange,
}: {
  rules: RegexRule[];
  onChange: (next: RegexRule[]) => void;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [sample, setSample] = useState('Дэм: «Долго же ты.» (OOC: напомни, где мы)');

  const patch = (id: string, p: Partial<RegexRule>) =>
    onChange(rules.map((r) => (r.id === id ? { ...r, ...p } : r)));
  const remove = (id: string) => onChange(rules.filter((r) => r.id !== id));
  const add = (preset?: Partial<RegexRule>) => {
    const rule = { ...newRegexRule(), ...preset };
    onChange([...rules, rule]);
    setOpenId(rule.id);
  };
  const move = (id: string, dir: -1 | 1) => {
    const i = rules.findIndex((r) => r.id === id);
    const j = i + dir;
    if (i === -1 || j < 0 || j >= rules.length) return;
    const next = [...rules];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };

  return (
    <div className="card !bg-panel2 mt-4">
      <div className="flex items-start justify-between gap-3 mb-2">
        <div>
          <h4 className="font-semibold">Правила-регэкспы</h4>
          <p className="text-xs text-gray-500">
            Правка текста между моделью и экраном. Порядок сверху вниз — правила
            применяются одно за другим. В замене работают <code>$1</code>…<code>$9</code> и{' '}
            <code>{'{{match}}'}</code> (всё совпадение).
          </p>
        </div>
        <button className="btn-ghost !px-3 !py-1 text-xs whitespace-nowrap" onClick={() => add()}>
          + Правило
        </button>
      </div>

      {rules.length === 0 && (
        <div className="mb-2">
          <p className="text-xs text-gray-500 mb-1.5">Пока ни одного. Готовые заготовки:</p>
          <div className="flex gap-1.5 flex-wrap">
            {TEMPLATES.map((t) => (
              <button key={t.name} className="chip !px-2.5 !py-1 text-xs" onClick={() => add(t.rule)}>
                {t.name}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="space-y-2">
        {rules.map((r, i) => {
          const test = testRegexRule(r, sample);
          const open = openId === r.id;
          return (
            <div
              key={r.id}
              className={`rounded-lg border p-2.5 bg-panel ${test.ok ? 'border-white/10' : 'border-red-500/50'}`}
            >
              <div className="flex items-center gap-2 flex-wrap">
                <input
                  type="checkbox"
                  checked={r.enabled}
                  onChange={(e) => patch(r.id, { enabled: e.target.checked })}
                  title="Вкл/выкл правило"
                />
                <input
                  className="input !py-1 text-sm flex-1 min-w-[8rem]"
                  value={r.name}
                  onChange={(e) => patch(r.id, { name: e.target.value })}
                />
                <button
                  className="btn-ghost !px-2 !py-1 text-xs"
                  title="Выше"
                  disabled={i === 0}
                  onClick={() => move(r.id, -1)}
                >
                  ↑
                </button>
                <button
                  className="btn-ghost !px-2 !py-1 text-xs"
                  title="Ниже"
                  disabled={i === rules.length - 1}
                  onClick={() => move(r.id, 1)}
                >
                  ↓
                </button>
                <button
                  className="btn-ghost !px-2 !py-1 text-xs"
                  onClick={() => setOpenId(open ? null : r.id)}
                >
                  {open ? 'Свернуть' : 'Правка'}
                </button>
                <button className="btn-danger !px-2 !py-1 text-xs" title="Удалить" onClick={() => remove(r.id)}>
                  ✕
                </button>
              </div>

              {open && (
                <div className="mt-2 space-y-2">
                  <div className="flex gap-2 items-center">
                    <span className="text-xs text-gray-500 w-16 shrink-0">Найти</span>
                    <input
                      className="input !py-1 text-sm font-mono flex-1"
                      placeholder="регулярное выражение"
                      value={r.find}
                      onChange={(e) => patch(r.id, { find: e.target.value })}
                    />
                    <input
                      className="input !py-1 text-sm font-mono w-20"
                      placeholder="флаги"
                      title="g — все совпадения, i — без учёта регистра, m — построчно, s — точка ловит перенос"
                      value={r.flags}
                      onChange={(e) => patch(r.id, { flags: e.target.value })}
                    />
                  </div>
                  <div className="flex gap-2 items-center">
                    <span className="text-xs text-gray-500 w-16 shrink-0">Заменить</span>
                    <input
                      className="input !py-1 text-sm font-mono flex-1"
                      placeholder="пусто — просто вырезать"
                      value={r.replace}
                      onChange={(e) => patch(r.id, { replace: e.target.value })}
                    />
                  </div>

                  <div className="grid sm:grid-cols-2 gap-2">
                    <div>
                      <div className="text-xs text-gray-500 mb-1">К чьему тексту</div>
                      <div className="inline-flex rounded-lg overflow-hidden border border-white/10 text-xs">
                        {TARGETS.map((t) => (
                          <button
                            key={t.id}
                            title={t.hint}
                            className={`px-2.5 py-1 ${
                              r.appliesTo === t.id ? 'bg-accent2 text-white' : 'bg-panel2 hover:bg-white/10'
                            }`}
                            onClick={() => patch(r.id, { appliesTo: t.id })}
                          >
                            {t.label}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div>
                      <div className="text-xs text-gray-500 mb-1">Где применять</div>
                      <div className="inline-flex rounded-lg overflow-hidden border border-white/10 text-xs">
                        {SCOPES.map((t) => (
                          <button
                            key={t.id}
                            title={t.hint}
                            className={`px-2.5 py-1 ${
                              r.scope === t.id ? 'bg-accent2 text-white' : 'bg-panel2 hover:bg-white/10'
                            }`}
                            onClick={() => patch(r.id, { scope: t.id })}
                          >
                            {t.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>

                  <div>
                    <div className="text-xs text-gray-500 mb-1">Проба на тексте</div>
                    <input
                      className="input !py-1 text-sm"
                      value={sample}
                      onChange={(e) => setSample(e.target.value)}
                    />
                    <div
                      className={`mt-1 text-xs rounded px-2 py-1.5 font-mono whitespace-pre-wrap ${
                        test.ok ? 'bg-black/30 text-gray-300' : 'bg-red-900/40 text-red-300'
                      }`}
                    >
                      {test.ok ? test.result || '(пусто)' : `Выражение не компилируется: ${test.result}`}
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

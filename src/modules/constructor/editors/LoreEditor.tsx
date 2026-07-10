import { useProjectStore } from '../projectStore';
import { Field } from '../../../shared/ui';

export function LoreEditor() {
  const { project, update } = useProjectStore();
  if (!project) return null;
  const l = project.lore;
  return (
    <div className="card max-w-3xl">
      <Field label="Описание мира" hint="Сеттинг, эпоха, тон. Это ядро контекста для ИИ.">
        <textarea
          className="input h-32"
          value={l.worldDescription}
          onChange={(e) => update((p) => (p.lore.worldDescription = e.target.value))}
        />
      </Field>
      <Field label="Арка сюжета (опц.)" hint="Общее направление истории — помогает ИИ вести сюжет.">
        <textarea
          className="input h-24"
          value={l.plotOutline}
          onChange={(e) => update((p) => (p.lore.plotOutline = e.target.value))}
        />
      </Field>
      <Field label="Стартовая сцена" hint="С чего начинается игра (обязательно для запуска).">
        <textarea
          className="input h-24"
          value={l.openingScene}
          onChange={(e) => update((p) => (p.lore.openingScene = e.target.value))}
        />
      </Field>
      <Field label="Правила повествования" hint='Авторские правила: "от 2 лица", "нельзя убивать ГГ" и т.п.'>
        <textarea
          className="input h-24"
          value={l.narrativeRules}
          onChange={(e) => update((p) => (p.lore.narrativeRules = e.target.value))}
        />
      </Field>
    </div>
  );
}

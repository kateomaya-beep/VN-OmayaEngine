import { useEffect, useState } from 'react';
import { Modal } from '../../shared/ui';
import { ApiConnectionField } from '../constructor/editors/ApiConnectionField';
import { useConnection } from '../../ai/connection';
import { useConnectionPresets } from '../../ai/connectionPresets';
import { isProxyActive } from '../../ai/providers';

// Глобальное основное подключение к LLM (Batch 3 §2): единый источник истины для
// всей игровой генерации, не на проект. Живёт в верхней панели везде.
export function ConnectionPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { connection, setConnection } = useConnection();
  const { presets, activeId, saveCurrent, apply, remove } = useConnectionPresets();
  const [proxy, setProxy] = useState<boolean | null>(null);
  useEffect(() => {
    if (open) isProxyActive().then(setProxy);
  }, [open]);
  if (!open) return null;
  return (
    <Modal open={open} onClose={onClose} title="Подключение к ИИ (основное)" wide>
      {/* Статус локального прокси (как в SillyTavern: запрос идёт через наш сервер). */}
      {proxy !== null && (
        <div
          className={`mb-3 rounded-lg border px-3 py-2 text-xs ${
            proxy
              ? 'border-emerald-400/30 bg-emerald-500/10 text-emerald-300'
              : 'border-amber-400/30 bg-amber-500/10 text-amber-200'
          }`}
        >
          {proxy
            ? '🛡 Локальный прокси активен — запросы к ИИ идут через наш сервер (без CORS, как в SillyTavern). Работают любые провайдеры.'
            : '⚠ Локального прокси нет (открыто как статичная страница) — запросы идут напрямую из браузера, возможен CORS. Запустите приложение через лаунчер, чтобы прокси включился.'}
        </div>
      )}
      <p className="text-xs text-gray-500 mb-4">
        Одно активное подключение на всё приложение. Несколько провайдеров можно держать
        пресетами и переключаться. Ключ хранится только в этом браузере. Отдельные
        подключения для саммари/эмбеддингов/картинок — в «Расширениях».
      </p>

      {/* Пресеты подключения: быстрое переключение между провайдерами. */}
      <div className="card !bg-panel2 !p-3 mb-4">
        <label className="label">Пресеты подключения</label>
        <div className="flex gap-2 flex-wrap items-center">
          <select
            className="input flex-1 min-w-[10rem]"
            value={activeId || ''}
            onChange={(e) => e.target.value && apply(e.target.value)}
          >
            <option value="">— выбрать пресет —</option>
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} · {p.provider === 'anthropic' ? 'Anthropic' : 'OpenAI'} · {p.model || '—'}
              </option>
            ))}
          </select>
          <button
            className="btn-ghost !px-3 text-xs shrink-0"
            onClick={() => {
              const name = window.prompt(
                'Имя пресета (напр. «DeepSeek», «Claude»). Сохранит текущий провайдер, URL, модель и ключ.',
                presets.find((p) => p.id === activeId)?.name || ''
              );
              if (name && name.trim()) saveCurrent(name.trim());
            }}
          >
            💾 Сохранить
          </button>
          {activeId && (
            <button
              className="btn-ghost !px-2 text-xs text-red-300 shrink-0"
              title="Удалить активный пресет"
              onClick={() => {
                const p = presets.find((x) => x.id === activeId);
                if (p && window.confirm(`Удалить пресет «${p.name}»?`)) remove(p.id);
              }}
            >
              🗑
            </button>
          )}
        </div>
        <p className="text-[11px] text-gray-500 mt-1">
          «Сохранить» запоминает текущие настройки под именем (со своим ключом). Выбор из списка —
          мгновенно переключает провайдера.
        </p>
      </div>

      {/* Быстрое подключение к модели НА СВОЁМ КОМПЬЮТЕРЕ. Отдельной «поддержки»
          локальных моделей движку не нужно: LM Studio и Ollama говорят на том же
          OpenAI-совместимом протоколе. Нужен ровно адрес — и вот его-то никто не
          помнит наизусть, а ошибка в нём выглядит как «ничего не работает». */}
      <div className="card !bg-panel2 !p-3 mb-4">
        <label className="label">Модель на своём компьютере</label>
        <div className="flex gap-2 flex-wrap items-center">
          {LOCAL_TARGETS.map((t) => (
            <button
              key={t.name}
              className={`btn-ghost !px-3 text-xs ${
                connection.baseUrl.replace(/\/$/, '') === t.baseUrl ? '!border-emerald-400/60 text-emerald-200' : ''
              }`}
              title={`${t.baseUrl} — ${t.hint}`}
              onClick={() =>
                setConnection({ provider: 'openai-compatible', baseUrl: t.baseUrl, model: connection.model })
              }
            >
              🖥 {t.name}
            </button>
          ))}
        </div>
        <p className="text-[11px] text-gray-500 mt-2">
          Подставит адрес и провайдера. Ключ таким серверам не нужен — оставьте поле пустым.
          Дальше нажмите ⟳ рядом с «Моделью»: список подтянется из того, что у вас загружено.
          В LM Studio модель должна быть ЗАГРУЖЕНА и сервер запущен (вкладка Developer →
          Start Server), иначе список придёт пустым.
        </p>
        <p className="text-[11px] text-gray-500 mt-1">
          Под маленькую модель стоит включить «🖥 Модель у меня на компьютере» в пресете (🎚):
          она подгонит контекст, длину хода и сам пресет — без этого локальная модель почти
          наверняка захлебнётся.
        </p>
      </div>

      <ApiConnectionField
        conn={connection}
        keyRole={connection.provider}
        onChange={(conn) => setConnection(conn)}
      />
    </Modal>
  );
}

// Адреса по умолчанию у локальных серверов. Оба — OpenAI-совместимые ручки, и
// порт у каждого свой фиксированный: у LM Studio 1234, у Ollama 11434.
const LOCAL_TARGETS = [
  { name: 'LM Studio', baseUrl: 'http://localhost:1234/v1', hint: 'вкладка Developer → Start Server' },
  { name: 'Ollama', baseUrl: 'http://localhost:11434/v1', hint: 'ollama serve' },
  { name: 'llama.cpp', baseUrl: 'http://localhost:8080/v1', hint: 'llama-server --port 8080' },
];

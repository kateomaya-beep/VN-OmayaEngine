import { useEffect, useState } from 'react';
import { Modal } from '../../shared/ui';
import { ApiConnectionField } from '../constructor/editors/ApiConnectionField';
import { useConnection } from '../../ai/connection';
import { isProxyActive } from '../../ai/providers';

// Глобальное основное подключение к LLM (Batch 3 §2): единый источник истины для
// всей игровой генерации, не на проект. Живёт в верхней панели везде.
export function ConnectionPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { connection, setConnection } = useConnection();
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
        Одно подключение на всё приложение — используется всеми проектами. Ключ хранится только в
        этом браузере. Отдельные подключения для саммари/эмбеддингов/картинок — в «Расширениях».
      </p>
      <ApiConnectionField
        conn={connection}
        keyRole={connection.provider}
        onChange={(conn) => setConnection(conn)}
      />
    </Modal>
  );
}

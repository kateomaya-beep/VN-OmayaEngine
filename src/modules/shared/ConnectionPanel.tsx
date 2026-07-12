import { Modal } from '../../shared/ui';
import { ApiConnectionField } from '../constructor/editors/ApiConnectionField';
import { useConnection } from '../../ai/connection';

// Глобальное основное подключение к LLM (Batch 3 §2): единый источник истины для
// всей игровой генерации, не на проект. Живёт в верхней панели везде.
export function ConnectionPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { connection, setConnection } = useConnection();
  if (!open) return null;
  return (
    <Modal open={open} onClose={onClose} title="Подключение к ИИ (основное)" wide>
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

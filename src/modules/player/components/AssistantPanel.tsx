import { usePlayerStore } from '../playerStore';
import { Modal } from '../../../shared/ui';
import { AssistantChat } from '../../constructor/editors/AssistantChat';

// Тот же ассистент-соавтор, что в конструкторе, но открытый прямо во время игры
// (доработка §7): если по ходу партии нужно что-то поменять или дописать в
// сеттинге, не обязательно выходить из истории. Пишет через тот же patchProject,
// что и «Правка в игре», — правки сразу в манифесте и на диске.
export function AssistantPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const s = usePlayerStore();
  if (!open || !s.project) return null;
  return (
    <Modal open={open} onClose={onClose} title="Ассистент-соавтор" wide>
      <AssistantChat project={s.project} update={(mutator) => void s.patchProject(mutator)} />
    </Modal>
  );
}

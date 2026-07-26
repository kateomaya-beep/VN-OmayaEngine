import { useProjectStore } from '../projectStore';
import { LorebookEntriesEditor } from '../../shared/LorebookEntriesEditor';

export function LorebookEditor() {
  const { project, update } = useProjectStore();
  if (!project) return null;
  return <LorebookEntriesEditor project={project} onPatch={update} />;
}

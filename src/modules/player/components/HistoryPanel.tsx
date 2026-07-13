import { Modal } from '../../../shared/ui';
import { Markdown, InlineMarkdown } from '../../../shared/markdown';
import { extractJson, stripMoveTag } from '../../../ai/responseParser';
import { useLang } from '../../../shared/i18n';
import { usePlayerStore } from '../playerStore';
import type { Project, RuntimeState } from '../../../shared/types';

// История ходов для перечитывания (бэклог). Показывает свёрнутую хронику (старое,
// сжатое), затем живые ходы в виде прозы: реплики «Имя: текст» + нарратив/мысли,
// и что вводил игрок. Источник — state.memory.chronicle + state.history.
type TurnLine =
  | { kind: 'narration' | 'thought'; text: string }
  | { kind: 'dialogue'; name: string; text: string };

function parseTurn(raw: string, project: Project, state: RuntimeState): TurnLine[] {
  const js = extractJson(raw);
  if (!js) return [{ kind: 'narration', text: raw.slice(0, 500) }];
  let obj: any;
  try {
    obj = JSON.parse(js);
  } catch {
    return [{ kind: 'narration', text: raw.slice(0, 500) }];
  }
  if (!obj || !Array.isArray(obj.beats)) return [];
  const nameOf = (b: any): string => {
    if (b.characterId) {
      const c = project.characters.find((x) => x.id === b.characterId);
      if (c) return c.role === 'protagonist' ? state.protagonistName || c.name : c.name;
    }
    return typeof b.name === 'string' ? b.name : '';
  };
  return obj.beats
    .map((b: any): TurnLine | null => {
      const text = typeof b?.text === 'string' ? b.text : '';
      if (!text) return null;
      if (b.type === 'dialogue') return { kind: 'dialogue', name: nameOf(b), text };
      return { kind: b.type === 'thought' ? 'thought' : 'narration', text };
    })
    .filter(Boolean) as TurnLine[];
}

export function HistoryPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const lang = useLang((s) => s.lang);
  const L = (ru: string, en: string) => (lang === 'en' ? en : ru);
  const project = usePlayerStore((s) => s.project);
  const state = usePlayerStore((s) => s.state);
  if (!open) return null;

  const chronicle = state?.memory.chronicle ?? [];
  const history = state?.history ?? [];

  return (
    <Modal open={open} onClose={onClose} title={L('История (перечитать)', 'History (re-read)')} wide>
      {(!project || !state) && <p className="text-sm text-gray-500">{L('Нет активной игры.', 'No active game.')}</p>}
      {project && state && (
        <div className="max-h-[65vh] overflow-y-auto scrollbar-thin space-y-4 pr-1">
          {/* Свёрнутое прошлое (сжатая хроника) */}
          {chronicle.length > 0 && (
            <div className="rounded-lg border border-white/10 bg-panel2 p-3">
              <p className="text-xs uppercase tracking-wide text-gray-500 mb-2">
                {L('Ранее (сжато)', 'Earlier (compressed)')}
              </p>
              <div className="space-y-1.5">
                {chronicle.map((c, i) => (
                  <p key={c.id} className="text-sm text-gray-400">
                    <span className="text-gray-600">[{i + 1}]</span> {c.text}
                  </p>
                ))}
              </div>
            </div>
          )}

          {/* Живые ходы прозой */}
          {history.length === 0 && chronicle.length === 0 && (
            <p className="text-sm text-gray-600">{L('Пока пусто.', 'Nothing yet.')}</p>
          )}
          {history.map((m, i) => {
            if (m.role === 'user') {
              const moveText = stripMoveTag(m.content).trim();
              const label =
                m.content.includes('[CONTINUE]') && !moveText
                  ? L('(вы наблюдаете)', '(you watch)')
                  : moveText || m.content;
              return (
                <div key={i} className="text-sm text-accent2/90 border-l-2 border-accent2/40 pl-3">
                  ▸ {label}
                </div>
              );
            }
            const lines = parseTurn(m.content, project, state);
            return (
              <div key={i} className="space-y-1.5">
                {lines.map((ln, j) =>
                  ln.kind === 'dialogue' ? (
                    <p key={j} className="text-sm">
                      {ln.name && <span className="font-semibold text-accent">{ln.name}: </span>}
                      <InlineMarkdown text={ln.text} />
                    </p>
                  ) : (
                    <Markdown
                      key={j}
                      text={ln.text}
                      className={`text-sm ${ln.kind === 'thought' ? 'italic text-gray-400' : 'text-gray-200'}`}
                    />
                  )
                )}
              </div>
            );
          })}
        </div>
      )}
    </Modal>
  );
}

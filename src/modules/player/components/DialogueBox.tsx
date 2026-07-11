import { useEffect, useState } from 'react';
import type { Project, Beat } from '../../../shared/types';

// Typewriter dialogue box. Clicking anywhere either completes the current
// typewriter or advances to the next beat (handled by parent via onAdvance).
export function DialogueBox({
  project,
  beat,
  onAdvance,
  hasMore,
  protagonistName,
}: {
  project: Project;
  beat: Beat | null;
  onAdvance: () => void;
  hasMore: boolean;
  protagonistName: string;
}) {
  const [shown, setShown] = useState('');
  const [done, setDone] = useState(false);

  const fullText = beat?.text ?? '';

  useEffect(() => {
    setShown('');
    setDone(false);
    if (!fullText) return;
    let i = 0;
    const id = setInterval(() => {
      i++;
      setShown(fullText.slice(0, i));
      if (i >= fullText.length) {
        clearInterval(id);
        setDone(true);
      }
    }, 18);
    return () => clearInterval(id);
  }, [fullText]);

  if (!beat) return null;

  let speaker = '';
  if (beat.type === 'dialogue') {
    const ch = beat.characterId
      ? project.characters.find((c) => c.id === beat.characterId)
      : undefined;
    if (ch) {
      // Протагонист говорит под именем, введённым игроком.
      speaker = ch.role === 'protagonist' && protagonistName ? protagonistName : ch.name;
    } else {
      // Эпизодический NPC, введённый ИИ (name без characterId).
      speaker = beat.name || '???';
    }
  } else if (beat.type === 'thought') {
    speaker = '(мысли)';
  }

  function handleClick() {
    if (!done) {
      setShown(fullText);
      setDone(true);
    } else {
      onAdvance();
    }
  }

  const isThought = beat.type === 'thought';

  return (
    <div
      className="absolute inset-x-0 bottom-0 p-4 sm:p-6 cursor-pointer select-none"
      onClick={handleClick}
    >
      <div className="max-w-4xl mx-auto">
        {speaker && (
          <div className="inline-block bg-accent px-4 py-1 rounded-t-lg font-semibold text-sm">
            {speaker}
          </div>
        )}
        <div className="bg-black/80 backdrop-blur rounded-xl rounded-tl-none p-5 min-h-[7rem] border border-white/10">
          <p className={`text-lg leading-relaxed ${isThought ? 'italic text-gray-300' : ''}`}>
            {shown}
            {!done && <span className="typewriter-cursor" />}
          </p>
          {done && (
            <div className="text-right text-accent2 text-sm mt-2 animate-pulse">
              {hasMore ? '▼ далее' : '● выбор'}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

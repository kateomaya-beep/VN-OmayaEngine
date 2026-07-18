import { useEffect, useState } from 'react';
import type { Project, Beat } from '../../../shared/types';
import { Markdown } from '../../../shared/markdown';

// Тайпрайтер-панель текущего beat. Клик — доиграть тайпрайтер или перейти дальше.
// Рендерится как блок (консоль ввода живёт отдельным баром ниже).
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

  // Сброс СИНХРОННО при смене beat (паттерн «правка стейта во время рендера»). Без
  // этого первый кадр нового бита рендерится со СТАРЫМ done=true и на миллисекунду
  // показывает весь markdown целиком, пока после отрисовки не отработает useEffect —
  // особенно заметно, когда одновременно меняется спрайт (лишний ре-рендер).
  const [tracked, setTracked] = useState(fullText);
  if (tracked !== fullText) {
    setTracked(fullText);
    setShown('');
    setDone(false);
  }

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
    if (ch) speaker = ch.role === 'protagonist' && protagonistName ? protagonistName : ch.name;
    else speaker = beat.name || '???';
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
    <div className="px-4 sm:px-6 cursor-pointer select-none" onClick={handleClick}>
      <div className="max-w-4xl mx-auto">
        {speaker && (
          <div className="inline-block bg-accent px-4 py-1 rounded-t-lg font-semibold text-sm">
            {speaker}
          </div>
        )}
        <div className="bg-black/80 backdrop-blur rounded-xl rounded-tl-none p-5 min-h-[6rem] border border-white/10">
          <div className={`text-lg leading-relaxed md-content ${isThought ? 'italic text-gray-300' : ''}`}>
            {/* Во время тайпрайтера — обычный текст; по завершении — безопасный markdown. */}
            {done ? (
              <Markdown text={fullText} />
            ) : (
              <span className="whitespace-pre-wrap">
                {shown}
                <span className="typewriter-cursor" />
              </span>
            )}
          </div>
          {done && hasMore && (
            <div className="text-right text-accent2 text-sm mt-2 animate-pulse">▼ далее</div>
          )}
        </div>
      </div>
    </div>
  );
}

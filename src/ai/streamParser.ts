// Инкрементальный парсер потокового JSON-ответа (см. Batch 3 §7.2). По мере
// прихода текста вытаскивает объект scene (рано, чтобы подхватить фон/музыку) и
// завершённые элементы beats (эффект «печатания» начинается сразу). Не заменяет
// финальный полноценный парсер — тот остаётся источником правды для state.

// Возвращает индекс символа сразу после объекта/значения, начинающегося с {,
// либо -1 если объект ещё не закрыт. Уважает строки и экранирование.
function matchBrace(s: string, open: number): number {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = open; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

export interface StreamEvents {
  scene?: any;
  beats: any[];
}

export class TurnStreamParser {
  private buf = '';
  private sceneEmitted = false;
  private beatsStart = -1; // индекс сразу после '[' массива beats
  private cursor = 0; // позиция сканирования внутри beats

  push(text: string): StreamEvents {
    this.buf += text;
    const out: StreamEvents = { beats: [] };

    if (!this.sceneEmitted) {
      const key = this.buf.indexOf('"scene"');
      if (key !== -1) {
        const brace = this.buf.indexOf('{', key);
        if (brace !== -1) {
          const end = matchBrace(this.buf, brace);
          if (end !== -1) {
            try {
              out.scene = JSON.parse(this.buf.slice(brace, end));
              this.sceneEmitted = true;
            } catch {
              /* ещё не полный/битый — подождём */
            }
          }
        }
      }
    }

    if (this.beatsStart === -1) {
      const key = this.buf.indexOf('"beats"');
      if (key !== -1) {
        const arr = this.buf.indexOf('[', key);
        if (arr !== -1) {
          this.beatsStart = arr + 1;
          this.cursor = arr + 1;
        }
      }
    }

    if (this.beatsStart !== -1) {
      while (this.cursor < this.buf.length) {
        // Пропускаем пробелы/запятые до начала следующего объекта или конца массива.
        while (this.cursor < this.buf.length && /[\s,]/.test(this.buf[this.cursor])) this.cursor++;
        if (this.cursor >= this.buf.length) break;
        if (this.buf[this.cursor] === ']') break; // конец beats
        if (this.buf[this.cursor] !== '{') break; // неожиданный символ — стоп
        const end = matchBrace(this.buf, this.cursor);
        if (end === -1) break; // объект ещё стримится
        try {
          out.beats.push(JSON.parse(this.buf.slice(this.cursor, end)));
        } catch {
          /* пропускаем битый элемент */
        }
        this.cursor = end;
      }
    }

    return out;
  }

  get raw(): string {
    return this.buf;
  }
}

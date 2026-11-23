import { ApiConnectionField } from '../constructor/editors/ApiConnectionField';
import { useStudioConnection, STUDIO_KEY_ROLE } from '../../ai/studioConnection';
import { getConnection } from '../../ai/connection';

// Отдельный текстовый API для студии картинок: кто пишет промпты к картинкам.
// Галочка снята — основное подключение (как раньше).
export function StudioTextConnection() {
  const st = useStudioConnection();
  return (
    <div className="nf-studio-text mt-4 pt-3 border-t border-white/10">
      <label className="flex items-start gap-2 text-sm cursor-pointer">
        <input type="checkbox" className="mt-1 nf-studio-text-on" checked={st.enabled} onChange={(e) => st.set({ enabled: e.target.checked })} />
        <span>
          ✍️ Отдельный текстовый API для студии
          <span className="block text-[11px] text-gray-500">
            Кто пишет промпты к картинкам: воркер сцены, теги NovelAI, «✨ из анкеты», «✨ В теги NovelAI», ассистент ручного режима,
            иллюстрации в тексте. Без галочки — основное подключение. Общее для всех историй, ключ свой, хранится только в этом браузере.
          </span>
        </span>
      </label>
      {st.enabled && (
        <div className="mt-3">
          <button
            className="btn-ghost !px-3 !py-1 text-xs mb-2"
            onClick={() => {
              const g = getConnection();
              st.set({ conn: { provider: g.provider, baseUrl: g.baseUrl, model: st.conn.model } });
            }}
            title="Тот же провайдер и адрес, что у основного, — останется выбрать модель (и ключ, если он другой)"
          >
            Взять адрес из основного
          </button>
          <ApiConnectionField conn={st.conn} keyRole={STUDIO_KEY_ROLE} onChange={(conn) => st.set({ conn })} />
          {!st.conn.model && <p className="text-[11px] text-amber-300 mt-1">Пока модель не выбрана, студия ходит через основное подключение.</p>}
        </div>
      )}
    </div>
  );
}

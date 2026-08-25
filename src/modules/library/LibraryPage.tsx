import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Project } from '../../shared/types';
import { normalizeNarrativeMode } from '../../shared/types';
import type { NarrativeMode } from '../../shared/types';
import { useAppMode, MODE_META } from '../../app/appMode';
import { pushToast } from '../../shared/toast';
import { listProjects, saveProject, deleteProject, duplicateProject, adaptProjectToMode } from '../../storage/db';
import { createEmptyProject } from '../../shared/factory';
import { exportProjectZip, downloadBlob, importProjectZip, countSaves } from '../../storage/zip';
import { AssetImage, Modal } from '../../shared/ui';
import { formatDate } from '../../shared/utils';
import { useT, useLang } from '../../shared/i18n';
import { logEvent } from '../../shared/logStore';

export function LibraryPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');
  // Режим нового проекта не спрашиваем: он равен режиму приложения, в котором мы
  // сейчас находимся. Развилка была на входе, второй раз её задавать незачем.
  const appMode = useAppMode((s) => s.mode) ?? 'vn';
  const [busy, setBusy] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const nav = useNavigate();
  const t = useT();

  async function refresh() {
    setProjects(await listProjects());
  }

  // Библиотека показывает проекты ТОЛЬКО текущего режима: у режимов раздельные
  // конструкторы и пресеты, и проект из чужого режима в этом списке был бы ловушкой —
  // открылся бы не тем редактором.
  const visible = projects.filter((p) => normalizeNarrativeMode(p.mode) === appMode);
  const foreign = projects.length - visible.length;
  useEffect(() => {
    refresh();
  }, []);

  // Адаптация — КОПИЯ проекта в другом режиме. Не переключение флажка: копия уходит
  // в чужую библиотеку, оригинал остаётся здесь нетронутым, у каждого свои сейвы.
  async function adapt(p: Project) {
    const target: NarrativeMode = normalizeNarrativeMode(p.mode) === 'rp' ? 'vn' : 'rp';
    const label = target === 'rp' ? L('классический РП', 'classic RP') : L('визуальную новеллу', 'a visual novel');
    const warn =
      target === 'rp'
        ? L(
            'Сеттинг, лор, лорбук и персонажи переедут. Спрайты, фоны, музыка и CG — нет: в текстовом режиме им негде показаться.',
            'Setting, lore, lorebook and characters will move over. Sprites, backgrounds, music and CG will not: there is nowhere to show them in text mode.'
          )
        : L(
            'Сеттинг, лор, лорбук и персонажи переедут. Спрайты и фоны придётся загрузить заново — в текстовом проекте их не было.',
            'Setting, lore, lorebook and characters will move over. Sprites and backgrounds will need to be uploaded — the text project had none.'
          );
    if (!confirm(`${L('Сделать копию проекта под', 'Make a copy of this project as')} ${label}?\n\n${warn}`))
      return;
    setBusy(p.id);
    try {
      const res = await adaptProjectToMode(p, target);
      await refresh();
      pushToast(
        'success',
        L(
          `Готово: «${res.project.meta.title}» ждёт в режиме «${MODE_META[target].name}». Переключите режим значком в верхней панели.`,
          `Done: "${res.project.meta.title}" is waiting in "${MODE_META[target].nameEn}" mode. Switch modes from the top bar.`
        )
      );
    } catch (e) {
      pushToast('error', L('Не удалось адаптировать: ', 'Adaptation failed: ') + (e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function create() {
    const p = createEmptyProject(title.trim() || 'Без названия');
    // 'vn' не пишем: это дефолт, и поле в записи ни к чему.
    if (appMode === 'rp') p.mode = 'rp';
    await saveProject(p);
    setCreating(false);
    setTitle('');
    nav(`/project/${p.id}`);
  }

  const lang = useLang((s) => s.lang);
  const L = (ru: string, en: string) => (lang === 'en' ? en : ru);
  const [detailsTarget, setDetailsTarget] = useState<Project | null>(null);
  const [shareTarget, setShareTarget] = useState<Project | null>(null);
  const [withProgress, setWithProgress] = useState(true);
  const [saveCount, setSaveCount] = useState<number | null>(null);
  // Копия проекта: своё окно (отдельно от экспорта) — имя, брать ли прогресс.
  const [copyTarget, setCopyTarget] = useState<Project | null>(null);
  const [copyTitle, setCopyTitle] = useState('');
  const [copyProgress, setCopyProgress] = useState(true);
  const [copySaveCount, setCopySaveCount] = useState<number | null>(null);

  // При открытии окна экспорта узнаём, есть ли сохранения (сколько), чтобы подписать
  // варианты и по умолчанию предложить «с прогрессом», если прохождение есть.
  useEffect(() => {
    if (!shareTarget) {
      setSaveCount(null);
      return;
    }
    let alive = true;
    countSaves(shareTarget.id).then((n) => {
      if (!alive) return;
      setSaveCount(n);
      setWithProgress(n > 0);
    });
    return () => {
      alive = false;
    };
  }, [shareTarget]);

  // Открыли окно копии — подставляем имя и смотрим, есть ли что копировать из прогресса.
  useEffect(() => {
    if (!copyTarget) {
      setCopySaveCount(null);
      return;
    }
    setCopyTitle(`${copyTarget.meta.title || 'Проект'} — вторая история`);
    let alive = true;
    countSaves(copyTarget.id).then((n) => {
      if (!alive) return;
      setCopySaveCount(n);
      setCopyProgress(n > 0);
    });
    return () => {
      alive = false;
    };
  }, [copyTarget]);

  async function onImport(file: File) {
    setBusy('Импорт...');
    try {
      const { project, warnings } = await importProjectZip(file);
      await refresh();
      if (warnings.length) {
        alert(`Проект «${project.meta.title}» импортирован, но с замечаниями:\n\n` + warnings.join('\n'));
      } else {
        alert(`Проект «${project.meta.title}» импортирован. Нажмите «Играть», чтобы продолжить.`);
      }
    } catch (e) {
      const err = e as Error;
      // Полную ошибку — в лог (для диагностики), пользователю — читаемый текст.
      logEvent('error', 'import', err.message, err.stack);
      alert('Не удалось импортировать бэкап.\n\n' + err.message);
    } finally {
      setBusy(null);
    }
  }

  async function onShareDownload(p: Project, includeProgress: boolean) {
    setBusy('Экспорт...');
    try {
      const blob = await exportProjectZip(p, { includeProgress });
      const suffix = includeProgress ? '-с-прогрессом' : '';
      downloadBlob(blob, `${p.meta.title || 'project'}${suffix}.zip`);
      setShareTarget(null);
    } finally {
      setBusy(null);
    }
  }

  async function onDelete(p: Project) {
    if (!confirm(`Удалить проект «${p.meta.title}» и все его ассеты?`)) return;
    await deleteProject(p.id);
    await refresh();
  }

  async function onDuplicate(p: Project, title: string, includeProgress: boolean) {
    setBusy(L('Копирование…', 'Copying…'));
    try {
      const res = await duplicateProject(p, title.trim() || undefined, { includeProgress });
      setCopyTarget(null);
      setShareTarget(null);
      await refresh();
      logEvent(
        'info',
        'app',
        `Проект скопирован: «${res.project.meta.title}»` +
          (includeProgress ? `, перенесено сохранений: ${res.savesCopied}` : ', без прогресса') +
          (res.assetsMissing ? `, без файла осталось ассетов: ${res.assetsMissing}` : '')
      );
      const missing = res.assetsMissing
        ? L(
            `\n\nВнимание: ${res.assetsMissing} ассет(ов) не нашлись в хранилище — в оригинале они тоже пустые.`,
            `\n\nNote: ${res.assetsMissing} asset(s) were missing from storage — they are empty in the original too.`
          )
        : '';
      alert(
        L(
          `Готово. «${res.project.meta.title}» — отдельный проект. ` +
            (includeProgress
              ? `Прогресс перенесён (сохранений: ${res.savesCopied}). `
              : 'Прогресс не переносился — копия начнётся с начала. ') +
            'Правки в копии на оригинал не влияют, и наоборот.',
          `Done. "${res.project.meta.title}" is a separate project. ` +
            (includeProgress
              ? `Progress copied (saves: ${res.savesCopied}). `
              : 'Progress was not copied — the copy starts from the beginning. ') +
            'Edits in the copy do not affect the original, and vice versa.'
        ) + missing
      );
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 pt-5 pb-16">
      {/* Hero-панель (импорт дизайна) */}
      <div className="rounded-[22px] p-6 sm:p-7 mb-6 text-center relative bg-white/[0.045] backdrop-blur-xl border border-[rgba(180,150,255,0.18)] shadow-[0_8px_32px_rgba(0,0,0,0.4),inset_0_1px_0_rgba(255,255,255,0.05)]">
        <div className="font-brand font-extrabold text-[20px] sm:text-[22px] tracking-[0.5px] text-[#f7f4ff] [text-shadow:0_0_18px_rgba(170,120,255,0.35)]">
          {t('library.title')}
        </div>
        {/* Подпись под заголовком зависит от режима: «ваши визуальные новеллы» в
            текстовом РП было бы прямой неправдой. */}
        <div className="text-[12.5px] text-[#a8a4bd] mt-2 leading-relaxed">
          {appMode === 'rp'
            ? L(
                'Ваши текстовые ролеплеи. Всё хранится локально на устройстве.',
                'Your text roleplays. Everything is stored locally on your device.'
              )
            : t('library.subtitle')}
        </div>
        <div className="flex gap-3 mt-5 max-w-md mx-auto">
          <button
            onClick={() => setCreating(true)}
            className="flex-1 py-3 rounded-[14px] font-brand font-bold text-[13px] tracking-[0.3px] text-[#1c1526] cursor-pointer border-none bg-[linear-gradient(155deg,#d3b8ff,#b18cff)] shadow-[0_0_22px_rgba(170,120,255,0.5),inset_0_1px_0_rgba(255,255,255,0.4)] hover:brightness-110 transition"
          >
            {t('library.new')}
          </button>
          <button
            onClick={() => fileRef.current?.click()}
            className="flex-1 py-3 rounded-[14px] font-brand font-bold text-[13px] tracking-[0.3px] text-[#d3b8ff] cursor-pointer bg-white/[0.04] border border-[rgba(180,150,255,0.35)] hover:bg-[rgba(160,110,255,0.14)] transition"
          >
            {t('library.import')}
          </button>
        </div>
      </div>

      {busy && <div className="mb-4 text-sm text-[#d3b8ff] text-center">{busy}</div>}

      <input
        ref={fileRef}
        type="file"
        // Широкий accept — некоторые файловые пикеры Android прячут .zip, если
        // фильтровать только по расширению (zip часто идёт как octet-stream).
        accept=".zip,application/zip,application/x-zip-compressed,application/octet-stream"
        hidden
        onChange={(e) => {
          const input = e.target;
          const f = input.files?.[0];
          // ВАЖНО: не сбрасываем input, пока идёт чтение — на Android сброс value
          // может освободить ссылку на файл прямо во время чтения (NotFoundError).
          if (f) onImport(f).finally(() => (input.value = ''));
          else input.value = '';
        }}
      />

      {visible.length === 0 ? (
        <div className="rounded-[20px] text-center py-16 px-6 text-[#7a7690] bg-white/[0.03] border border-[rgba(180,150,255,0.12)]">
          <div className="mb-1">{t('library.empty')}</div>
          <div className="text-xs">
            {L(
              `Вы в режиме «${MODE_META[appMode].name}».`,
              `You are in "${MODE_META[appMode].nameEn}" mode.`
            )}
            {foreign > 0 &&
              ' ' +
                L(
                  `В другом режиме лежит проектов: ${foreign}. Переключите режим значком в верхней панели или адаптируйте проект копией.`,
                  `The other mode has ${foreign} project(s). Switch modes from the top bar, or adapt a project as a copy.`
                )}
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
          {visible.map((p) => {
            const coverKey = p.assets.find((a) => a.id === p.meta.coverAssetId)?.blobKey;
            return (
              <div
                key={p.id}
                className="rounded-[20px] overflow-hidden bg-white/[0.04] backdrop-blur-xl border border-[rgba(180,150,255,0.16)] shadow-[0_6px_24px_rgba(0,0,0,0.35),inset_0_1px_0_rgba(255,255,255,0.04)]"
              >
                <div className="pt-3.5 text-center">
                  <div className="font-brand font-bold text-[13px] tracking-[0.6px] text-[#eeeaf8] px-4 truncate">
                    {p.meta.title}
                  </div>
                  <div className="text-[10.5px] text-[#7a7690] mt-1">
                    {t('library.lastSave')} · {formatDate(p.updatedAt)}
                  </div>
                </div>

                <div
                  className="mx-4 my-3 h-[150px] rounded-[14px] overflow-hidden cursor-pointer border border-[rgba(180,150,255,0.1)] bg-white/[0.03] flex items-center justify-center"
                  style={
                    coverKey
                      ? undefined
                      : {
                          backgroundImage:
                            'repeating-linear-gradient(135deg, rgba(180,150,255,0.05) 0px, rgba(180,150,255,0.05) 2px, transparent 2px, transparent 12px)',
                        }
                  }
                  onClick={() => nav(`/project/${p.id}`)}
                >
                  {coverKey ? (
                    <AssetImage blobKey={coverKey} className="w-full h-full object-cover" />
                  ) : (
                    <span className="text-[10.5px] tracking-[0.5px] text-[#5c5870]">
                      {t('library.charactersShort')}: {p.characters.length} · {p.assets.length}
                    </span>
                  )}
                </div>

                {/* По две иконки по бокам, Play — по центру */}
                <div className="flex items-center justify-center gap-3.5 pb-5 pt-1">
                  <CardIconBtn title={t('library.editor')} onClick={() => nav(`/project/${p.id}`)} icon="edit" />
                  <CardIconBtn title={t('library.export')} onClick={() => setShareTarget(p)} icon="export" />
                  <CardIconBtn
                    title={L('Копия проекта — отдельная история', 'Copy project — a separate story')}
                    onClick={() => setCopyTarget(p)}
                    icon="copy"
                  />
                  <CardIconBtn
                    title={
                      normalizeNarrativeMode(p.mode) === 'rp'
                        ? L('Адаптировать в визуальную новеллу (копией)', 'Adapt as a visual novel (a copy)')
                        : L('Адаптировать в классический РП (копией)', 'Adapt as classic RP (a copy)')
                    }
                    onClick={() => adapt(p)}
                    icon="adapt"
                  />
                  <CardIconBtn title={t('library.play')} onClick={() => nav(`/play/${p.id}`)} icon="play" primary />
                  <CardIconBtn
                    title={L('Ассеты и целостность', 'Assets & integrity')}
                    onClick={() => setDetailsTarget(p)}
                    icon="info"
                  />
                  <CardIconBtn title={t('library.delete')} onClick={() => onDelete(p)} icon="trash" />
                </div>
              </div>
            );
          })}
        </div>
      )}

      <Modal open={creating} onClose={() => setCreating(false)} title={t('library.newTitle')}>
        <input
          className="input mb-4"
          placeholder={t('library.namePlaceholder')}
          value={title}
          autoFocus
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && create()}
        />

        <p className="text-xs text-gray-500 mb-4">
          {L(
            `Проект создаётся в режиме «${MODE_META[appMode].name}» — том, в котором вы сейчас. Другой режим — своя библиотека, переключается значком в верхней панели.`,
            `The project is created in "${MODE_META[appMode].nameEn}" mode — the one you are in. The other mode has its own library; switch it from the top bar.`
          )}
        </p>

        <div className="flex justify-end gap-2">
          <button className="btn-ghost" onClick={() => setCreating(false)}>
            {t('library.cancel')}
          </button>
          <button className="btn-primary" onClick={create}>
            {t('library.create')}
          </button>
        </div>
      </Modal>

      {/* Экспорт / перенос проекта: полный (с прогрессом) или чистый (без памяти) */}
      <Modal open={!!shareTarget} onClose={() => setShareTarget(null)} title="Экспорт / перенос проекта">
        {shareTarget && (
          <>
            <div className="aspect-video rounded-lg overflow-hidden mb-3 bg-panel2">
              <AssetImage
                blobKey={shareTarget.assets.find((a) => a.id === shareTarget.meta.coverAssetId)?.blobKey}
                className="w-full h-full object-cover"
              />
            </div>
            <h3 className="font-semibold mb-1">{shareTarget.meta.title}</h3>
            {shareTarget.lore.worldDescription && (
              <p className="text-xs text-gray-400 mb-3 line-clamp-3">
                {shareTarget.lore.worldDescription.slice(0, 200)}
              </p>
            )}
            <p className="text-xs text-gray-400 mb-3">
              Скачается один <b>.zip</b>. На другом устройстве: <b>Библиотека → Импорт .zip</b>.
            </p>
            {/* Выбор: полный перенос (с прогрессом) или чистый проект (без памяти) */}
            <div className="space-y-2 mb-4">
              <label
                className={`flex gap-3 items-start rounded-lg border p-3 cursor-pointer ${
                  withProgress ? 'border-accent2 bg-accent2/10' : 'border-white/10 bg-panel2'
                }`}
              >
                <input
                  type="radio"
                  className="mt-1"
                  checked={withProgress}
                  onChange={() => setWithProgress(true)}
                />
                <div>
                  <div className="text-sm font-medium">
                    📦 Полный перенос (с прогрессом) — на другое устройство / бэкап
                  </div>
                  <div className="text-xs text-gray-400">
                    Настройки проекта + ассеты + всё прохождение: история, статусы, отношения,
                    память и все данные Game Master (персонажи, события, отношения, календарь,
                    адженда).
                    {saveCount !== null && (
                      <> Сохранений внутри: {saveCount === 0 ? 'нет — прогресса ещё нет' : saveCount}.</>
                    )}
                  </div>
                </div>
              </label>
              <label
                className={`flex gap-3 items-start rounded-lg border p-3 cursor-pointer ${
                  !withProgress ? 'border-accent2 bg-accent2/10' : 'border-white/10 bg-panel2'
                }`}
              >
                <input
                  type="radio"
                  className="mt-1"
                  checked={!withProgress}
                  onChange={() => setWithProgress(false)}
                />
                <div>
                  <div className="text-sm font-medium">✨ Чистый проект (без памяти)</div>
                  <div className="text-xs text-gray-400">
                    Настройки проекта + ассеты, но без прохождения — тот, кто импортирует,
                    начнёт с начала. Для новых игроков и шаринга.
                  </div>
                </div>
              </label>
            </div>

            <p className="text-[11px] text-gray-500 mb-3">
              🔑 API-ключи в архив не попадают (безопасность) — на новом устройстве введите их
              заново в «Подключение к ИИ».
            </p>

            <div className="bg-amber-500/10 border border-amber-400/30 rounded-lg p-3 text-xs text-amber-200 mb-4">
              ⚠️ Вы делитесь файлами, которые могут быть защищены авторским правом или условиями
              стороннего сервиса (сток, AI-генератор и т.д.) — убедитесь, что имеете право их
              распространять. Ответственность за содержимое — на вас.
            </div>
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <button
                className="btn-ghost"
                onClick={() => {
                  const p = shareTarget;
                  setShareTarget(null);
                  setCopyTarget(p);
                }}
                title={L('Независимая копия на этом устройстве', 'An independent copy on this device')}
              >
                ⧉ {L('Сделать копию', 'Make a copy')}
              </button>
              <div className="flex gap-2">
                <button className="btn-ghost" onClick={() => setShareTarget(null)}>
                  {L('Отмена', 'Cancel')}
                </button>
                <button className="btn-primary" onClick={() => onShareDownload(shareTarget, withProgress)}>
                  {L('Скачать .zip', 'Download .zip')}
                </button>
              </div>
            </div>
          </>
        )}
      </Modal>

      {/* Копия проекта — независимая вторая история на тех же данных */}
      <Modal
        open={!!copyTarget}
        onClose={() => setCopyTarget(null)}
        title={L('Копия проекта', 'Copy project')}
      >
        {copyTarget && (
          <>
            <p className="text-xs text-gray-400 mb-3">
              {L(
                'Получится отдельный проект: те же персонажи, ассеты и настройки, но своя жизнь. ' +
                  'Что меняете в копии — в оригинале не меняется, и наоборот.',
                'You get a separate project: same characters, assets and settings, but its own life. ' +
                  'What you change in the copy does not change the original, and vice versa.'
              )}
            </p>

            <label className="block text-xs text-gray-400 mb-1">{L('Название копии', 'Copy name')}</label>
            <input
              className="input mb-4"
              value={copyTitle}
              autoFocus
              onChange={(e) => setCopyTitle(e.target.value)}
              placeholder={`${copyTarget.meta.title} (копия)`}
            />

            <div className="space-y-2 mb-4">
              <label
                className={`flex gap-3 items-start rounded-lg border p-3 cursor-pointer ${
                  copyProgress ? 'border-accent2 bg-accent2/10' : 'border-white/10 bg-panel2'
                }`}
              >
                <input
                  type="radio"
                  className="mt-1"
                  checked={copyProgress}
                  onChange={() => setCopyProgress(true)}
                />
                <div>
                  <div className="text-sm font-medium">
                    ⑂ {L('Продолжить с того же места', 'Continue from the same point')}
                  </div>
                  <div className="text-xs text-gray-400">
                    {L(
                      'Переносится и прохождение: история, статусы, отношения, память, Game Master, ' +
                        'телефон, инвентарь. Дальше две истории расходятся.',
                      'The playthrough comes along: story, statuses, relationships, memory, Game Master, ' +
                        'phone, inventory. From there the two stories diverge.'
                    )}
                    {copySaveCount !== null && (
                      <>
                        {' '}
                        {copySaveCount === 0
                          ? L('Сохранений пока нет — копия всё равно начнётся с начала.', 'No saves yet — the copy will start from the beginning anyway.')
                          : L(`Сохранений: ${copySaveCount}.`, `Saves: ${copySaveCount}.`)}
                      </>
                    )}
                  </div>
                </div>
              </label>
              <label
                className={`flex gap-3 items-start rounded-lg border p-3 cursor-pointer ${
                  !copyProgress ? 'border-accent2 bg-accent2/10' : 'border-white/10 bg-panel2'
                }`}
              >
                <input
                  type="radio"
                  className="mt-1"
                  checked={!copyProgress}
                  onChange={() => setCopyProgress(false)}
                />
                <div>
                  <div className="text-sm font-medium">✨ {L('Начать заново', 'Start over')}</div>
                  <div className="text-xs text-gray-400">
                    {L(
                      'Только проект: мир, персонажи, ассеты, настройки. Прохождение не переносится — ' +
                        'копия начнётся с первой сцены.',
                      'The project only: world, characters, assets, settings. The playthrough is not copied — ' +
                        'the copy starts from the first scene.'
                    )}
                  </div>
                </div>
              </label>
            </div>

            <p className="text-[11px] text-gray-500 mb-4">
              🔑 {L(
                'API-ключи хранятся отдельно от проекта — вводить заново не нужно.',
                'API keys are stored outside the project — no need to re-enter them.'
              )}
            </p>

            <div className="flex justify-end gap-2">
              <button className="btn-ghost" onClick={() => setCopyTarget(null)}>
                {L('Отмена', 'Cancel')}
              </button>
              <button
                className="btn-primary"
                disabled={!!busy}
                onClick={() => onDuplicate(copyTarget, copyTitle, copyProgress)}
              >
                ⧉ {L('Создать копию', 'Create copy')}
              </button>
            </div>
          </>
        )}
      </Modal>

      {/* Ассеты и целостность проекта */}
      <Modal
        open={!!detailsTarget}
        onClose={() => setDetailsTarget(null)}
        title={L('Ассеты и целостность', 'Assets & integrity')}
      >
        {detailsTarget && (
          <ProjectDetails project={detailsTarget} L={L} />
        )}
      </Modal>
    </div>
  );
}

// Разбивка ассетов по типам + базовая проверка целостности проекта.
function ProjectDetails({ project, L }: { project: Project; L: (ru: string, en: string) => string }) {
  const rows: { type: string; label: string; emoji: string }[] = [
    { type: 'background', label: L('Фоны', 'Backgrounds'), emoji: '🖼' },
    { type: 'sprite', label: L('Спрайты', 'Sprites'), emoji: '🧍' },
    { type: 'cg', label: L('CG-сцены', 'CG scenes'), emoji: '🎞' },
    { type: 'music', label: L('Музыка', 'Music'), emoji: '🎵' },
    { type: 'sfx', label: L('Звуки', 'SFX'), emoji: '🔊' },
    { type: 'icon', label: L('Иконки', 'Icons'), emoji: '⭐' },
  ];
  const count = (ty: string) => project.assets.filter((a) => a.type === ty).length;
  const known = new Set(rows.map((r) => r.type));
  const other = project.assets.filter((a) => !known.has(a.type)).length;
  const charsWithSprite = project.characters.filter((c) => Object.keys(c.sprites).length > 0).length;
  const charsNoSprite = project.characters.length - charsWithSprite;

  // В текстовом РП спрайтов и фонов нет по определению — жаловаться на их
  // отсутствие значило бы советовать починить то, что не сломано.
  const rp = normalizeNarrativeMode(project.mode) === 'rp';
  const issues: string[] = [];
  if (!rp && project.assets.length === 0)
    issues.push(L('В проекте нет ассетов.', 'No assets in the project.'));
  if (project.characters.length === 0) issues.push(L('Нет персонажей.', 'No characters.'));
  if (!rp && charsNoSprite > 0)
    issues.push(
      L(
        `Персонажей без спрайтов: ${charsNoSprite} (играются как имя + текст).`,
        `Characters without sprites: ${charsNoSprite} (render as name + text).`
      )
    );
  if (!project.meta.coverAssetId) issues.push(L('Не задана обложка.', 'No cover image set.'));
  const hasProtagonist = project.characters.some((c) => c.role === 'protagonist');
  if (project.characters.length > 0 && !hasProtagonist)
    issues.push(L('Нет персонажа-протагониста.', 'No protagonist character.'));

  const Stat = ({ label, value }: { label: string; value: number }) => (
    <div className="flex items-center justify-between rounded-lg bg-panel2 px-3 py-1.5">
      <span className="text-sm text-gray-300">{label}</span>
      <span className="text-sm font-semibold tabular-nums">{value}</span>
    </div>
  );

  return (
    <div className="space-y-3">
      <div>
        <h3 className="font-semibold mb-1 truncate">{project.meta.title}</h3>
        <p className="text-xs text-gray-500">
          {L('Режим', 'Mode')}:{' '}
          {normalizeNarrativeMode(project.mode) === 'rp'
            ? L('💬 классический РП', '💬 classic RP')
            : L('🎭 визуальная новелла', '🎭 visual novel')}
          {' · '}
          {L('всего ассетов', 'total assets')}: {project.assets.length}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-2">
        {rows.map((r) => (
          <Stat key={r.type} label={`${r.emoji} ${r.label}`} value={count(r.type)} />
        ))}
        {other > 0 && <Stat label={L('❔ Прочее', '❔ Other')} value={other} />}
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Stat label={`👥 ${L('Персонажи', 'Characters')}`} value={project.characters.length} />
        <Stat label={`📊 ${L('Статы', 'Stats')}`} value={project.stats.length} />
        <Stat label={`📖 ${L('Лорбук', 'Lorebook')}`} value={project.lorebook.length} />
        <Stat label={`🎭 ${L('Со спрайтами', 'With sprites')}`} value={charsWithSprite} />
      </div>

      {issues.length === 0 ? (
        <div className="rounded-lg bg-emerald-500/10 border border-emerald-400/30 p-3 text-sm text-emerald-300">
          ✓ {L('Проект выглядит целостным.', 'Project looks complete.')}
        </div>
      ) : (
        <div className="rounded-lg bg-amber-500/10 border border-amber-400/30 p-3 text-xs text-amber-200 space-y-1">
          <div className="font-semibold">{L('На что обратить внимание:', 'Things to check:')}</div>
          {issues.map((s, i) => (
            <div key={i}>• {s}</div>
          ))}
        </div>
      )}
    </div>
  );
}

// Иконки действий карточки проекта (импорт дизайна): редактор · экспорт · играть
// (большая неоновая) · удалить. Подсказка — через title на выбранном языке.
const CARD_ICONS: Record<string, JSX.Element> = {
  // «Адаптировать в другой режим» — две стрелки навстречу: перенос, а не копия
  // в тот же список.
  adapt: (
    <svg width="100%" height="100%" viewBox="0 0 20 20" fill="none">
      <path
        d="M3 7h11l-2.5-2.5M17 13H6l2.5 2.5"
        stroke="#c8b8ee"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ),
  edit: (
    <svg width="100%" height="100%" viewBox="0 0 20 20" fill="none">
      <path
        d="M12.6 4.3 15.7 7.4M4 16l.9-3.4 8-8a1.4 1.4 0 0 1 2 0l1.4 1.4a1.4 1.4 0 0 1 0 2l-8 8L4 16Z"
        stroke="#c8b8ee"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  ),
  export: (
    <svg width="100%" height="100%" viewBox="0 0 20 20" fill="none">
      <path d="M8 12 15 5M9 5h6v6" stroke="#c8b8ee" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <path
        d="M13 11v4a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h4"
        stroke="#c8b8ee"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ),
  copy: (
    <svg width="100%" height="100%" viewBox="0 0 20 20" fill="none">
      <rect x="7" y="7" width="9.5" height="9.5" rx="2" stroke="#c8b8ee" strokeWidth="1.5" />
      <path
        d="M13 4.5H5.5a2 2 0 0 0-2 2V14"
        stroke="#c8b8ee"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  ),
  play: (
    <svg width="100%" height="100%" viewBox="0 0 20 20" fill="none">
      <path d="M6.5 4.5v11l9-5.5-9-5.5Z" fill="#1c1526" />
    </svg>
  ),
  info: (
    <svg width="100%" height="100%" viewBox="0 0 20 20" fill="none">
      <path
        d="M6 2.5h5.5L15 6v11.5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V3.5a1 1 0 0 1 1-1Z"
        stroke="#c8b8ee"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path d="M8 6.7h2M8 9.7h4M8 12.7h4" stroke="#c8b8ee" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  ),
  trash: (
    <svg width="100%" height="100%" viewBox="0 0 20 20" fill="none">
      <path
        d="M4.5 6h11M8 6V4.5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1V6M8.5 9.5v5M11.5 9.5v5M5.5 6l.6 9a1 1 0 0 0 1 1h5.8a1 1 0 0 0 1-1l.6-9"
        stroke="#e29b9b"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ),
};

function CardIconBtn({
  title,
  onClick,
  icon,
  primary,
}: {
  title: string;
  onClick: () => void;
  icon: 'edit' | 'export' | 'copy' | 'adapt' | 'play' | 'trash' | 'info';
  primary?: boolean;
}) {
  const size = primary ? 46 : 34;
  const iconSize = Math.round(size * 0.5);
  return (
    <button
      title={title}
      aria-label={title}
      onClick={onClick}
      className={`flex items-center justify-center shrink-0 cursor-pointer transition hover:brightness-125 ${
        primary ? 'rounded-[23px]' : 'rounded-[11px]'
      }`}
      style={
        primary
          ? {
              width: size,
              height: size,
              background: 'linear-gradient(155deg,#d3b8ff,#b18cff)',
              boxShadow: '0 0 18px rgba(177,140,255,0.55), inset 0 1px 0 rgba(255,255,255,0.4)',
            }
          : { width: size, height: size, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(180,150,255,0.22)' }
      }
    >
      <span style={{ width: iconSize, height: iconSize, display: 'flex' }}>{CARD_ICONS[icon]}</span>
    </button>
  );
}

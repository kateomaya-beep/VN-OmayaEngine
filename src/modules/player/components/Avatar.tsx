import type { Project, RuntimeState } from '../../../shared/types';
import { useAssetUrl } from '../../../shared/ui';

// АВАТАРКИ — общий резолв «кто → какая картинка» для ленты переписки.
//
// Порядок источников один на всех и намеренно не настраивается:
//   1. своя аватарка (Character.avatarAssetId — залита в конструкторе);
//   2. neutral-спрайт персонажа — лучше, чем ничего, хотя он в полный рост;
//   3. буква имени на цветном кружке — детерминированный цвет от имени, чтобы
//      один и тот же человек всегда был одного цвета.
// У героя перед этим всем стоит аватарка ПРОХОЖДЕНИЯ: одну историю можно вести
// разными персонажами, и лицо игрока принадлежит прохождению, а не проекту.

export function blobKeyOfAsset(project: Project, assetId?: string): string | undefined {
  if (!assetId) return undefined;
  return project.assets.find((a) => a.id === assetId)?.blobKey;
}

export function characterAvatarKey(project: Project, name: string): string | undefined {
  const c = project.characters.find((x) => x.name.toLowerCase() === name.trim().toLowerCase());
  if (!c) return undefined;
  return blobKeyOfAsset(project, c.avatarAssetId) ?? blobKeyOfAsset(project, c.sprites?.neutral);
}

export function heroAvatarKey(project: Project, state: RuntimeState): string | undefined {
  const own = blobKeyOfAsset(project, state.protagonistAvatarAssetId);
  if (own) return own;
  const card = project.characters.find((c) => c.role === 'protagonist');
  return blobKeyOfAsset(project, card?.avatarAssetId) ?? blobKeyOfAsset(project, card?.sprites?.neutral);
}

// Цвет кружка-заглушки. Хэш по имени, а не случайность: иначе один и тот же
// персонаж перекрашивался бы при каждой перерисовке.
function hueOf(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return h;
}

export function Avatar({
  name,
  blobKey,
  size = 34,
  title,
  onClick,
}: {
  name: string;
  blobKey?: string;
  size?: number;
  title?: string;
  onClick?: () => void;
}) {
  const url = useAssetUrl(blobKey);
  const letter = (name.trim()[0] || '?').toUpperCase();
  const style = { width: size, height: size, fontSize: Math.round(size * 0.42) };
  const common =
    'shrink-0 rounded-full overflow-hidden flex items-center justify-center font-semibold select-none border border-white/15';
  const clickable = onClick ? ' cursor-pointer hover:border-[var(--pl-accent)]' : '';
  const inner = url ? (
    <img src={url} alt={name} className="w-full h-full object-cover" />
  ) : (
    <span style={{ color: `hsl(${hueOf(name)} 70% 85%)` }}>{letter}</span>
  );
  return (
    <div
      className={common + clickable}
      style={{ ...style, background: url ? 'transparent' : `hsl(${hueOf(name)} 40% 22%)` }}
      title={title || name}
      onClick={onClick}
    >
      {inner}
    </div>
  );
}

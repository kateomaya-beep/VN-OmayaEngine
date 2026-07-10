import { useEffect, useState, type ReactNode } from 'react';
import { getAssetUrl } from '../storage/assetUrls';

// Renders an asset blob by its blobKey (image types).
export function AssetImage({
  blobKey,
  className,
  alt = '',
}: {
  blobKey?: string | null;
  className?: string;
  alt?: string;
}) {
  const url = useAssetUrl(blobKey);
  if (!url) {
    return (
      <div className={`bg-panel2 flex items-center justify-center text-gray-600 text-xs ${className}`}>
        нет
      </div>
    );
  }
  return <img src={url} className={className} alt={alt} />;
}

export function useAssetUrl(blobKey?: string | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    if (!blobKey) {
      setUrl(null);
      return;
    }
    getAssetUrl(blobKey).then((u) => alive && setUrl(u));
    return () => {
      alive = false;
    };
  }, [blobKey]);
  return url;
}

export function Modal({
  open,
  onClose,
  title,
  children,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  wide?: boolean;
}) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className={`card w-full ${wide ? 'max-w-3xl' : 'max-w-lg'} max-h-[85vh] overflow-y-auto scrollbar-thin`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-semibold text-lg">{title}</h3>
          <button className="btn-ghost !px-2 !py-1" onClick={onClose}>
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <div className="mb-3">
      <label className="label">{label}</label>
      {children}
      {hint && <p className="text-xs text-gray-500 mt-1">{hint}</p>}
    </div>
  );
}

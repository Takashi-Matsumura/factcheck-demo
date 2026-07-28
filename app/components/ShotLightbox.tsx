"use client";

// 撮影サイズが実行時まで不定のため、next/image の固定寸法最適化ではなく
// 素の <img> をそのまま使う（サムネイル / 拡大表示とも）。
/* eslint-disable @next/next/no-img-element */

import { useState } from "react";

export function ShotLightbox({ src, alt }: { src: string; alt: string }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="block w-full overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-700"
      >
        <img
          src={src}
          alt={alt}
          className="max-h-64 w-full object-contain bg-zinc-50 dark:bg-zinc-900"
        />
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6"
          onClick={() => setOpen(false)}
        >
          <img
            src={src}
            alt={alt}
            className="max-h-[90vh] max-w-[90vw] rounded-lg object-contain shadow-2xl"
          />
        </div>
      )}
    </>
  );
}

import { PhotonImage, SamplingFilter, crop, resize } from '@cf-wasm/photon/workerd'

export const THUMBNAIL_SIZE = 500
export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024

// Resizes once at upload time (cover crop to a square, then scale to THUMBNAIL_SIZE).
// This is what replaces Supabase's per-request Image Transformation billing:
// there is no resize-on-request path anywhere in this app.
// Never upscales: if the source is already <= THUMBNAIL_SIZE on its shorter edge,
// only the square crop is applied — upscaling a small source just wastes bytes
// (a blown-up 500x500 webp of a 120x120 source is bigger than the source with zero
// added detail).
export function makeThumbnail(bytes: Uint8Array): Uint8Array {
  const input = PhotonImage.new_from_byteslice(bytes)
  try {
    const width = input.get_width()
    const height = input.get_height()
    const side = Math.min(width, height)
    const x1 = Math.floor((width - side) / 2)
    const y1 = Math.floor((height - side) / 2)
    const squared = crop(input, x1, y1, x1 + side, y1 + side)
    try {
      if (side <= THUMBNAIL_SIZE) {
        return squared.get_bytes_webp()
      }
      const thumb = resize(squared, THUMBNAIL_SIZE, THUMBNAIL_SIZE, SamplingFilter.Lanczos3)
      try {
        return thumb.get_bytes_webp()
      } finally {
        thumb.free()
      }
    } finally {
      squared.free()
    }
  } finally {
    input.free()
  }
}

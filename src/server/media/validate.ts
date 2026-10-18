/**
 * Upload validation helpers shared by the web upload form and the API.
 *
 * DEXTube documents exactly what it accepts rather than pretending to handle
 * "any video": the container must be one FFmpeg can demux, the codec must be
 * one of the browsers' playback set (or be transcoded), and the size/duration
 * ceilings are explicit configuration values.
 */

export interface AcceptedFormat {
  mime: string;
  extensions: string[];
  label: string;
  /** True when browsers play it without any transcoding. */
  browserNative: boolean;
}

/**
 * Containers DEXTube accepts for upload.
 *
 * Anything that is not browser-native is transcoded to H.264/AAC MP4 during
 * processing, so playback works everywhere.
 */
export const ACCEPTED_FORMATS: AcceptedFormat[] = [
  { mime: "video/mp4", extensions: ["mp4", "m4v"], label: "MP4 (H.264)", browserNative: true },
  { mime: "video/webm", extensions: ["webm"], label: "WebM (VP8/VP9/AV1)", browserNative: true },
  { mime: "video/quicktime", extensions: ["mov"], label: "QuickTime MOV", browserNative: false },
  { mime: "video/x-matroska", extensions: ["mkv"], label: "Matroska MKV", browserNative: false },
  { mime: "video/ogg", extensions: ["ogv", "ogg"], label: "Ogg Theora (rarely supported)", browserNative: false },
  { mime: "audio/mpeg", extensions: ["mp3"], label: "MP3 audio", browserNative: true },
  { mime: "audio/mp4", extensions: ["m4a"], label: "M4A audio", browserNative: true },
  { mime: "audio/wav", extensions: ["wav"], label: "WAV audio", browserNative: false },
];

const EXT_TO_FORMAT = new Map<string, AcceptedFormat>();
for (const format of ACCEPTED_FORMATS) {
  for (const ext of format.extensions) EXT_TO_FORMAT.set(ext, format);
}

export function fileExtension(name: string): string {
  const match = /\.([A-Za-z0-9]{1,5})$/.exec(name.trim());
  return match ? match[1]!.toLowerCase() : "";
}

export function guessMimeFromName(name: string): string | undefined {
  return EXT_TO_FORMAT.get(fileExtension(name))?.mime;
}

export function isAcceptedUpload(name: string, mimeType: string): { ok: boolean; reason?: string; format?: AcceptedFormat } {
  const ext = fileExtension(name);
  const byExtension = EXT_TO_FORMAT.get(ext);

  if (!byExtension) {
    return {
      ok: false,
      reason: `Unsupported file extension ".${ext || "?"}". Accepted: ${[...EXT_TO_FORMAT.keys()].join(", ")}.`,
    };
  }

  const mime = (mimeType || "").toLowerCase();
  const mimeOk =
    mime === "" ||
    mime === byExtension.mime ||
    byExtension.extensions.includes(fileExtension(name)) ||
    mime === "application/octet-stream";
  if (!mimeOk && !mime.startsWith("video/") && !mime.startsWith("audio/")) {
    return { ok: false, reason: `The file type ${mime} does not match its extension (.${ext}).` };
  }

  return { ok: true, format: byExtension };
}

/** Human-readable summary shown in the upload dialog. */
export function acceptedFormatsSummary(): string {
  return [...EXT_TO_FORMAT.keys()].map((e) => `.${e}`).join(", ");
}

// MP4/MOV ("ISO Base Media File Format" family) files start with an `ftyp`
// box: 4 bytes of box size, then the literal ASCII bytes "ftyp", then a
// 4-byte "major brand" (e.g. "isom", "mp42", "qt  " for QuickTime/.mov).
// Sniffing this from the first 12 bytes is far more reliable than trusting
// `File.type`, which browsers sometimes report as empty or generic for
// video files depending on OS/extension.
const FTYP_ASCII = [0x66, 0x74, 0x79, 0x70]; // "ftyp"

export type DetectedContainerFormat = "iso-bmff" | "unknown";

export const detectContainerFormat = async (file: File): Promise<DetectedContainerFormat> => {
  const header = await file.slice(0, 12).arrayBuffer();
  const bytes = new Uint8Array(header);
  if (bytes.length < 8) return "unknown";

  const isFtypAtOffset4 = FTYP_ASCII.every((byte, index) => bytes[4 + index] === byte);
  return isFtypAtOffset4 ? "iso-bmff" : "unknown";
};

// MediaRecorder writes a WebM while it records and never goes back to its header:
// the file has no duration, so players can't show its length or seek well in it.
// This adds the duration to the header's Segment Info, from the first bytes of the
// file only (the header is in MediaRecorder's first chunk); the rest is unchanged.
// Plain ES module, no dependencies: used by the extension, tested in Node.

const ID = {
  EBML: 0x1a45dfa3,
  Segment: 0x18538067,
  Info: 0x1549a966,
  TimecodeScale: 0x2ad7b1,
  Duration: 0x4489,
  Cluster: 0x1f43b675,
  SeekHead: 0x114d9b74,
};

// An element ID: its first byte says how many bytes it has (the marker bit stays in).
function readId(buf, pos) {
  const first = buf[pos];
  let length = 1;
  for (let mask = 0x80; length <= 4 && !(first & mask); mask >>= 1) length++;
  if (length > 4 || pos + length > buf.length) return null;
  let id = 0;
  for (let i = 0; i < length; i++) id = id * 256 + buf[pos + i];
  return { id, length };
}

// An element size (a variable-length integer, the marker bit removed); all ones means unknown.
function readSize(buf, pos) {
  const first = buf[pos];
  let length = 1;
  let mask = 0x80;
  for (; length <= 8 && !(first & mask); mask >>= 1) length++;
  if (length > 8 || pos + length > buf.length) return null;
  let value = first & (mask - 1);
  let allOnes = value === mask - 1;
  for (let i = 1; i < length; i++) {
    value = value * 256 + buf[pos + i];
    if (buf[pos + i] !== 0xff) allOnes = false;
  }
  return { value, length, unknown: allOnes };
}

// A size written in 8 bytes, so any size fits.
function size8(value) {
  const out = new Uint8Array(8);
  out[0] = 0x01;
  for (let i = 7, v = value; i >= 1; i--, v = Math.floor(v / 256)) out[i] = v % 256;
  return out;
}

const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

/**
 * The first bytes of a WebM with its duration set: `{ head, end }`, where `head`
 * replaces the file's bytes up to `end` (the end of its Segment Info). Null when
 * they don't hold the whole Info (or it isn't a WebM): then keep the file as it is.
 * @param {Uint8Array} buf the file's first bytes
 * @param {number} durationMs
 */
export function setWebmDuration(buf, durationMs) {
  let pos = 0;
  const ebml = readId(buf, pos);
  if (!ebml || ebml.id !== ID.EBML) return null;
  pos += ebml.length;
  const ebmlSize = readSize(buf, pos);
  if (!ebmlSize) return null;
  pos += ebmlSize.length + ebmlSize.value;

  const segment = readId(buf, pos);
  if (!segment || segment.id !== ID.Segment) return null;
  const segmentIdAt = pos;
  pos += segment.length;
  const segmentSize = readSize(buf, pos);
  if (!segmentSize) return null;
  const segmentSizeAt = pos;
  pos += segmentSize.length;
  const segmentData = pos;

  // The Info is among the Segment's first children. A SeekHead holds the positions of
  // what follows, which a bigger Info would move: such a file (not MediaRecorder's) is left as it is.
  while (pos < buf.length) {
    const child = readId(buf, pos);
    if (!child || child.id === ID.Cluster || child.id === ID.SeekHead) return null;
    const size = readSize(buf, pos + child.length);
    if (!size || size.unknown) return null;
    const dataAt = pos + child.length + size.length;
    const end = dataAt + size.value;
    if (child.id !== ID.Info) {
      pos = end;
      continue;
    }
    if (end > buf.length) return null;

    // Its children, but Duration (set anew); TimecodeScale says Duration's unit (default 1 ms).
    let scale = 1_000_000;
    const kept = [];
    for (let p = dataAt; p < end; ) {
      const el = readId(buf, p);
      const elSize = el && readSize(buf, p + el.length);
      if (!el || !elSize) return null;
      const elEnd = p + el.length + elSize.length + elSize.value;
      if (el.id === ID.TimecodeScale) {
        scale = 0;
        for (let i = p + el.length + elSize.length; i < elEnd; i++) scale = scale * 256 + buf[i];
      }
      if (el.id !== ID.Duration) kept.push(buf.subarray(p, elEnd));
      p = elEnd;
    }
    const value = new Uint8Array(8);
    new DataView(value.buffer).setFloat64(0, (durationMs * 1_000_000) / (scale || 1_000_000));
    const duration = concat(new Uint8Array([0x44, 0x89, 0x88]), value);
    const content = concat(...kept, duration);
    const info = concat(buf.subarray(pos, pos + child.length), size8(content.length), content);

    // A Segment of known size (not MediaRecorder's) grows by what the Info grew.
    const grown = info.length - (end - pos);
    const segmentSizeBytes = segmentSize.unknown ? buf.subarray(segmentSizeAt, segmentData) : size8(segmentSize.value + grown);
    const head = concat(buf.subarray(0, segmentIdAt + segment.length), segmentSizeBytes, buf.subarray(segmentData, pos), info);
    return { head, end };
  }
  return null;
}

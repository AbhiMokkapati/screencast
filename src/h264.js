/**
 * H.264 Annex B -> WebCodecs-friendly "AVCC" access units.
 *
 * ffmpeg writes an Annex B byte stream (start-code separated NAL units). Browsers' VideoDecoder
 * wants length-prefixed samples plus an avcC "description" (SPS/PPS). Safari only reliably accepts
 * that form, so the server converts here instead of making the client do it.
 *
 * Wire format of the binary WebSocket messages produced for video:
 *   [type:1][payload]   type 1 = avcC config, 2 = key frame, 3 = delta frame
 * (A JPEG frame starts with 0xFF, so the client can tell the two apart.)
 */

const MSG_CONFIG = 1;
const MSG_KEY    = 2;
const MSG_DELTA  = 3;

const NAL_SLICE = 1, NAL_IDR = 5, NAL_SEI = 6, NAL_SPS = 7, NAL_PPS = 8, NAL_AUD = 9;

/**
 * Splits an Annex B stream into NAL units (without start codes).
 * Returns push(chunk). Callbacks:
 *   onNal(Buffer)            — a NAL known to be complete (the next start code has been seen)
 *   onStart(header, second)  — a NAL has begun: its header byte and next byte are available. Fires as
 *                              early as possible, before the NAL is complete, so a picture boundary
 *                              can be decided without waiting a whole extra NAL.
 * For every NAL, onNal of the previous NAL fires before onStart of the next.
 */
function createNalSplitter(onNal, onStart = () => {}) {
  let buf = Buffer.alloc(0);
  let synced = false;       // buf begins with a start code
  let searchFrom = 0;       // where to look for the next start code (never rescan bytes already checked)
  let startFired = false;   // onStart already called for the NAL at the head of buf

  function findStart(from) {
    for (let i = from; i + 2 < buf.length; i++) {
      if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) return i;
    }
    return -1;
  }

  return function push(chunk) {
    buf = Buffer.concat([buf, chunk]);
    while (true) {
      if (!synced) {
        const i = findStart(0);
        if (i === -1) { buf = buf.subarray(Math.max(0, buf.length - 2)); return; } // keep a split start code
        buf = buf.subarray(i);
        synced = true;
        startFired = false;
        searchFrom = 3;
      }
      if (!startFired && buf.length >= 5) { startFired = true; onStart(buf[3], buf[4]); }
      const next = findStart(searchFrom);
      if (next === -1) { searchFrom = Math.max(3, buf.length - 2); return; }
      // trailing zero bytes before a start code belong to a 4-byte start code, not the NAL
      let end = next;
      while (end > 3 && buf[end - 1] === 0) end--;
      if (!startFired && end - 3 >= 1) { startFired = true; onStart(buf[3], end - 3 >= 2 ? buf[4] : 0); }
      if (end > 3) onNal(Buffer.from(buf.subarray(3, end)));
      buf = buf.subarray(next);
      startFired = false;
      searchFrom = 3;
    }
  };
}

function lengthPrefixed(nals) {
  const parts = [];
  for (const n of nals) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(n.length, 0);
    parts.push(len, n);
  }
  return Buffer.concat(parts);
}

/** avcC box payload (ISO 14496-15) for one SPS and one PPS. */
function buildAvcC(sps, pps) {
  const head = Buffer.from([1, sps[1], sps[2], sps[3], 0xff, 0xe1, sps.length >> 8, sps.length & 0xff]);
  const mid  = Buffer.from([1, pps.length >> 8, pps.length & 0xff]);
  return Buffer.concat([head, sps, mid, pps]);
}

/** RFC 6381 codec string from an SPS NAL, e.g. "avc1.640028". */
function codecString(sps) {
  return 'avc1.' + [sps[1], sps[2], sps[3]].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Parser: raw Annex B chunks in; callbacks out.
 *   onConfig(Buffer message)         — whenever the SPS/PPS first appear or change (message type 1)
 *   onFrame(Buffer message, isKey)   — one complete picture (message type 2 or 3)
 */
function createH264Parser({ onConfig, onFrame }) {
  let sps = null, pps = null;
  let au = [];          // NAL units of the picture being assembled
  let auHasVcl = false;
  let auKey = false;

  function flush() {
    if (auHasVcl) {
      const slices = au.filter((n) => { const t = n[0] & 31; return t !== NAL_SPS && t !== NAL_PPS && t !== NAL_AUD; });
      const payload = lengthPrefixed(slices);
      onFrame(Buffer.concat([Buffer.from([auKey ? MSG_KEY : MSG_DELTA]), payload]), auKey);
    }
    au = []; auHasVcl = false; auKey = false;
  }

  const split = createNalSplitter((nal) => {
    const type = nal[0] & 31;
    if (type === NAL_SPS || type === NAL_PPS) {
      const same = type === NAL_SPS ? sps && sps.equals(nal) : pps && pps.equals(nal);
      if (!same) {
        if (type === NAL_SPS) sps = nal; else pps = nal;
        if (sps && pps) onConfig(Buffer.concat([Buffer.from([MSG_CONFIG]), buildAvcC(sps, pps)]));
      }
    }
    au.push(nal);
    if (type === NAL_SLICE || type === NAL_IDR) { auHasVcl = true; if (type === NAL_IDR) auKey = true; }
  }, (header, second) => {
    // A picture ends when the next one's first NAL begins: a parameter set / SEI / AUD after slice
    // data, or a slice that starts at macroblock 0 (top bit of the byte after the NAL header).
    const type = header & 31;
    const isVcl = type === NAL_SLICE || type === NAL_IDR;
    if (auHasVcl && (type === NAL_SEI || type === NAL_SPS || type === NAL_PPS || type === NAL_AUD ||
                     (isVcl && (second & 0x80) !== 0))) flush();
  });

  return function push(chunk) { split(chunk); };
}

module.exports = {
  createH264Parser, createNalSplitter, buildAvcC, codecString, lengthPrefixed,
  MSG_CONFIG, MSG_KEY, MSG_DELTA,
};

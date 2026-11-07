// PeerJS creates the offer before call() returns. Reorder the generated SDP
// so the H.264 preference applies to the first negotiation, not just later ones.
function preferH264(sdp) {
  return sdp.split(/(?=^m=)/m).map(section => {
    if (!section.startsWith('m=video ')) return section;
    const lines = section.split('\r\n');
    const header = lines[0].split(' '), payloads = header.slice(3);
    const h264 = new Set([...section.matchAll(/^a=rtpmap:(\d+) H264\//gmi)].map(m => m[1]));
    if (!h264.size) return section;
    const rtx = new Map([...section.matchAll(/^a=fmtp:(\d+) .*?apt=(\d+)(?:[;\s]|$)/gm)].map(m => [m[1], m[2]]));
    const preferred = [];
    for (const id of payloads) if (h264.has(id)) {
      preferred.push(id);
      for (const other of payloads) if (rtx.get(other) === id) preferred.push(other);
    }
    lines[0] = [...header.slice(0, 3), ...preferred, ...payloads.filter(id => !preferred.includes(id))].join(' ');
    return lines.join('\r\n');
  }).join('');
}
module.exports = { preferH264 };

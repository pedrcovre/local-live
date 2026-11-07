const { test } = require('node:test');
const assert = require('node:assert/strict');
const { preferH264 } = require('../src/codecs.cjs');
test('H.264 entra primeiro na oferta preservando RTX, áudio e codecs alternativos', () => {
  const audio = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2\r\n';
  const video = 'm=video 9 UDP/TLS/RTP/SAVPF 96 97 98 99\r\na=rtpmap:96 VP8/90000\r\na=rtpmap:97 rtx/90000\r\na=fmtp:97 apt=96\r\na=rtpmap:98 H264/90000\r\na=rtpmap:99 rtx/90000\r\na=fmtp:99 apt=98\r\n';
  const output = preferH264(audio + video);
  assert.ok(output.startsWith(audio));
  assert.ok(output.includes('m=video 9 UDP/TLS/RTP/SAVPF 98 99 96 97\r\n'));
  assert.equal(output.split('\r\n').slice(4).join('\r\n'), (audio + video).split('\r\n').slice(4).join('\r\n'));
  assert.equal(preferH264(audio), audio);
});

// services/nmsMultitrack.js — node-media-server 4.x и несколько видеодорожек в одном эфире (Enhanced RTMP v2, OBS 31+ «Multitrack Video»).
// NMS таких пакетов не знает: им не ставится тип, и пакет с заголовком лишней дорожки считается заголовком ЗВУКА —
// подменяет настоящий, и ffmpeg, подключившийся чуть позже начала эфира, остаётся без звука.
// Здесь: пакеты дорожек 1..N распознаются, их заголовки хранятся и отдаются новым зрителям (ffmpeg) после основного.
// Пока несколько качеств выключены (старый ffmpeg, LIVE_MULTITRACK=0) — лишние дорожки просто не пересылаются:
// ffmpeg видит обычный эфир из основной дорожки. Подключать до require('node-media-server').
// Внутренности NMS не те (другая версия) — заплатка не ставится, install() вернёт false.

const PT_SEQ_START = 0;
const PT_CODED = 1;
const PT_CODED_X = 3;
const PT_MULTITRACK_VIDEO = 6;
const PT_MULTITRACK_AUDIO = 5;
const SOUND_EX_HEADER = 9;
const FRAME_KEY = 1;
// свои значения packet.flags (у NMS: 0 заголовок звука, 1 звук, 2 заголовок видео, 3 ключевой кадр, 4 кадр, 5 метаданные)
const FLAG_FORWARD = 6; // только переслать: не кэшировать и не считать заголовком
const FLAG_EXTRA_HEADER = 7; // заголовок дорожки 1..N

// тип пакета Enhanced RTMP: видео — флаги, номер дорожки и признак «лишней» (не основной) дорожки
function classifyVideo(data) {
  if (!data || data.length < 1 || !(data[0] & 0x80)) return null; // обычный (не Enhanced) пакет — NMS разобрал сам
  const frameType = (data[0] >> 4) & 0x07;
  let pt = data[0] & 0x0f;
  let track = 0;
  if (pt === PT_MULTITRACK_VIDEO) {
    if (data.length < 7) return { flags: FLAG_FORWARD, track: 0, extra: false };
    pt = data[1] & 0x0f;
    track = data[6];
  }
  let flags;
  if (pt === PT_SEQ_START) flags = track ? FLAG_EXTRA_HEADER : 2;
  else if (pt === PT_CODED || pt === PT_CODED_X) flags = frameType === FRAME_KEY && !track ? 3 : 4;
  else flags = FLAG_FORWARD;
  return { flags, track, extra: track > 0 };
}

function classifyAudio(data) {
  if (!data || data.length < 7 || data[0] >> 4 !== SOUND_EX_HEADER || (data[0] & 0x0f) !== PT_MULTITRACK_AUDIO) return null;
  const track = data[6];
  const pt = data[1] & 0x0f;
  if (!track) return { flags: pt === PT_SEQ_START ? 0 : 1, track, extra: false };
  return { flags: pt === PT_SEQ_START ? FLAG_EXTRA_HEADER : 1, track, extra: true };
}

let installed = false;

/** @param {{ keepExtraTracks: () => boolean }} opts */
function install({ keepExtraTracks }) {
  if (installed) return true;
  try {
    const mainPath = require.resolve('node-media-server');
    if (require.cache[mainPath]) throw new Error('node-media-server уже загружен — заплатку надо подключать раньше');
    const flvPath = require.resolve('node-media-server/src/protocol/flv.js');
    const bsPath = require.resolve('node-media-server/src/server/broadcast_server.js');
    const Flv = require(flvPath);
    const Rtmp = require('node-media-server/src/protocol/rtmp.js');
    const Orig = require(bsPath);

    const probe = new Orig('');
    for (const f of ['broadcastMessage', 'postPlay', '_finishPublish']) {
      if (typeof probe[f] !== 'function') throw new Error(`нет BroadcastServer.${f}`);
    }
    if (typeof Flv.parserTag !== 'function' || typeof Flv.createMessage !== 'function' || typeof Rtmp.createMessage !== 'function') {
      throw new Error('нет Flv.parserTag / createMessage');
    }

    const origParser = Flv.parserTag;
    Flv.parserTag = function parserTag(type, time, size, data) {
      const packet = origParser.call(this, type, time, size, data);
      const c = type === 9 ? classifyVideo(data) : type === 8 ? classifyAudio(data) : null;
      if (c) {
        // NMS сам разбирает одиночные hvc1/av01/vp09 (и ставит pts) — их не трогаем
        if (!(type === 9 && !c.extra && packet.flags !== 0 && (data[0] & 0x0f) !== PT_MULTITRACK_VIDEO)) packet.flags = c.flags;
        if (c.extra) packet.pwTrack = `${type}:${c.track}`;
      } else if (type === 9 && packet.flags === 0) {
        packet.flags = FLAG_FORWARD; // видео никогда не считаем заголовком звука
      }
      return packet;
    };

    class PatchedBroadcastServer extends Orig {
      constructor(streamPath) {
        super(streamPath);
        /** @type {Map<string, { flv: Buffer, rtmp: Buffer }>} заголовки дорожек 1..N (не больше 2×255) */
        this.pwExtraHeaders = new Map();

        const origBroadcast = this.broadcastMessage;
        this.broadcastMessage = (packet) => {
          if (packet.pwTrack) {
            if (!keepExtraTracks()) return;
            if (packet.flags === FLAG_EXTRA_HEADER) {
              this.pwExtraHeaders.set(packet.pwTrack, {
                flv: Buffer.from(Flv.createMessage(packet)),
                rtmp: Buffer.from(Rtmp.createMessage(packet)),
              });
            }
          }
          return origBroadcast(packet);
        };

        // заголовки дорожек 1..N — сразу после основного, до кэша кадров (иначе ffmpeg не поймёт их кадры)
        const origPostPlay = this.postPlay;
        this.postPlay = (session) => {
          if (!this.pwExtraHeaders.size) return origPostPlay(session);
          const own = Object.prototype.hasOwnProperty.call(session, 'sendBuffer');
          const send = session.sendBuffer;
          const headers = new Set([
            this.flvHeader, this.flvMetaData, this.flvAudioHeader, this.flvVideoHeader,
            this.rtmpMetaData, this.rtmpAudioHeader, this.rtmpVideoHeader,
          ]);
          let injected = false;
          const inject = () => {
            injected = true;
            for (const h of this.pwExtraHeaders.values()) send.call(session, session.protocol === 'flv' ? h.flv : h.rtmp);
          };
          session.sendBuffer = (buf) => {
            if (!injected && !headers.has(buf)) inject();
            return send.call(session, buf);
          };
          let err;
          try {
            err = origPostPlay(session);
            if (!err && !injected) inject();
          } finally {
            if (own) session.sendBuffer = send;
            else delete session.sendBuffer;
          }
          return err;
        };

        const origFinish = this._finishPublish;
        this._finishPublish = () => {
          this.pwExtraHeaders.clear();
          return origFinish();
        };
      }
    }

    require.cache[bsPath].exports = PatchedBroadcastServer;
    installed = true;
    return true;
  } catch (e) {
    console.warn('[rtmp] заплатка multitrack для node-media-server не поставлена:', e.message);
    return false;
  }
}

module.exports = { install, classifyVideo, classifyAudio };

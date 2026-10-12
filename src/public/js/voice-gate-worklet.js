// Шумовой гейт для микрофона (AudioWorklet — работает в аудиопотоке, не засыпает в фоновой вкладке).
// Сам подстраивается под микрофон: уровень шума = минимум громкости за последние 3 с
// (между слогами речь проседает до фона, поэтому минимум — это и есть шум). Гейт открывается,
// когда звук заметно громче шума. Закрытый гейт не глушит в ноль (−20 дБ), чтобы речь не «обрубалась».

const WINDOW_S = 3; // за сколько секунд ищем минимум (длинная гласная короче — гейт не закроется посреди слова)
const SUB_S = 0.05; // минимум считаем кусками по 50 мс
const FLOOR_BIAS = 2; // дБ: минимум чуть ниже среднего шума
const FLOOR_MIN = -85; // дБ: тише этого шум не считаем
const FLOOR_MAX = -40; // дБ: громче — это уже не фон
const OPEN_ABOVE = 10; // дБ над шумом — открываемся
const OPEN_MIN = -62; // дБ: совсем тихое не открывает гейт даже в тихой комнате
const HYSTERESIS = 4; // дБ: закрываемся чуть ниже порога открытия — без дребезга
const HOLD_S = 0.25; // держим открытым после последнего громкого кусочка (хвосты слов)
const CLOSED_GAIN = 0.1; // −20 дБ
const ATTACK_S = 0.004; // открытие почти мгновенное — не съедаем начало слова
const RELEASE_S = 0.12; // закрытие плавное

class PwVoiceGate extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ring = []; // минимумы 50-мс кусков за последние WINDOW_S
    this.subMin = Infinity;
    this.subLeft = SUB_S;
    this.floor = -60;
    this.open = false;
    this.holdLeft = 0;
    this.gain = CLOSED_GAIN;
    this.attack = Math.exp(-1 / (ATTACK_S * sampleRate));
    this.release = Math.exp(-1 / (RELEASE_S * sampleRate));
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input.length || !input[0]) return true;
    const ch = input[0];
    const n = ch.length;
    const blockS = n / sampleRate;

    let sum = 0;
    for (let i = 0; i < n; i++) sum += ch[i] * ch[i];
    const db = 10 * Math.log10(sum / n + 1e-12);

    // оценка шума: минимум по кускам за последние WINDOW_S
    if (db < this.subMin) this.subMin = db;
    this.subLeft -= blockS;
    if (this.subLeft <= 0) {
      this.ring.push(this.subMin);
      if (this.ring.length > Math.round(WINDOW_S / SUB_S)) this.ring.shift();
      this.subMin = Infinity;
      this.subLeft = SUB_S;
    }
    let min = this.subMin;
    for (let i = 0; i < this.ring.length; i++) if (this.ring[i] < min) min = this.ring[i];
    if (Number.isFinite(min)) this.floor = Math.min(FLOOR_MAX, Math.max(FLOOR_MIN, min + FLOOR_BIAS));

    const openAt = Math.max(this.floor + OPEN_ABOVE, OPEN_MIN);
    if (db > openAt || (this.open && db > openAt - HYSTERESIS)) {
      this.open = true;
      this.holdLeft = HOLD_S;
    } else if (this.holdLeft > 0) {
      this.holdLeft -= blockS;
    } else {
      this.open = false;
    }

    const target = this.open ? 1 : CLOSED_GAIN;
    const k = target > this.gain ? this.attack : this.release;
    let g = this.gain;
    for (let c = 0; c < output.length; c++) {
      const src = input[c] || ch;
      const dst = output[c];
      g = this.gain;
      for (let i = 0; i < n; i++) {
        g = target + (g - target) * k;
        dst[i] = src[i] * g;
      }
    }
    this.gain = g;
    return true;
  }
}

registerProcessor('pw-voice-gate', PwVoiceGate);

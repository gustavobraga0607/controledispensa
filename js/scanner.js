// Leitor de código de barras pela câmera.
// Usa o BarcodeDetector nativo (Android/Chrome) e, se não existir, a biblioteca ZXing (iPhone, desktop).

const FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf', 'qr_code'];

let zxingLoading = null;
function loadZxing() {
  if (window.ZXing) return Promise.resolve(window.ZXing);
  if (!zxingLoading) {
    zxingLoading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'vendor/zxing.min.js';
      s.onload = () => resolve(window.ZXing);
      s.onerror = () => reject(new Error('Não foi possível carregar o leitor de código de barras'));
      document.head.appendChild(s);
    });
  }
  return zxingLoading;
}

async function nativeDetector() {
  if (!('BarcodeDetector' in window)) return null;
  try {
    const supported = await window.BarcodeDetector.getSupportedFormats();
    const formats = FORMATS.filter((f) => supported.includes(f));
    if (!formats.length) return null;
    return new window.BarcodeDetector({ formats });
  } catch {
    return null;
  }
}

// Inicia a leitura contínua no <video>. `onCode(code)` é chamado a cada leitura.
// Leituras repetidas do mesmo código em sequência são ignoradas por `cooldownMs`.
export async function startScanner(video, onCode, { cooldownMs = 2500 } = {}) {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Câmera indisponível. Abra o app em HTTPS (ou localhost) e permita o acesso à câmera.');
  }
  let last = { code: null, at: 0 };
  let stopped = false;
  const emit = (code) => {
    const now = Date.now();
    if (code === last.code && now - last.at < cooldownMs) return;
    last = { code, at: now };
    onCode(code);
  };

  const constraints = { video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false };
  const detector = await nativeDetector();

  if (detector) {
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    video.srcObject = stream;
    video.setAttribute('playsinline', '');
    video.muted = true;
    await video.play();
    let busy = false;
    const timer = setInterval(async () => {
      if (stopped || busy || video.readyState < 2) return;
      busy = true;
      try {
        const codes = await detector.detect(video);
        if (codes.length) emit(codes[0].rawValue);
      } catch {
        /* quadro inválido, tenta o próximo */
      } finally {
        busy = false;
      }
    }, 200);
    return () => {
      stopped = true;
      clearInterval(timer);
      stream.getTracks().forEach((t) => t.stop());
      video.srcObject = null;
    };
  }

  const ZXing = await loadZxing();
  const hints = new Map();
  hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, [
    ZXing.BarcodeFormat.EAN_13,
    ZXing.BarcodeFormat.EAN_8,
    ZXing.BarcodeFormat.UPC_A,
    ZXing.BarcodeFormat.UPC_E,
    ZXing.BarcodeFormat.CODE_128,
    ZXing.BarcodeFormat.CODE_39,
    ZXing.BarcodeFormat.ITF,
    ZXing.BarcodeFormat.QR_CODE,
  ]);
  const reader = new ZXing.BrowserMultiFormatReader(hints, 300);
  video.setAttribute('playsinline', '');
  video.muted = true;
  await reader.decodeFromConstraints(constraints, video, (result) => {
    if (result && !stopped) emit(result.getText());
  });
  return () => {
    stopped = true;
    reader.reset();
  };
}

// Feedback de "bip" + vibração.
let audioCtx = null;
export function beep(ok = true) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'square';
    osc.frequency.value = ok ? 1650 : 300;
    gain.gain.value = 0.08;
    osc.connect(gain).connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + (ok ? 0.09 : 0.3));
  } catch {
    /* sem áudio */
  }
  if (navigator.vibrate) navigator.vibrate(ok ? 60 : [80, 60, 80]);
}

// Modern-TTS to Five9 prompt audio. Five9 WAV prompts must be G.711 u-law,
// 8kHz, mono; this module synthesizes speech and returns a base64 WAV ready
// for managePromptWav. Zero dependencies: u-law encoding, resampling, and the
// WAV container are done by hand.
//
// Default provider is Cloudflare Workers AI (Deepgram Aura-2 via the [ai]
// binding): no external TTS account or API key, and Aura speaks telephony
// u-law 8kHz natively. ElevenLabs/OpenAI remain as optional BYO-key paths.

export class TtsError extends Error {}

const PROVIDERS = {
  'workers-ai': {
    defaultVoice: 'luna', // Aura-2 speakers: luna, asteria, orion, athena, zeus, ...
    defaultModel: '@cf/deepgram/aura-2-en',
  },
  elevenlabs: {
    defaultVoice: '21m00Tcm4TlvDq8ikWAM', // "Rachel", a public premade voice
    defaultModel: 'eleven_turbo_v2_5',
  },
  openai: {
    defaultVoice: 'nova',
    defaultModel: 'gpt-4o-mini-tts',
  },
};

// G.711 u-law encode one 16-bit PCM sample.
function linearToUlaw(sample) {
  const BIAS = 0x84, CLIP = 32635;
  let sign = (sample >> 8) & 0x80;
  if (sign) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; exponent--, mask >>= 1);
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

// 24kHz s16le mono -> 8kHz u-law: average each 3-sample window (cheap low-pass)
// then encode. Telephony bandwidth hides the difference from a proper filter.
export function pcm24kToUlaw8k(pcmBytes) {
  const view = new DataView(pcmBytes.buffer, pcmBytes.byteOffset, pcmBytes.byteLength);
  const sampleCount = Math.floor(pcmBytes.byteLength / 2);
  const outCount = Math.floor(sampleCount / 3);
  const out = new Uint8Array(outCount);
  for (let i = 0; i < outCount; i++) {
    const base = i * 3;
    const avg = (view.getInt16(base * 2, true) + view.getInt16((base + 1) * 2, true) + view.getInt16((base + 2) * 2, true)) / 3;
    out[i] = linearToUlaw(avg | 0);
  }
  return out;
}

// Wrap raw u-law bytes in a WAV container (format tag 7, 8kHz, mono, 8-bit).
export function ulawToWav(ulawBytes) {
  const dataLen = ulawBytes.length;
  const buf = new ArrayBuffer(58 + dataLen);
  const v = new DataView(buf);
  const bytes = new Uint8Array(buf);
  let o = 0;
  const str = (s) => { for (const c of s) bytes[o++] = c.charCodeAt(0); };
  const u32 = (n) => { v.setUint32(o, n, true); o += 4; };
  const u16 = (n) => { v.setUint16(o, n, true); o += 2; };
  str('RIFF'); u32(50 + dataLen); str('WAVE');
  str('fmt '); u32(18);
  u16(7);      // WAVE_FORMAT_MULAW
  u16(1);      // mono
  u32(8000);   // sample rate
  u32(8000);   // byte rate
  u16(1);      // block align
  u16(8);      // bits per sample
  u16(0);      // cbSize
  str('fact'); u32(4); u32(dataLen);
  str('data'); u32(dataLen);
  bytes.set(ulawBytes, o);
  return bytes;
}

export function bytesToBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

async function ttsWorkersAi({ ai, text, voice, model }) {
  // Aura-2 emits headerless u-law at 8kHz when asked; the binding returns a
  // ReadableStream (or a byte buffer on some runtimes) of raw audio.
  const out = await ai.run(model, { text, speaker: voice, encoding: 'mulaw', sample_rate: 8000, container: 'none' });
  const bytes = out instanceof ReadableStream
    ? new Uint8Array(await new Response(out).arrayBuffer())
    : new Uint8Array(out instanceof ArrayBuffer ? out : (out?.buffer instanceof ArrayBuffer ? out.buffer : []));
  if (!bytes.length) throw new TtsError('Workers AI returned no audio.');
  return bytes;
}

async function ttsElevenLabs({ apiKey, text, voice, model }) {
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=ulaw_8000`, {
    method: 'POST',
    headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, model_id: model }),
  });
  if (!res.ok) throw new TtsError(`ElevenLabs HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return new Uint8Array(await res.arrayBuffer()); // raw headerless u-law 8k
}

async function ttsOpenAi({ apiKey, text, voice, model }) {
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, voice, input: text, response_format: 'pcm' }),
  });
  if (!res.ok) throw new TtsError(`OpenAI HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return pcm24kToUlaw8k(new Uint8Array(await res.arrayBuffer())); // pcm is 24kHz s16le mono
}

// Main entry: text -> base64 Five9-ready WAV.
export async function synthesizeUlawWav({ provider, apiKey, ai, text, voice, model }) {
  const p = PROVIDERS[provider];
  if (!p) throw new TtsError(`Unknown TTS provider "${provider}" (use workers-ai, elevenlabs, or openai).`);
  if (provider === 'workers-ai' && !ai) {
    throw new TtsError('The Workers AI binding is not available on this server. Redeploy with the [ai] binding in wrangler.toml (npx wrangler deploy), or pass provider elevenlabs/openai with an API key.');
  }
  if (provider !== 'workers-ai' && !apiKey) {
    throw new TtsError(`No API key configured for ${provider}. Set the ${provider === 'elevenlabs' ? 'ELEVENLABS_API_KEY' : 'OPENAI_API_KEY'} secret on this Worker (or .dev.vars locally), or use the default workers-ai provider.`);
  }
  if (!text || !String(text).trim()) throw new TtsError('text is required.');
  const args = { apiKey, ai, text: String(text), voice: voice || p.defaultVoice, model: model || p.defaultModel };
  const ulaw = provider === 'workers-ai' ? await ttsWorkersAi(args)
    : provider === 'elevenlabs' ? await ttsElevenLabs(args)
    : await ttsOpenAi(args);
  if (!ulaw.length) throw new TtsError(`${provider} returned empty audio.`);
  const wav = ulawToWav(ulaw);
  return { wavBase64: bytesToBase64(wav), bytes: wav.length, approxSeconds: Math.round(ulaw.length / 800) / 10 };
}

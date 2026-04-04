import fs from 'node:fs';
import path from 'node:path';

export function isElevenLabsConfigured(apiKey: string, voiceId: string) {
  return Boolean(apiKey && voiceId);
}

export async function synthesizeHeadingAudio({
  apiKey,
  voiceId,
  headingPrefix,
  summary,
  docId
}: {
  apiKey: string;
  voiceId: string;
  headingPrefix: string;
  summary: string;
  docId: string;
}) {
  if (!isElevenLabsConfigured(apiKey, voiceId)) {
    return null;
  }

  const audioDir = path.resolve(process.cwd(), '.data', 'audio');
  fs.mkdirSync(audioDir, { recursive: true });

  const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: 'POST',
    headers: {
      Accept: 'audio/mpeg',
      'Content-Type': 'application/json',
      'xi-api-key': apiKey
    },
    body: JSON.stringify({
      text: `${headingPrefix} ${summary}`.trim(),
      model_id: 'eleven_turbo_v2_5',
      voice_settings: {
        stability: 0.45,
        similarity_boost: 0.75
      }
    })
  });

  if (!response.ok) {
    throw new Error(`ElevenLabs request failed with ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const filename = `${docId}.mp3`;
  fs.writeFileSync(path.join(audioDir, filename), buffer);
  return `/audio/${filename}`;
}

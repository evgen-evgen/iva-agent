// Deepgram: транскрипция голоса/видео (nova-3, language=multi). Пара с vision.ts —
// вторая половина «понять присланный файл», которую канал приносит в inbound-пайплайн.
// Тело запроса — сырые байты, ответ → results.channels[0].alternatives[0].transcript.
function deepgramContentType(mediaType?: string): string {
  const bare = mediaType?.split(";", 1)[0]?.trim().toLowerCase();
  return bare && /^(?:audio|video)\/[a-z0-9.+-]+$/u.test(bare)
    ? bare
    : "application/octet-stream";
}

export async function transcribe(
  audio: ArrayBuffer,
  mediaType?: string,
): Promise<string> {
  const language = process.env.DEEPGRAM_LANGUAGE || "multi";
  const url =
    `https://api.deepgram.com/v1/listen?model=nova-3&language=${language}` +
    `&punctuate=true&smart_format=true`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Token ${process.env.DEEPGRAM_API_KEY ?? ""}`,
      "Content-Type": deepgramContentType(mediaType),
    },
    body: audio,
  });
  if (!res.ok) {
    const detail = (await res.text()).replace(/\s+/gu, " ").slice(0, 300);
    throw new Error(
      `Deepgram HTTP ${res.status}${detail ? `: ${detail}` : ""}`,
    );
  }
  const json = (await res.json()) as {
    results?: {
      channels?: Array<{ alternatives?: Array<{ transcript?: string }> }>;
    };
  };
  return json.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "";
}

const WHATSAPP_MAX_MESSAGE_LENGTH = 65_536;
const WHATSAPP_CHAT_BUBBLE_MAX_CHARS = 400;

function stripMarkdownForWhatsApp(text: string): string {
  const codeFence = "`".repeat(3);
  let result = text.trim();

  result = result.replace(
    new RegExp(`${codeFence}[\\w]*\\n?([\\s\\S]*?)${codeFence}`, "g"),
    (_, code: string) => code.trim()
  );
  result = result.replace(/`([^`]+)`/g, "$1");
  result = result.replace(/^\s{0,3}#{1,6}\s+/gm, "");
  result = result.replace(/\*\*([^*]+)\*\*/g, "*$1*");
  result = result.replace(/_([^_]+)_/g, "_$1_");

  return result.trim();
}

export function prepareWhatsAppReply(text: string): string {
  return stripMarkdownForWhatsApp(text);
}

export function splitWhatsAppMessage(text: string): string[] {
  if (text.length <= WHATSAPP_CHAT_BUBBLE_MAX_CHARS) {
    return splitWhatsAppLongMessage(text);
  }

  const paragraphs = text
    .split(/\n\n+/)
    .map((part) => part.trim())
    .filter(Boolean);

  const merged: string[] = [];
  let current = "";

  for (const paragraph of paragraphs) {
    if (paragraph.length > WHATSAPP_CHAT_BUBBLE_MAX_CHARS) {
      if (current) {
        merged.push(current);
        current = "";
      }

      merged.push(
        ...splitLongParagraph(paragraph, WHATSAPP_CHAT_BUBBLE_MAX_CHARS)
      );
      continue;
    }

    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;

    if (candidate.length <= WHATSAPP_CHAT_BUBBLE_MAX_CHARS) {
      current = candidate;
      continue;
    }

    if (current) {
      merged.push(current);
    }

    current = paragraph;
  }

  if (current) {
    merged.push(current);
  }

  return merged.flatMap((bubble) => splitWhatsAppLongMessage(bubble));
}

function splitLongParagraph(paragraph: string, maxChars: number): string[] {
  const chunks: string[] = [];
  let remaining = paragraph;

  while (remaining.length > maxChars) {
    let splitAt = remaining.lastIndexOf(" ", maxChars);

    if (splitAt <= 0) {
      splitAt = maxChars;
    }

    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}

function splitWhatsAppLongMessage(text: string): string[] {
  if (text.length <= WHATSAPP_MAX_MESSAGE_LENGTH) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > WHATSAPP_MAX_MESSAGE_LENGTH) {
    let splitAt = remaining.lastIndexOf("\n", WHATSAPP_MAX_MESSAGE_LENGTH);

    if (splitAt <= 0) {
      splitAt = WHATSAPP_MAX_MESSAGE_LENGTH;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}
